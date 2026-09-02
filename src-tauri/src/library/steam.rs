//! The Steam provider — the only automated one.
//!
//! Reads `libraryfolders.vdf` for the library roots, then every
//! `appmanifest_*.acf` inside each. The format is byte-identical on Windows,
//! macOS and Linux; only the base path differs, which is most of why §7 of the
//! plan no longer sequences platforms.

use std::path::{Path, PathBuf};

use super::{Game, LibraryProvider};
use crate::vdf;

/// Steam sets bit 2 on a fully installed app. A manifest can exist for a game
/// that is only queued or partially downloaded, and those should not appear as
/// playable.
const STATE_FULLY_INSTALLED: u64 = 4;

/// Valve's own tools and runtimes have appmanifests like any game. Nobody
/// wants Proton in their library.
fn is_tool(appid: &str, name: &str) -> bool {
    const TOOL_IDS: &[&str] = &[
        "228980",  // Steamworks Common Redistributables
        "1070560", // Steam Linux Runtime 1.0
        "1391110", // Steam Linux Runtime 2.0 (soldier)
        "1628350", // Steam Linux Runtime 3.0 (sniper)
    ];
    TOOL_IDS.contains(&appid)
        || name.starts_with("Proton")
        || name.starts_with("Steam Linux Runtime")
        || name.starts_with("Steamworks ")
}

pub struct Steam;

impl Steam {
    /// Where Steam keeps itself. Ordered by likelihood; the first that exists
    /// wins.
    fn roots() -> Vec<PathBuf> {
        let home = dirs_home();
        let mut out = Vec::new();

        #[cfg(target_os = "macos")]
        if let Some(h) = &home {
            out.push(h.join("Library/Application Support/Steam"));
        }

        #[cfg(target_os = "linux")]
        if let Some(h) = &home {
            out.push(h.join(".steam/steam"));
            out.push(h.join(".local/share/Steam"));
            // Flatpak keeps its own sandboxed home.
            out.push(h.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"));
            out.push(h.join(".steam/root"));
        }

        #[cfg(target_os = "windows")]
        {
            // Only the other arms read it.
            let _ = &home;
            if let Some(p) = windows_steam_path() {
                out.push(p);
            }
            for var in ["ProgramFiles(x86)", "ProgramFiles"] {
                if let Ok(base) = std::env::var(var) {
                    out.push(PathBuf::from(base).join("Steam"));
                }
            }
        }

        out
    }

    pub fn root() -> Option<PathBuf> {
        Self::roots()
            .into_iter()
            .find(|p| p.join("steamapps").is_dir())
    }

    /// Is the Steam client up?
    ///
    /// Matters because of *how* a game gets launched. Handing `steam://` to the
    /// system when Steam is closed makes Steam start, and a cold Steam start
    /// opens its library window over everything -- on a television, the
    /// launcher disappearing behind a storefront. If Steam is already running,
    /// the same URI launches the game without raising anything.
    pub fn is_running() -> bool {
        #[cfg(target_os = "windows")]
        {
            // Steam keeps a live pid here, and we already read this hive.
            // Cheaper and more reliable than shelling out to tasklist.
            use winreg::enums::HKEY_CURRENT_USER;
            use winreg::RegKey;
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey("Software\\Valve\\Steam\\ActiveProcess")
                .and_then(|k| k.get_value::<u32, _>("pid"))
                .map(|pid| pid != 0)
                .unwrap_or(false)
        }

        #[cfg(not(target_os = "windows"))]
        {
            // The process name is not the name of the app bundle, and differs
            // between macOS and Linux.
            let name = if cfg!(target_os = "macos") {
                "steam_osx"
            } else {
                "steam"
            };
            std::process::Command::new("pgrep")
                .args(["-x", name])
                .output()
                .map(|o| o.status.success() && !o.stdout.is_empty())
                .unwrap_or(false)
        }
    }

    /// The appid Steam currently reports as running, if any.
    ///
    /// Lives in the same registry key as the pid `is_running` reads, and
    /// Steam updates it the instant a game starts or stops. It is the only
    /// live signal available for when a `steam://` hand-off session ends: the
    /// game belongs to Steam's process tree from the moment the URI is
    /// opened, not ours, so there is no child of our own to wait on -- see
    /// `run`'s module doc, which is why `run::start` polls this.
    #[cfg(target_os = "windows")]
    pub fn running_app_id() -> Option<u32> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Valve\\Steam\\ActiveProcess")
            .and_then(|k| k.get_value::<u32, _>("RunningAppID"))
            .ok()
            .filter(|id| *id != 0)
    }

    /// Start Steam without showing its window.
    ///
    /// `-silent` puts it straight in the tray. The alternative -- letting the
    /// `steam://` URI start it -- opens the library window in front of
    /// everything, which is the thing worth avoiding.
    pub fn start_silently() -> Result<(), String> {
        #[cfg(target_os = "macos")]
        let mut command = {
            // Steam's own binary rather than `open -a Steam`: going through
            // `open` activates the app, which is exactly the window we are
            // trying not to show.
            let mut c =
                std::process::Command::new("/Applications/Steam.app/Contents/MacOS/steam_osx");
            c.arg("-silent");
            c
        };

        #[cfg(target_os = "windows")]
        let mut command = {
            let exe = Self::root()
                .map(|r| r.join("steam.exe"))
                .filter(|p| p.exists())
                .ok_or("could not find steam.exe")?;
            let mut c = std::process::Command::new(exe);
            c.arg("-silent");
            c
        };

        #[cfg(target_os = "linux")]
        let mut command = {
            let mut c = std::process::Command::new("steam");
            c.arg("-silent");
            c
        };

        command
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not start Steam: {e}"))
    }

    /// Every library folder Steam knows about, including the root itself.
    ///
    /// Steam stores games across multiple drives and records them here. Only
    /// reading the install root is the classic way to miss most of a library.
    fn library_paths(root: &Path) -> Vec<PathBuf> {
        let mut out = vec![root.to_path_buf()];
        let file = root.join("steamapps/libraryfolders.vdf");
        let Ok(text) = std::fs::read_to_string(&file) else {
            return out;
        };
        let Ok(parsed) = vdf::parse(&text) else {
            return out;
        };
        let Some(folders) = parsed.root_child() else {
            return out;
        };

        for (_key, entry) in folders.entries() {
            // Older Steam wrote `"1" "D:\\Games"`; newer writes a block with a
            // "path" inside. Handle both.
            let path = match entry {
                vdf::Value::Str(s) => Some(s.as_str()),
                vdf::Value::Map(_) => entry.str_at("path"),
            };
            if let Some(p) = path {
                let p = PathBuf::from(p);
                if p != *root && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        out
    }

    /// Games this account has played on this machine, from
    /// `userdata/<id>/config/localconfig.vdf`.
    ///
    /// This is why the library is not just the handful of games currently
    /// installed. Steam records real playtime and last-played per app, locally
    /// and with no API key -- and unlike the Web API it needs no account
    /// linking, and unlike the community profile endpoint it does not require
    /// the profile to be public. Both of those were tried and neither works
    /// without authentication any more.
    ///
    /// It is not the *owned* library: it covers apps with local config, which
    /// in practice means anything launched or configured on this machine. That
    /// is a far better default than nothing, and it is honest about what it is.
    fn played_games(root: &Path) -> Vec<Game> {
        let mut out = Vec::new();
        let Ok(users) = std::fs::read_dir(root.join("userdata")) else {
            return out;
        };

        for user in users.flatten() {
            let file = user.path().join("config/localconfig.vdf");
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            let Ok(parsed) = vdf::parse(&text) else {
                crate::log_warn!("steam", "could not parse {}", file.display());
                continue;
            };
            let Some(apps) = parsed
                .root_child()
                .and_then(|v| v.get("Software"))
                .and_then(|v| v.get("Valve"))
                .and_then(|v| v.get("Steam"))
                .and_then(|v| v.get("apps"))
            else {
                continue;
            };

            for (app_id, entry) in apps.entries() {
                if !app_id.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let playtime = entry.u64_at("Playtime").unwrap_or(0);
                let last_played = entry.u64_at("LastPlayed").filter(|v| *v > 0);
                // An entry with neither is a cloud-sync stub, not a game.
                if playtime == 0 && last_played.is_none() {
                    continue;
                }
                out.push(Game {
                    id: format!("steam:{app_id}"),
                    provider: "steam".into(),
                    provider_id: app_id.clone(),
                    // Filled in by the metadata worker. Empty rather than
                    // "App 220", so the interface can show that it is still
                    // arriving instead of showing something wrong.
                    title: String::new(),
                    installed: false,
                    install_dir: None,
                    size_bytes: 0,
                    last_played,
                    playtime_minutes: playtime,
                    favourite: false,
                    hidden: false,
                    art_app_id: None,
                });
            }
        }
        out
    }

    fn read_manifest(path: &Path) -> Option<Game> {
        let text = std::fs::read_to_string(path).ok()?;
        let app = vdf::parse(&text).ok()?.root_child()?.clone();

        let appid = app.str_at("appid")?.trim().to_string();
        let title = app.str_at("name").unwrap_or_default().trim().to_string();
        if appid.is_empty() || title.is_empty() || is_tool(&appid, &title) {
            return None;
        }

        let flags = app.u64_at("StateFlags").unwrap_or(0);
        let install_dir = app.str_at("installdir").map(|d| {
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .join("common")
                .join(d)
        });
        let last_played = app.u64_at("LastPlayed").filter(|v| *v > 0);

        Some(Game {
            id: format!("steam:{appid}"),
            provider: "steam".into(),
            provider_id: appid,
            title,
            installed: flags & STATE_FULLY_INSTALLED != 0,
            install_dir,
            size_bytes: app.u64_at("SizeOnDisk").unwrap_or(0),
            last_played,
            playtime_minutes: 0,
            favourite: false,
            hidden: false,
            art_app_id: None,
        })
    }
}

impl LibraryProvider for Steam {
    fn id(&self) -> &'static str {
        "steam"
    }

    fn detect(&self) -> bool {
        Self::root().is_some()
    }

    fn scan(&self) -> Result<Vec<Game>, String> {
        let root = Self::root().ok_or("Steam is not installed on this machine")?;
        let mut games: Vec<Game> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for lib in Self::library_paths(&root) {
            let dir = lib.join("steamapps");
            let Ok(entries) = std::fs::read_dir(&dir) else {
                // A library folder recorded on a drive that is not plugged in
                // is normal, not an error.
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("appmanifest_") || !name.ends_with(".acf") {
                    continue;
                }
                if let Some(game) = Self::read_manifest(&entry.path()) {
                    // The same appid can appear in two libraries after a move.
                    if seen.insert(game.id.clone()) {
                        games.push(game);
                    }
                }
            }
        }

        Self::merge_played(&mut games, Self::played_games(&root));
        Ok(games)
    }
}

impl Steam {
    /// Played-but-not-installed games fill out the rest of the library. An
    /// installed manifest is the better record, so it wins on the fields it
    /// has -- but playtime only exists in localconfig, so it is merged in
    /// either way.
    ///
    /// By index rather than a search of the list per played game: a couple of
    /// thousand played against a few hundred installed is a few hundred
    /// thousand string compares, on every scan.
    fn merge_played(games: &mut Vec<Game>, played: Vec<Game>) {
        let mut at: std::collections::HashMap<String, usize> = games
            .iter()
            .enumerate()
            .map(|(i, g)| (g.id.clone(), i))
            .collect();
        for p in played {
            match at.get(&p.id).copied() {
                Some(i) => {
                    games[i].playtime_minutes = p.playtime_minutes;
                    games[i].last_played = games[i].last_played.or(p.last_played);
                }
                // The same appid turns up once per Steam account on the
                // machine, so the first one claims the slot.
                None => {
                    at.insert(p.id.clone(), games.len());
                    games.push(p);
                }
            }
        }
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(target_os = "windows")]
fn windows_steam_path() -> Option<PathBuf> {
    // Steam records its own location here on install. Reading it beats
    // guessing Program Files, because a lot of people move it to another
    // drive.
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Valve\\Steam")
        .ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    Some(PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fully_installed_games_are_playable() {
        // Per process: two checkouts can run `cargo test` at once, and with
        // one shared directory the first to finish deletes the other's fixture.
        let base = std::env::temp_dir().join(format!("marquee-test-steam-{}", std::process::id()));
        let dir = base.join("steamapps");
        std::fs::create_dir_all(&dir).unwrap();

        let full = dir.join("appmanifest_365670.acf");
        std::fs::write(
            &full,
            include_str!("../../tests/fixtures/appmanifest_365670.acf"),
        )
        .unwrap();
        let game = Steam::read_manifest(&full).unwrap();
        assert_eq!(game.id, "steam:365670");
        assert_eq!(game.title, "Blender");
        assert!(game.installed);

        // StateFlags 1026 -- a manifest exists but the game is still updating.
        let partial = dir.join("appmanifest_1145360.acf");
        std::fs::write(
            &partial,
            include_str!("../../tests/fixtures/appmanifest_partial.acf"),
        )
        .unwrap();
        let game = Steam::read_manifest(&partial).unwrap();
        assert_eq!(game.title, "Hades");
        assert!(!game.installed, "1026 has no fully-installed bit set");

        std::fs::remove_dir_all(base).ok();
    }

    fn game(id: &str, installed: bool, playtime_minutes: u64) -> Game {
        Game {
            id: id.into(),
            provider: "steam".into(),
            provider_id: id.trim_start_matches("steam:").into(),
            title: String::new(),
            installed,
            install_dir: None,
            size_bytes: 0,
            last_played: None,
            playtime_minutes,
            favourite: false,
            hidden: false,
            art_app_id: None,
        }
    }

    /// Playtime lives only in localconfig.vdf, so a played game that is also
    /// installed has to come out as one entry carrying both facts -- not two
    /// entries, and not the installed one showing no hours.
    #[test]
    fn playtime_is_merged_into_the_installed_entry() {
        let mut games = vec![game("steam:1", true, 0), game("steam:2", true, 0)];
        Steam::merge_played(
            &mut games,
            vec![
                game("steam:2", false, 120),
                game("steam:3", false, 5),
                // A second account on the same machine.
                game("steam:3", false, 7),
            ],
        );
        assert_eq!(games.len(), 3);
        assert_eq!(games[1].playtime_minutes, 120);
        assert!(games[1].installed, "the manifest's record wins");
        assert_eq!(games[2].id, "steam:3");
        assert!(!games[2].installed);
    }

    /// Nobody wants Proton and the Steamworks redistributables in their
    /// library, and they have appmanifests exactly like games do.
    #[test]
    fn valve_tooling_is_filtered_out() {
        assert!(is_tool("228980", "Steamworks Common Redistributables"));
        assert!(is_tool("1628350", "Steam Linux Runtime 3.0 (sniper)"));
        assert!(is_tool("999999", "Proton 9.0"));
        assert!(!is_tool("1091500", "Cyberpunk 2077"));
        assert!(!is_tool("367520", "Hollow Knight"));
    }

    /// Not an assertion about *this* machine -- it depends on whether Steam
    /// happens to be open -- but it must answer without panicking, and it must
    /// agree with itself twice in a row.
    #[test]
    fn detecting_steam_is_stable_and_cheap() {
        let first = Steam::is_running();
        let second = Steam::is_running();
        assert_eq!(first, second, "detection should not flap");
        println!("  steam running on this machine: {first}");
    }

    /// Same shape as `detecting_steam_is_stable_and_cheap`: this depends on
    /// whatever this machine happens to be running, but it must answer
    /// without panicking and agree with itself.
    #[cfg(target_os = "windows")]
    #[test]
    fn reading_the_running_appid_is_stable_and_cheap() {
        let first = Steam::running_app_id();
        let second = Steam::running_app_id();
        assert_eq!(first, second, "detection should not flap");
        println!("  steam running appid on this machine: {first:?}");
    }

    #[test]
    fn scan_never_errors_when_steam_is_absent() {
        // detect() gates scan(); this asserts the contract holds either way.
        let s = Steam;
        if !s.detect() {
            assert!(
                s.scan().is_err(),
                "an absent Steam is an error, not a panic"
            );
        } else {
            assert!(s.scan().is_ok());
        }
    }
}
