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
use crate::log_info;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Launch {
    /// A URI for the platform's handler to resolve.
    Uri(String),
    /// An executable we spawn and own.
    Process { program: PathBuf, args: Vec<String>, cwd: Option<PathBuf> },
}

/// Work out how a game should start, without starting it.
///
/// Separated from the doing so it can be tested without launching anything on
/// the machine running the tests.
pub fn plan(game: &Game) -> Result<Launch, String> {
    match game.provider.as_str() {
        "steam" => {
            if game.provider_id.is_empty() || !game.provider_id.chars().all(|c| c.is_ascii_digit()) {
                return Err(format!("not a valid Steam appid: {:?}", game.provider_id));
            }
            // rungameid, not launch/<id>: it is the form Steam itself uses from
            // the library, and it handles a game that is owned but not yet
            // installed by offering to install it rather than failing.
            Ok(Launch::Uri(format!("steam://rungameid/{}", game.provider_id)))
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
            Ok(Launch::Process { program: path, args: Vec::new(), cwd })
        }
        other => Err(format!("do not know how to launch a {other} game")),
    }
}

/// Hand a URI to the platform.
fn open_uri(uri: &str) -> Result<(), String> {
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

    cmd.spawn().map_err(|e| format!("could not open {uri}: {e}"))?;
    Ok(())
}

pub fn start(game: &Game) -> Result<Launch, String> {
    let plan = plan(game)?;
    match &plan {
        Launch::Uri(uri) => {
            log_info!("run", "launching {} via {}", game.title, uri);
            open_uri(uri)?;
        }
        Launch::Process { program, args, cwd } => {
            log_info!("run", "spawning {}", program.display());
            let mut cmd = Command::new(program);
            cmd.args(args);
            if let Some(dir) = cwd {
                cmd.current_dir(dir);
            }
            cmd.spawn().map_err(|e| format!("could not start {}: {e}", program.display()))?;
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
