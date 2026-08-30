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
//! immediately and the game belongs to Steam. That would normally make session
//! timing impossible -- except that Steam writes playtime into
//! `localconfig.vdf` itself, which is where the library already reads it from.
//! So a rescan after playing picks up the real figure, from Steam's own
//! records, with no process watching at all.
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
fn ensure_steam_ready() {
    use crate::library::steam::Steam;

    if Steam::is_running() {
        return;
    }
    log_info!("run", "Steam is not running; starting it silently");
    if let Err(e) = Steam::start_silently() {
        // Not fatal. The URI still works, it just brings the window with it,
        // which is the behaviour this exists to improve rather than to require.
        log_warn!("run", "{e}; falling back to letting the URI start Steam");
        return;
    }

    let deadline = std::time::Instant::now() + STEAM_WAIT;
    while std::time::Instant::now() < deadline {
        if Steam::is_running() {
            log_info!("run", "Steam is ready");
            return;
        }
        std::thread::sleep(STEAM_POLL);
    }
    log_warn!(
        "run",
        "Steam did not come up in time; handing it the game anyway"
    );
}

pub fn start(
    game: &Game,
    on_failure: impl FnOnce(String) + Send + 'static,
) -> Result<Launch, String> {
    let plan = plan(game)?;
    match &plan {
        Launch::Uri(uri) => {
            let uri = uri.clone();
            let title = game.title.clone();
            // Off the interface's thread: waiting for a cold Steam takes
            // seconds, and the grid must stay responsive while it happens.
            std::thread::spawn(move || {
                ensure_steam_ready();
                log_info!("run", "launching {title} via {uri}");
                if let Err(e) = open_uri(&uri) {
                    on_failure(e);
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
                        // is not treated as a failure.
                        log_info!(
                            "run",
                            "{title} exited immediately, cleanly -- probably a launcher stub"
                        );
                    }
                    _ => log_info!("run", "{title} is running"),
                }
            });
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        start(&g, move |detail| {
            let _ = tx.send(detail);
        })
        .unwrap();
        let reported = rx.recv_timeout(std::time::Duration::from_secs(4));
        assert!(reported.is_ok(), "a failed launch should be reported");
        assert!(reported.unwrap().contains("code 1"));
    }

    /// A launcher stub that hands off to a store client exits cleanly and at
    /// once, and must not be reported as a failure.
    #[test]
    fn a_clean_immediate_exit_is_not_a_failure() {
        if cfg!(windows) || !std::path::Path::new("/usr/bin/true").exists() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let mut g = steam_game("1");
        g.provider = "manual".into();
        g.install_dir = Some(PathBuf::from("/usr/bin/true"));
        start(&g, move |detail| {
            let _ = tx.send(detail);
        })
        .unwrap();
        assert!(
            rx.recv_timeout(std::time::Duration::from_secs(3)).is_err(),
            "a clean exit must not be reported as a failure"
        );
    }

    #[test]
    fn open_uri_refuses_a_foreign_scheme() {
        assert!(open_uri("file:///etc/passwd").is_err());
        assert!(open_uri("https://example.com").is_err());
    }

    #[test]
    fn a_manual_game_without_an_executable_says_so() {
        let mut g = steam_game("1");
        g.provider = "manual".into();
        let err = plan(&g).unwrap_err();
        assert!(err.contains("no executable"), "{err}");
    }
}
