//! Start Marquee when Windows starts.
//!
//! Uses the `HKEY_CURRENT_USER\...\Run` key: no elevation and no `.lnk` to keep
//! in sync. State is read back from the registry rather than stored, so the
//! toggle matches Windows even if the entry is removed from Task Manager.

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

/// Quoted, because Windows splits an unquoted `Run` value at the space in
/// `Program Files`.
#[cfg(target_os = "windows")]
fn run_value(exe: &std::path::Path) -> String {
    format!("\"{}\"", exe.display())
}

/// Add or remove the startup entry.
#[cfg(target_os = "windows")]
pub fn set_enabled(on: bool) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    // `create_subkey`, not `open_subkey`: a fresh account has no `Run` key.
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(RUN_KEY)
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
            // Already off, perhaps removed outside Marquee.
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

    #[cfg(target_os = "windows")]
    #[test]
    fn the_run_value_is_quoted() {
        let exe = std::path::Path::new("C:\\Program Files\\Marquee\\marquee.exe");
        assert_eq!(
            run_value(exe),
            "\"C:\\Program Files\\Marquee\\marquee.exe\""
        );
    }

    /// Uses the real `Run` key under the current user.
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
