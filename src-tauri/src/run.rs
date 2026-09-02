//! Launching games.
//!
//! Two paths, matching the two providers in docs/PLAN.md §5.
//!
//! **Steam** launches by URI: `steam://rungameid/<appid>`. One line, no DRM to
//! fight, it survives Steam updating, and it keeps the overlay and cloud saves
//! working. It also avoids anti-cheat systems that object to a game started
//! from an unexpected parent process.
//!
//! The cost is that we do not own the child: the URI handler returns
//! immediately and the game belongs to Steam. Playtime is unaffected by that
//! -- Steam writes it into `localconfig.vdf` itself, which is where the
//! library already reads it from, so a rescan after playing picks up the
//! real figure with no process watching at all.
//!
//! Restoring the window Marquee minimised for the game is a different
//! problem, and playtime's own answer does not solve it: nothing reads
//! `localconfig.vdf` until the *next* scan, which can be minutes away. On
//! Windows, Steam also keeps the running appid live in the registry -- the
//! same key `Steam::is_running` already reads -- updated the instant a game
//! starts or stops, so `start` polls that to know when a hand-off session
//! ends. macOS and Linux have no equivalent live signal, so a Steam launch
//! there still leaves Marquee minimised until the user switches back by hand.
//! Before this, *no* Steam launch on any platform brought the window back --
//! only a manually-added game did, because the first attempt at this (#63)
//! only ever watched a child process we owned (#90).
//!
//! **Manual** games spawn directly, so we own the child and can time the
//! session exactly.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::library::Game;
use crate::{log_info, log_warn};

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

/// Work out how a game should start, without starting it.
///
/// Separated from the doing so it can be tested without launching anything on
/// the machine running the tests.
pub fn plan(game: &Game) -> Result<Launch, String> {
    match game.provider.as_str() {
        "steam" => {
            if game.provider_id.is_empty() || !game.provider_id.chars().all(|c| c.is_ascii_digit())
            {
                return Err(format!("not a valid Steam appid: {:?}", game.provider_id));
            }
            // rungameid, not launch/<id>: it is the form Steam itself uses from
            // the library, and it handles a game that is owned but not yet
            // installed by offering to install it rather than failing.
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
    // Guard the shape as well as the content. Everything we generate is a
    // steam:// URI built from digits we validated; refusing anything else
    // means a future provider cannot accidentally pass through a string that
    // came from a file on disk.
    if !uri.starts_with("steam://") {
        return Err(format!("refusing to open an unexpected URI scheme: {uri}"));
    }

    // And guard the characters, because of how Windows opens a URI.
    //
    // There is no Win32 call here that takes a URI directly without pulling in
    // another dependency, so this goes through `cmd /C start` -- and cmd.exe
    // re-parses its own command line after Rust has quoted it. Rust's quoting
    // is built for CreateProcess, not for cmd, so a `&`, `|`, `^`, `<`, `>` or
    // `"` inside an argument can escape it and be run as a command. That is
    // the BatBadBut class of bug (CVE-2024-24576).
    //
    // Nothing reaches here with such a character today: the appid is checked
    // for digits in `plan`. This is the second lock, for the caller who adds a
    // provider later and builds a URI out of a name read off the disk. A
    // legitimate steam:// URI is only ever letters, digits and a little
    // punctuation, so nothing is lost by insisting.
    // An allowlist rather than a list of dangerous characters: every steam://
    // URI this app builds is letters, digits, slashes and dots, so anything
    // else is a bug worth refusing rather than a case worth supporting.
    if let Some(bad) = uri
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || "/:._-".contains(*c)))
    {
        return Err(format!("refusing a URI containing {bad:?}: {uri}"));
    }

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(uri);
        c
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        // `cmd /C start` needs an empty title argument or it treats the URI as
        // the window title and does nothing at all.
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", uri]);
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

/// How long to watch a spawned game before deciding it started successfully.
///
/// A missing DLL, a bad working directory or an unsupported binary exits within
/// a few hundred milliseconds. A game that is still alive after this is one the
/// user is about to see.
const STARTUP_GRACE: std::time::Duration = std::time::Duration::from_millis(900);

/// How long to wait for a cold Steam to become ready before handing it the URI.
///
/// Steam takes several seconds from launch to accepting `steam://`. Giving up
/// early and firing anyway is not a failure -- Steam queues the request -- so
/// this is a best effort, not a gate.
const STEAM_WAIT: std::time::Duration = std::time::Duration::from_secs(20);
const STEAM_POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// Make sure Steam is up, without showing its window.
///
/// Handing `steam://` to the system with Steam closed makes Steam start *and*
/// open its library window in front of everything -- on a television, the
/// launcher vanishing behind a storefront. Starting it silently first means the
/// window never appears and the game comes up over Marquee, which is what
/// pressing Play should look like.
///
/// Blocking, so it runs on the launch thread rather than the interface's.
/// Steam accepts `steam://` some seconds after its process appears.
///
/// The process existing is not the same as the client being ready, and firing
/// the URI in that window gets it silently swallowed -- press Play, Steam
/// starts, nothing happens, press Play again and the game runs. That is exactly
/// what was reported.
const STEAM_SETTLE: std::time::Duration = std::time::Duration::from_secs(4);
/// A second attempt, for when the first still landed too early.
const STEAM_RETRY: std::time::Duration = std::time::Duration::from_secs(8);

/// How often to poll Steam's reported running appid while tracking a
/// hand-off session. Only used on Windows -- see `watch_steam_session`.
#[cfg(target_os = "windows")]
const STEAM_SESSION_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// How long to wait for Steam to report the launched appid as running before
/// giving up on tracking that session. Covers an appid that was handed off
/// but never actually starts -- Steam offering to install it instead, say --
/// so this thread does not sit polling forever for a session that was never
/// going to happen.
#[cfg(target_os = "windows")]
const STEAM_SESSION_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Make sure Steam is up, without showing its window.
///
/// Returns true when Steam had to be started, because that is the case where
/// the launch needs to be more careful about timing.
fn ensure_steam_ready() -> bool {
    use crate::library::steam::Steam;

    if Steam::is_running() {
        return false;
    }
    log_info!("run", "Steam is not running; starting it silently");
    if let Err(e) = Steam::start_silently() {
        // Not fatal. The URI still works, it just brings Steam's window with
        // it, which is the behaviour this exists to improve rather than require.
        log_warn!("run", "{e}; letting the URI start Steam instead");
        return true;
    }

    let deadline = std::time::Instant::now() + STEAM_WAIT;
    while std::time::Instant::now() < deadline {
        if Steam::is_running() {
            // The process is up; the client is not ready yet. Waiting here is
            // the difference between one press working and needing two.
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

/// Wait for `appid` to become Steam's reported running game, then wait for it
/// to stop being that, and call `on_exit` when it does.
///
/// `running_app_id` is injected -- and the poll interval and start timeout
/// passed in rather than read from the module consts -- so the waiting and
/// give-up logic can be tested without a real Steam client or registry to
/// poll and without a real test taking minutes. See the tests below.
///
/// Only called from the Windows arm below -- gated the same way here so a
/// non-Windows build does not warn this dead rather than merely unused there,
/// while `cfg(test)` keeps it compiled everywhere the tests below need it.
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
    while running_app_id() != Some(appid) {
        if std::time::Instant::now() >= start_deadline {
            log_info!(
                "run",
                "{title} never showed up as Steam's running game; not tracking its session"
            );
            return;
        }
        std::thread::sleep(poll);
    }
    log_info!("run", "Steam reports {title} running; waiting for it to end");
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
            // `plan` only ever builds a Uri launch for the "steam" provider,
            // so provider_id is a Steam appid here.
            let appid: u32 = game.provider_id.parse().unwrap_or(0);
            // Off the interface's thread: waiting for a cold Steam takes
            // seconds, and the grid must stay responsive while it happens.
            std::thread::spawn(move || {
                let was_cold = ensure_steam_ready();
                log_info!("run", "launching {title} via {uri}");
                if let Err(e) = open_uri(&uri) {
                    on_failure(e);
                    return;
                }

                // Ask once more after a cold start. Steam swallows a request
                // that arrives before it is ready, and there is no signal for
                // "ready" short of asking -- so ask twice. A duplicate is
                // harmless: Steam brings an already-running game to the front
                // rather than starting a second copy.
                if was_cold {
                    std::thread::sleep(STEAM_RETRY);
                    log_info!(
                        "run",
                        "asking Steam for {title} again, in case the first was early"
                    );
                    let _ = open_uri(&uri);
                }

                // Steam owns the game from here, so there is no child to
                // `wait()` on the way the manual arm below does. On Windows it
                // keeps the running appid live in the registry instead, which
                // is enough to know when the session it was handed off to
                // ends -- see the module doc and #90, where the first attempt
                // at this (#63) watched only owned processes and so never
                // brought Marquee back for a Steam launch at all.
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
                    // No equivalent live signal on macOS or Linux -- see the
                    // module doc.
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

            // A process that spawns and then dies immediately is the common
            // failure -- a missing runtime, a wrong working directory -- and
            // spawn() reports none of it, so the launch looks successful and
            // nothing happens. Watched off-thread so the interface never waits.
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
                        // Exited cleanly and at once. A launcher stub handing
                        // off to a store client looks exactly like this, so it
                        // is not treated as a failure -- and there is no real
                        // session here to report the end of, since whatever
                        // this handed off to is not a process we own.
                        log_info!(
                            "run",
                            "{title} exited immediately, cleanly -- probably a launcher stub"
                        );
                        return;
                    }
                    _ => log_info!("run", "{title} is running"),
                }

                // Still alive past the grace period: this is a real, owned
                // session, and Marquee minimised the window for it. Waiting
                // here for the real exit -- not just the startup check above
                // -- is what makes "quit to desktop" bring Marquee back
                // instead of leaving it minimised until the next Alt-Tab (#63).
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

    /// Opening a URI on Windows goes through `cmd /C start`, and cmd.exe
    /// re-parses the command line after Rust has quoted it for CreateProcess.
    /// A shell metacharacter that survives that is a command, not an argument
    /// (CVE-2024-24576). Nothing builds such a URI today; this is the lock for
    /// the caller who adds a provider later and builds one from a name read
    /// off the disk.
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

    /// The guard has to let the real thing through, or it is just a bug.
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

    /// An appid comes from a file on disk. Anything that is not digits must not
    /// reach a URI we hand to the shell.
    #[test]
    fn a_malformed_appid_is_refused() {
        for bad in ["", "12; rm -rf /", "../../etc", "abc", "12 34"] {
            assert!(plan(&steam_game(bad)).is_err(), "{bad:?} should be refused");
        }
    }

    /// A game that spawns and dies at once is the common manual-launch
    /// failure, and spawn() reports none of it. `false` exits non-zero
    /// immediately, which is exactly that shape.
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
        // cmd.exe without arguments does not exit, so only the unix shape is
        // asserted -- the mechanism is identical either way.
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

    /// A launcher stub that hands off to a store client exits cleanly and at
    /// once, and must not be reported as a failure. Nor is it a session
    /// ending, since whatever it handed off to is not a process we own.
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

    /// A process that survives the startup grace period and then exits on its
    /// own is a real session ending -- "quit to desktop" -- and the caller
    /// must be told, because the window that was minimised for the game needs
    /// to come back. Before this, `start` stopped watching once the grace
    /// period's single `try_wait` came back empty, so nothing ever fired and
    /// Marquee stayed minimised after the game closed (#63).
    ///
    /// `#[cfg(unix)]` on the test rather than a `cfg!(windows)` early return
    /// inside it. The early return is a runtime check and the body still has
    /// to compile: `PermissionsExt` and `Permissions::from_mode` do not exist
    /// on Windows at all, so the test did not skip there, it failed the build
    /// with "cannot find `unix` in `os`". This is the shape CLAUDE.md warns
    /// about -- clean on the development machine, red only in CI.
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

        let ended = exit_rx.recv_timeout(std::time::Duration::from_secs(4));
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

    /// An appid that never shows up as Steam's running game -- a hand-off
    /// that Steam turned into an install prompt rather than a launch, say --
    /// must give up rather than call `on_exit`. Before `watch_steam_session`
    /// existed, a Steam launch never called `on_exit` at all (#90): this
    /// covers the half of its logic that deliberately still does not, so
    /// that half cannot regress into firing on every launch regardless of
    /// whether Steam ever reported one running.
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

    /// The other half: once Steam reports the appid running and then stops
    /// reporting it, that is a real session ending, and `on_exit` must fire
    /// -- this is what brings Marquee's window back for a Steam launch, which
    /// nothing did before this (#90).
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
