//! Launching games.
//!
//! Steam games launch by `steam://rungameid/<appid>`, which keeps the overlay,
//! cloud saves and anti-cheat happy but leaves the process with Steam. On
//! Windows we poll Steam's running appid in the registry to know when the
//! session ends; macOS and Linux have no such signal. Manual games are spawned
//! directly, so we own the child.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::library::Game;
use crate::{log_if_err, log_info, log_warn};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Launch {
    /// A URI for the platform's handler to resolve.
    Uri(String),
    /// An executable we spawn and own.
    Process {
        program: PathBuf,
        args: Vec<String>,
        cwd: Option<PathBuf>,
    },
}

/// Work out how a game should start, without starting it, so it can be tested.
pub fn plan(game: &Game) -> Result<Launch, String> {
    match game.provider.as_str() {
        "steam" => {
            if game.provider_id.is_empty() || !game.provider_id.chars().all(|c| c.is_ascii_digit())
            {
                return Err(format!("not a valid Steam appid: {:?}", game.provider_id));
            }
            // rungameid rather than launch/<id>: it offers to install an owned
            // game that is not installed, rather than failing.
            Ok(Launch::Uri(format!(
                "steam://rungameid/{}",
                game.provider_id
            )))
        }
        "manual" => {
            let path = game
                .install_dir
                .clone()
                .ok_or("this game has no executable set yet")?;
            if !path.exists() {
                return Err(format!("executable is missing: {}", path.display()));
            }
            let cwd = path.parent().map(PathBuf::from);
            Ok(Launch::Process {
                program: path,
                args: Vec::new(),
                cwd,
            })
        }
        other => Err(format!("do not know how to launch a {other} game")),
    }
}

/// Hand a URI to the platform.
pub fn open_uri(uri: &str) -> Result<(), String> {
    // Only steam:// is ever built here, so a future provider cannot pass
    // through a string read from disk.
    if !uri.starts_with("steam://") {
        return Err(format!("refusing to open an unexpected URI scheme: {uri}"));
    }

    // Allowlist the characters as a second lock behind `plan`. Opening via
    // `cmd /C start` let shell metacharacters escape Rust's quoting (BatBadBut,
    // CVE-2024-24576); ShellExecuteW avoids that, but the next opener may not.
    if let Some(bad) = uri
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || "/:._-".contains(*c)))
    {
        return Err(format!("refusing a URI containing {bad:?}: {uri}"));
    }

    #[cfg(target_os = "windows")]
    {
        shell_execute(uri)
    }

    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let mut cmd = {
            let mut c = Command::new("open");
            c.arg(uri);
            c
        };

        #[cfg(target_os = "linux")]
        let mut cmd = {
            let mut c = Command::new("xdg-open");
            c.arg(uri);
            c
        };

        cmd.spawn()
            .map_err(|e| format!("could not open {uri}: {e}"))?;
        Ok(())
    }
}

/// Open a URI with its registered handler.
///
/// Not `cmd /C start`: that flashes a console window and re-parses the command
/// line, which is the injection risk `open_uri` guards against.
#[cfg(target_os = "windows")]
fn shell_execute(uri: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;

    /// `SW_SHOWNORMAL`.
    const SHOW_NORMAL: i32 = 1;
    /// Return values at or below this are `SE_ERR_*` codes, not handles.
    const LARGEST_ERROR: isize = 32;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let verb = wide("open");
    let file = wide(uri);

    // SAFETY: both strings are NUL-terminated and outlive the call; the null
    // parameters are the documented "none" for window, arguments and folder.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SHOW_NORMAL,
        )
    };
    if result as isize <= LARGEST_ERROR {
        return Err(format!(
            "could not open {uri}: ShellExecuteW returned {} ({})",
            result as isize,
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// A spawned game that fails to start (missing DLL, bad working directory)
/// exits well within this.
const STARTUP_GRACE: std::time::Duration = std::time::Duration::from_millis(900);

/// Best-effort wait for a cold Steam; firing the URI early is not fatal.
const STEAM_WAIT: std::time::Duration = std::time::Duration::from_secs(20);
const STEAM_POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// Steam silently drops a `steam://` URI that arrives in the first seconds
/// after its process appears, so the first Play did nothing.
const STEAM_SETTLE: std::time::Duration = std::time::Duration::from_secs(4);
/// A second attempt, for when the first still landed too early.
const STEAM_RETRY: std::time::Duration = std::time::Duration::from_secs(8);

#[cfg(target_os = "windows")]
const STEAM_SESSION_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// How long a handed-off appid may take to show as running before we stop
/// tracking it. Generous because giving up leaves Marquee minimised, and
/// pre-launch updates or redistributable installs can take many minutes.
#[cfg(target_os = "windows")]
const STEAM_SESSION_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Start Steam silently if needed, so a URI does not also open its library
/// window over the launcher. Returns true if Steam had to be started. Blocks.
fn ensure_steam_ready() -> bool {
    use crate::library::steam::Steam;

    if Steam::is_running() {
        return false;
    }
    log_info!("run", "Steam is not running; starting it silently");
    if let Err(e) = Steam::start_silently() {
        // Not fatal: the URI still works, just with Steam's window.
        log_warn!("run", "{e}; letting the URI start Steam instead");
        return true;
    }

    let deadline = std::time::Instant::now() + STEAM_WAIT;
    while std::time::Instant::now() < deadline {
        if Steam::is_running() {
            // The process is up but the client is not ready for URIs yet.
            log_info!("run", "Steam is up; giving it a moment to accept requests");
            std::thread::sleep(STEAM_SETTLE);
            return true;
        }
        std::thread::sleep(STEAM_POLL);
    }
    log_warn!(
        "run",
        "Steam did not come up in time; handing it the game anyway"
    );
    true
}

/// Wait for `appid` to start and then stop being Steam's running game, then
/// call `on_exit`. The poller and timings are parameters so tests need no Steam.
#[cfg(any(target_os = "windows", test))]
fn watch_steam_session(
    appid: u32,
    title: &str,
    on_exit: impl FnOnce(),
    poll: std::time::Duration,
    start_timeout: std::time::Duration,
    mut running_app_id: impl FnMut() -> Option<u32>,
) {
    let start_deadline = std::time::Instant::now() + start_timeout;
    let mut last_seen = running_app_id();
    while last_seen != Some(appid) {
        if std::time::Instant::now() >= start_deadline {
            // Log the last value read: a wrong registry key (#94) looked
            // identical to a slow game when only the give-up was logged.
            log_warn!(
                "run",
                "{title} never showed up as Steam's running game (last read {last_seen:?}, wanted {appid}); not tracking its session"
            );
            return;
        }
        std::thread::sleep(poll);
        last_seen = running_app_id();
    }
    log_info!(
        "run",
        "Steam reports {title} running; waiting for it to end"
    );
    while running_app_id() == Some(appid) {
        std::thread::sleep(poll);
    }
    log_info!("run", "{title} session ended");
    on_exit();
}

pub fn start(
    game: &Game,
    on_failure: impl FnOnce(String) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<Launch, String> {
    let plan = plan(game)?;
    match &plan {
        Launch::Uri(uri) => {
            let uri = uri.clone();
            let title = game.title.clone();
            // Only Steam games plan as a Uri, so this is a Steam appid.
            let appid: u32 = game.provider_id.parse().unwrap_or(0);
            // Off the interface's thread: a cold Steam takes seconds.
            std::thread::spawn(move || {
                let was_cold = ensure_steam_ready();
                log_info!("run", "launching {title} via {uri}");
                if let Err(e) = open_uri(&uri) {
                    on_failure(e);
                    return;
                }

                // After a cold start, ask again in case Steam dropped the first
                // request. A duplicate only brings the running game forward.
                if was_cold {
                    std::thread::sleep(STEAM_RETRY);
                    log_info!(
                        "run",
                        "asking Steam for {title} again, in case the first was early"
                    );
                    // The first request was already accepted.
                    log_if_err!("run", open_uri(&uri), "second request for {title}");
                }

                // Steam owns the process, so watch its running appid instead
                // of waiting on a child (#90).
                #[cfg(target_os = "windows")]
                watch_steam_session(
                    appid,
                    &title,
                    on_exit,
                    STEAM_SESSION_POLL,
                    STEAM_SESSION_START_TIMEOUT,
                    crate::library::steam::Steam::running_app_id,
                );
                #[cfg(not(target_os = "windows"))]
                {
                    // No live session signal on macOS or Linux.
                    let _ = (appid, on_exit);
                }
            });
        }
        Launch::Process { program, args, cwd } => {
            log_info!("run", "spawning {}", program.display());
            let mut cmd = Command::new(program);
            cmd.args(args);
            if let Some(dir) = cwd {
                cmd.current_dir(dir);
            }
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("could not start {}: {e}", program.display()))?;

            // spawn() succeeds for a game that dies at once (missing runtime,
            // wrong working directory), so check again after a grace period.
            let title = game.title.clone();
            std::thread::spawn(move || {
                std::thread::sleep(STARTUP_GRACE);
                match child.try_wait() {
                    Ok(Some(status)) if !status.success() => {
                        let detail = match status.code() {
                            Some(code) => format!("exited immediately with code {code}"),
                            None => "was terminated immediately".to_string(),
                        };
                        log_warn!("run", "{title} {detail}");
                        on_failure(detail);
                    }
                    Ok(Some(_)) => {
                        // Likely a launcher stub handing off to a store
                        // client: not a failure, and no session we own.
                        log_info!(
                            "run",
                            "{title} exited immediately, cleanly -- probably a launcher stub"
                        );
                        return;
                    }
                    _ => log_info!("run", "{title} is running"),
                }

                // Wait for the real exit so the window comes back (#63). The
                // exit status is ignored: a crash still ends the session.
                let _ = child.wait();
                log_info!("run", "{title} session ended");
                on_exit();
            });
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards against shell injection through a URI (CVE-2024-24576).
    #[test]
    fn a_uri_carrying_a_shell_metacharacter_is_refused() {
        for evil in [
            "steam://rungameid/1 & calc.exe",
            "steam://rungameid/1|calc",
            "steam://rungameid/1\"&calc&\"",
            "steam://rungameid/1^&calc",
            "steam://rungameid/1<nul",
            "steam://rungameid/1>out",
            "steam://rungameid/1%calc%",
            "steam://rungameid/1;calc",
            "steam://rungameid/1$(calc)",
            "steam://rungameid/1`calc`",
            "steam://rungameid/1\ncalc",
        ] {
            assert!(open_uri(evil).is_err(), "accepted {evil:?}");
        }
    }

    /// Checked against `plan` rather than a literal so the two cannot drift.
    #[test]
    fn the_uris_we_actually_build_pass_the_guard() {
        let Launch::Uri(uri) = plan(&steam_game("1091500")).unwrap() else {
            panic!("a steam game plans as a URI");
        };
        assert!(
            uri.chars()
                .all(|c| c.is_ascii_alphanumeric() || "/:._-".contains(c)),
            "{uri} would be refused by open_uri"
        );
    }

    fn steam_game(appid: &str) -> Game {
        Game {
            id: format!("steam:{appid}"),
            provider: "steam".into(),
            provider_id: appid.into(),
            title: "Test".into(),
            installed: true,
            update_available: false,
            updating: false,
            install_dir: None,
            size_bytes: 0,
            last_played: None,
            playtime_minutes: 0,
            favourite: false,
            hidden: false,
            art_app_id: None,
        }
    }

    #[test]
    fn steam_games_launch_by_uri() {
        assert_eq!(
            plan(&steam_game("1091500")).unwrap(),
            Launch::Uri("steam://rungameid/1091500".into())
        );
    }

    /// The appid comes from a file on disk.
    #[test]
    fn a_malformed_appid_is_refused() {
        for bad in ["", "12; rm -rf /", "../../etc", "abc", "12 34"] {
            assert!(plan(&steam_game(bad)).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_process_that_dies_immediately_is_reported() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut g = steam_game("1");
        g.provider = "manual".into();
        g.install_dir = Some(PathBuf::from(if cfg!(windows) {
            "C:\\Windows\\System32\\cmd.exe"
        } else {
            "/usr/bin/false"
        }));
        if !g.install_dir.as_ref().unwrap().exists() {
            return; // no such binary on this machine; nothing to assert
        }
        // cmd.exe without arguments does not exit, so assert on Unix only.
        if cfg!(windows) {
            return;
        }
        start(
            &g,
            move |detail| {
                let _ = tx.send(detail);
            },
            || {},
        )
        .unwrap();
        let reported = rx.recv_timeout(std::time::Duration::from_secs(4));
        assert!(reported.is_ok(), "a failed launch should be reported");
        assert!(reported.unwrap().contains("code 1"));
    }

    /// A launcher stub exits cleanly at once; it is neither a failure nor a
    /// session ending.
    #[test]
    fn a_clean_immediate_exit_is_not_a_failure() {
        if cfg!(windows) || !std::path::Path::new("/usr/bin/true").exists() {
            return;
        }
        let (fail_tx, fail_rx) = std::sync::mpsc::channel();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();
        let mut g = steam_game("1");
        g.provider = "manual".into();
        g.install_dir = Some(PathBuf::from("/usr/bin/true"));
        start(
            &g,
            move |detail| {
                let _ = fail_tx.send(detail);
            },
            move || {
                let _ = exit_tx.send(());
            },
        )
        .unwrap();
        assert!(
            fail_rx
                .recv_timeout(std::time::Duration::from_secs(3))
                .is_err(),
            "a clean exit must not be reported as a failure"
        );
        assert!(
            exit_rx.try_recv().is_err(),
            "a launcher stub is not a session we own the end of"
        );
    }

    /// Regression for #63, where Marquee stayed minimised after the game quit.
    /// `#[cfg(unix)]` rather than a runtime check: `PermissionsExt` does not
    /// compile on Windows.
    #[cfg(unix)]
    #[test]
    fn a_process_that_outlives_the_grace_period_reports_its_end() {
        use std::os::unix::fs::PermissionsExt;

        let script = std::env::temp_dir().join(format!(
            "marquee-test-session-{}-{}.sh",
            std::process::id(),
            std::thread::current().name().unwrap_or("t")
        ));
        std::fs::write(&script, "#!/bin/sh\nsleep 1\n").expect("write test script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("chmod test script");

        let (fail_tx, fail_rx) = std::sync::mpsc::channel();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();
        let mut g = steam_game("1");
        g.provider = "manual".into();
        g.install_dir = Some(script.clone());

        start(
            &g,
            move |detail| {
                let _ = fail_tx.send(detail);
            },
            move || {
                let _ = exit_tx.send(());
            },
        )
        .unwrap();

        // Generous: macOS malware-scans a new script on first run, and four
        // seconds was not enough on a busy CI runner.
        let ended = exit_rx.recv_timeout(std::time::Duration::from_secs(30));
        let _ = std::fs::remove_file(&script);
        assert!(
            ended.is_ok(),
            "a session that ends on its own must be reported"
        );
        assert!(
            fail_rx.try_recv().is_err(),
            "a clean session is not a failure"
        );
    }

    #[test]
    fn open_uri_refuses_a_foreign_scheme() {
        for other in [
            "file:///etc/passwd",
            "https://example.com",
            "javascript:alert(1)",
            "ms-settings:",
            "",
        ] {
            assert!(open_uri(other).is_err(), "accepted {other:?}");
        }
    }

    #[test]
    fn a_manual_game_without_an_executable_says_so() {
        let mut g = steam_game("1");
        g.provider = "manual".into();
        let err = plan(&g).unwrap_err();
        assert!(err.contains("no executable"), "{err}");
    }

    /// For example, Steam showed an install prompt instead of launching.
    #[test]
    fn a_steam_session_that_never_starts_does_not_call_on_exit() {
        let (tx, rx) = std::sync::mpsc::channel();
        watch_steam_session(
            1234,
            "Test",
            move || {
                let _ = tx.send(());
            },
            std::time::Duration::from_millis(5),
            std::time::Duration::from_millis(30),
            || None,
        );
        assert!(
            rx.try_recv().is_err(),
            "on_exit must not fire for a session Steam never reported starting"
        );
    }

    /// Regression for #90: nothing restored the window after a Steam game.
    #[test]
    fn a_steam_session_that_starts_and_ends_calls_on_exit() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        let appid = 1234;
        // 0 stands for "not running", matching what `running_app_id` reports.
        let state = Arc::new(AtomicU32::new(0));
        let poll_state = state.clone();
        let (tx, rx) = std::sync::mpsc::channel();

        let flipper = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(15));
            state.store(appid, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(30));
            state.store(0, Ordering::SeqCst);
        });

        watch_steam_session(
            appid,
            "Test",
            move || {
                let _ = tx.send(());
            },
            std::time::Duration::from_millis(5),
            std::time::Duration::from_secs(2),
            move || match poll_state.load(Ordering::SeqCst) {
                0 => None,
                id => Some(id),
            },
        );

        flipper.join().unwrap();
        assert!(
            rx.recv_timeout(std::time::Duration::from_secs(1)).is_ok(),
            "on_exit should fire once Steam stops reporting the session running"
        );
    }
}
