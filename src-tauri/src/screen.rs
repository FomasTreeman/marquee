//! Keeping the screen awake while the window is focused.
//!
//! The OS does not count gamepad input as activity, so browsing with a pad
//! would otherwise trigger the screensaver.

use std::process::Child;
use std::sync::Mutex;

use crate::{log_info, log_warn};

/// The process holding the inhibit on macOS and Linux. Unused on Windows.
static KEEP_AWAKE: Mutex<Option<Child>> = Mutex::new(None);

/// Ask the system not to blank the screen, or release that request.
/// Idempotent: repeated calls do not stack.
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

    if held.is_some() {
        return;
    }

    // Windows uses a thread-state flag, so there is no child to store.
    #[cfg(target_os = "windows")]
    {
        windows_keep_awake(true);
        log_info!("screen", "holding the display awake");
    }

    // `caffeinate` and `systemd-inhibit` are the supported interfaces and
    // need no extra dependency.
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

    #[cfg(not(target_os = "windows"))]
    match spawned {
        Ok(child) => {
            *held = Some(child);
            log_info!("screen", "holding the display awake");
        }
        Err(e) => log_warn!("screen", "cannot keep the display awake: {e}"),
    }
}

#[cfg(target_os = "windows")]
fn windows_keep_awake(on: bool) {
    // Thread state: set and cleared from the same thread (the event loop).
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    // SAFETY: takes a plain flag value and touches no memory of ours.
    // Returns zero on failure, which is logged below.
    let previous = unsafe {
        windows_sys::Win32::System::Power::SetThreadExecutionState(if on {
            ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        })
    };
    if previous == 0 {
        log_warn!("screen", "the system refused the display-awake request");
    }
}

/// Release on exit, or `caffeinate` can outlive us and hold the display awake.
pub fn release_on_exit() {
    keep_awake(false);
}
