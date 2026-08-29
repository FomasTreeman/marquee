//! Fullscreen, and keeping the screen awake.
//!
//! Both exist for the same reason: a controller is not an input device as far
//! as the operating system is concerned. Browsing a library for ten minutes
//! with a pad looks exactly like ten minutes of inactivity, so the screensaver
//! arrives in the middle of active use. Nothing else in this app can fix that.
//!
//! Held only while the window is focused. A launcher minimised behind a game
//! has no business keeping a display awake -- the game will do that itself if
//! it needs to, and if nothing is running the screen should be allowed to
//! sleep.

use std::process::Child;
use std::sync::Mutex;

use crate::{log_info, log_warn};

/// The child process holding the inhibit, on platforms where that is how it is
/// done. Windows uses an API call instead and stores nothing.
static KEEP_AWAKE: Mutex<Option<Child>> = Mutex::new(None);

/// Ask the system not to blank the screen.
///
/// Idempotent: calling it twice does not stack, and a failure is logged once
/// rather than repeatedly -- a machine where this does not work should not
/// produce a line per focus event.
pub fn keep_awake(on: bool) {
    let mut held = match KEEP_AWAKE.lock() {
        Ok(h) => h,
        Err(e) => e.into_inner(),
    };

    if !on {
        if let Some(mut child) = held.take() {
            let _ = child.kill();
            let _ = child.wait();
            log_info!("screen", "screen may sleep again");
        }
        #[cfg(target_os = "windows")]
        windows_keep_awake(false);
        return;
    }

    #[cfg(target_os = "windows")]
    {
        if held.is_none() {
            windows_keep_awake(true);
            // Nothing to store: the Windows flag is thread state, not a child.
            log_info!("screen", "holding the display awake");
        }
        return;
    }

    #[cfg(not(target_os = "windows"))]
    {
        if held.is_some() {
            return;
        }

        // A child process rather than a library binding. `caffeinate` and
        // `systemd-inhibit` are the supported interfaces on their platforms,
        // they die with us if we crash, and neither adds a dependency that has
        // to compile on all three targets.
        #[cfg(target_os = "macos")]
        let spawned = std::process::Command::new("caffeinate").arg("-d").spawn();

        #[cfg(target_os = "linux")]
        let spawned = std::process::Command::new("systemd-inhibit")
            .args([
                "--what=idle",
                "--who=Marquee",
                "--why=Browsing the library with a controller",
                "--mode=block",
                "sleep",
                "infinity",
            ])
            .spawn();

        match spawned {
            Ok(child) => {
                *held = Some(child);
                log_info!("screen", "holding the display awake");
            }
            Err(e) => log_warn!("screen", "cannot keep the display awake: {e}"),
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_keep_awake(on: bool) {
    // ES_CONTINUOUS with ES_DISPLAY_REQUIRED holds until cleared; ES_CONTINUOUS
    // alone releases it. This is thread state, so it must be set from the same
    // thread that clears it -- both calls come from the event loop.
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    unsafe {
        windows_sys::Win32::System::Power::SetThreadExecutionState(if on {
            ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        });
    }
}

/// Release on the way out.
///
/// `caffeinate` would otherwise outlive a hard shutdown and hold the display
/// awake with nothing on screen.
pub fn release_on_exit() {
    keep_awake(false);
}
