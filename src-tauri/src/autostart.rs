//! Start Marquee when Windows starts.
//!
//! A launcher that lives on a television is meant to be the first thing on
//! screen after the machine boots, the same way a console's home screen is.
//! Getting there without a keyboard means Marquee has to put itself in the
//! `Run` key itself -- there is no first-run wizard to click through on a
//! couch.
//!
//! The `HKEY_CURRENT_USER\...\Run` key was chosen over a Startup-folder
//! shortcut or a Scheduled Task because it needs no elevation and no `.lnk`
//! file to keep in sync with the install path -- one string value, read back
//! by Explorer on every login. `library/steam.rs` already reads this hive for
//! Steam's own state, so nothing new is asked of the user's registry
//! permissions.
//!
//! State lives only in the registry, not in the settings database: reading it
//! back live means the toggle can never drift from what Windows will actually
//! do, including if someone removes the entry from Task Manager's Startup tab
//! without touching Marquee at all.

#[cfg(target_os = "windows")]
use crate::{log_info, log_warn};

#[cfg(target_os = "windows")]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(target_os = "windows")]
const VALUE_NAME: &str = "Marquee";

/// Whether Marquee is currently registered to start with Windows.
#[cfg(target_os = "windows")]
pub fn is_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .and_then(|k| k.get_value::<String, _>(VALUE_NAME))
        .is_ok()
}

/// Quoted, because an install under `Program Files` contains a space and an
/// unquoted `Run` value is split on the first one -- Windows would try to run
/// `C:\Program` and pass `Files\Marquee\marquee.exe` as an argument to it.
#[cfg(target_os = "windows")]
fn run_value(exe: &std::path::Path) -> String {
    format!("\"{}\"", exe.display())
}

/// Add or remove the startup entry.
#[cfg(target_os = "windows")]
pub fn set_enabled(on: bool) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
        .map_err(|e| format!("could not open the Windows startup key: {e}"))?;

    if on {
        let exe = std::env::current_exe()
            .map_err(|e| format!("could not find this program's own path: {e}"))?;
        let value = run_value(&exe);
        key.set_value(VALUE_NAME, &value)
            .map_err(|e| format!("could not write the startup entry: {e}"))?;
        log_info!("autostart", "registered to start with Windows: {value}");
    } else {
        match key.delete_value(VALUE_NAME) {
            Ok(()) => log_info!("autostart", "removed from Windows startup"),
            // Already off. Not an error -- the interface calls this from a
            // toggle it may already believe is off after an external change.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                log_warn!("autostart", "could not remove the startup entry: {e}");
                return Err(format!("could not remove the startup entry: {e}"));
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn is_enabled() -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub fn set_enabled(_on: bool) -> Result<(), String> {
    Err("starting at login is only supported on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Program Files has a space in it on every default Windows install, so
    /// this is the common case, not an edge one -- an unquoted value here
    /// silently truncates the command Windows runs at every login.
    #[cfg(target_os = "windows")]
    #[test]
    fn the_run_value_is_quoted() {
        let exe = std::path::Path::new("C:\\Program Files\\Marquee\\marquee.exe");
        assert_eq!(
            run_value(exe),
            "\"C:\\Program Files\\Marquee\\marquee.exe\""
        );
    }

    /// Writes and then removes a real value under the current user's `Run`
    /// key -- the same key `is_enabled` reads -- so this proves the round
    /// trip actually works rather than trusting the two functions to agree
    /// with each other in the abstract.
    #[cfg(target_os = "windows")]
    #[test]
    fn enabling_then_disabling_leaves_no_trace() {
        assert!(!is_enabled(), "test machine should start with this off");
        set_enabled(true).expect("registry write should succeed");
        assert!(is_enabled());
        set_enabled(false).expect("registry delete should succeed");
        assert!(!is_enabled());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn autostart_is_unsupported_away_from_windows() {
        assert!(!is_enabled());
        assert!(set_enabled(true).is_err());
    }
}
