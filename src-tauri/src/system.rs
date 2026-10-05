//! Quit, minimise, restart and shut down for the main menu, so a TV setup can
//! be left without a keyboard. The interface asks for confirmation; here the
//! action names are a closed set and anything else is refused.

use std::process::Command;

use crate::{log_info, log_warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Minimise,
    Quit,
    Restart,
    ShutDown,
}

impl Action {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "minimise" | "minimize" => Action::Minimise,
            "quit" => Action::Quit,
            "restart" => Action::Restart,
            "shutdown" => Action::ShutDown,
            _ => return None,
        })
    }

    /// Restart and shut down end the whole session, so the interface confirms them.
    pub fn affects_the_machine(self) -> bool {
        matches!(self, Action::Restart | Action::ShutDown)
    }
}

/// The command for a machine action, separate from `run` so tests can inspect it.
pub fn command_for(action: Action) -> Option<(&'static str, Vec<&'static str>)> {
    match action {
        Action::Minimise | Action::Quit => None,

        #[cfg(target_os = "macos")]
        Action::ShutDown => Some((
            "osascript",
            vec!["-e", "tell application \"System Events\" to shut down"],
        )),
        #[cfg(target_os = "macos")]
        Action::Restart => Some((
            "osascript",
            vec!["-e", "tell application \"System Events\" to restart"],
        )),

        #[cfg(target_os = "windows")]
        Action::ShutDown => Some(("shutdown", vec!["/s", "/t", "0"])),
        #[cfg(target_os = "windows")]
        Action::Restart => Some(("shutdown", vec!["/r", "/t", "0"])),

        // systemctl goes through logind, which works without root; `poweroff` does not.
        #[cfg(target_os = "linux")]
        Action::ShutDown => Some(("systemctl", vec!["poweroff"])),
        #[cfg(target_os = "linux")]
        Action::Restart => Some(("systemctl", vec!["reboot"])),
    }
}

pub fn run(action: Action) -> Result<(), String> {
    let Some((program, args)) = command_for(action) else {
        return Ok(()); // handled by the window, not the shell
    };
    log_info!("system", "{action:?}");
    match Command::new(program).args(&args).spawn() {
        Ok(_) => Ok(()),
        Err(e) => {
            log_warn!("system", "{action:?} failed: {e}");
            Err(format!("could not {action:?}: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_actions_parse() {
        assert_eq!(Action::parse("quit"), Some(Action::Quit));
        assert_eq!(Action::parse("minimize"), Some(Action::Minimise));
        assert_eq!(Action::parse("minimise"), Some(Action::Minimise));
        for bad in [
            "",
            "rm -rf /",
            "shutdown; rm",
            "SHUTDOWN",
            "poweroff",
            "../x",
        ] {
            assert_eq!(Action::parse(bad), None, "{bad:?} should be refused");
        }
    }

    #[test]
    fn the_machine_actions_are_the_ones_that_need_confirming() {
        assert!(Action::ShutDown.affects_the_machine());
        assert!(Action::Restart.affects_the_machine());
        assert!(!Action::Quit.affects_the_machine());
        assert!(!Action::Minimise.affects_the_machine());
    }

    #[test]
    fn window_actions_spawn_nothing() {
        assert!(command_for(Action::Quit).is_none());
        assert!(command_for(Action::Minimise).is_none());
    }

    #[test]
    fn machine_actions_have_a_command_on_this_platform() {
        for action in [Action::ShutDown, Action::Restart] {
            let (program, args) = command_for(action).expect("a command");
            assert!(!program.is_empty());
            assert!(
                !program.contains(' '),
                "{program} looks like a shell string"
            );
            assert!(!args.is_empty());
        }
    }
}
