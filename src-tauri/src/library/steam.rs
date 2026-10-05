//! The Steam provider. Reads `libraryfolders.vdf` for the library roots, then each
//! `appmanifest_*.acf` in them. The format is the same on every OS; only the path differs.

use std::path::{Path, PathBuf};

use super::{Game, LibraryProvider};
use crate::{log_warn, vdf};

/// Steam sets bit 2 on a fully installed app. Queued or partial downloads also have
/// manifests and should not appear as playable.
const STATE_FULLY_INSTALLED: u64 = 4;

/// The local content is out of date and must download before the game runs. Whether it
/// is downloading now is `STATE_UPDATING_MASK`.
const STATE_UPDATE_REQUIRED: u64 = 2;

/// Bits set while Steam fetches or applies an update. `StateFlags` is undocumented, so this
/// is checked against a real manifest (`appmanifest_partial.acf`, 1026), not a spec.
const STATE_UPDATING_MASK: u64 = 0x100 // Update Running
    | 0x200 // Update Paused
    | 0x400 // Update Started
    | 0x8000 // Validating
    | 0x10000 // Adding Files
    | 0x20000 // Preallocating
    | 0x40000 // Downloading
    | 0x80000 // Staging
    | 0x100000; // Committing

/// Valve's tools and runtimes have appmanifests like any game; keep them out of the library.
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
    /// Where Steam keeps itself, most likely first.
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

    /// Whether the Steam client is running. Opening `steam://` while Steam is closed starts it
    /// cold, and a cold start raises its library window over the launcher.
    pub fn is_running() -> bool {
        #[cfg(target_os = "windows")]
        {
            // Steam keeps a live pid here; cheaper and more reliable than tasklist.
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

    /// The appid Steam reports as running, if any. A `steam://` launch leaves no child process
    /// of ours to wait on, so `run::start` polls this to see the session end.
    ///
    /// `RunningAppID` sits directly under the `Steam` key. #94 read only `ActiveProcess`,
    /// which never fired; that location stays as a fallback for other Steam versions.
    #[cfg(target_os = "windows")]
    fn running_app_id_from(steam: &winreg::RegKey) -> Option<u32> {
        steam
            .get_value::<u32, _>("RunningAppID")
            .ok()
            .or_else(|| {
                steam
                    .open_subkey("ActiveProcess")
                    .and_then(|k| k.get_value::<u32, _>("RunningAppID"))
                    .ok()
            })
            .filter(|id| *id != 0)
    }

    #[cfg(target_os = "windows")]
    pub fn running_app_id() -> Option<u32> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Valve\\Steam")
            .ok()
            .and_then(|k| Self::running_app_id_from(&k))
    }

    /// Start Steam with `-silent`, straight to the tray, so its library window does not appear.
    pub fn start_silently() -> Result<(), String> {
        #[cfg(target_os = "macos")]
        let mut command = {
            // Not `open -a Steam`: that activates the app and shows the window.
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

    /// Every library folder Steam knows about, including the root. Games on other drives
    /// are only recorded here.
    fn library_paths(root: &Path) -> Vec<PathBuf> {
        let mut out = vec![root.to_path_buf()];
        let file = root.join("steamapps/libraryfolders.vdf");
        let Ok(text) = std::fs::read_to_string(&file) else {
            return out;
        };
        // Warn, because a parse failure looks like a small library rather than a broken one.
        let parsed = match vdf::parse(&text) {
            Ok(p) => p,
            Err(e) => {
                log_warn!(
                    "steam",
                    "{}: {e}; only the install drive is scanned",
                    file.display()
                );
                return out;
            }
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

    /// Games this account has played on this machine, from `userdata/<id>/config/localconfig.vdf`.
    /// Gives playtime and last-played without an API key or a public profile. It covers apps
    /// launched or configured here, not the whole owned library.
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
                log_warn!("steam", "could not parse {}", file.display());
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
                    // Filled in by the metadata worker; empty so the UI shows it is loading.
                    title: String::new(),
                    installed: false,
                    update_available: false,
                    updating: false,
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
        let app = match vdf::parse(&text) {
            Ok(v) => v.root_child()?.clone(),
            Err(e) => {
                // Log it, or the game silently vanishes from the library.
                log_warn!("steam", "{}: {e}; skipped", path.display());
                return None;
            }
        };

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
            update_available: flags & STATE_UPDATE_REQUIRED != 0,
            updating: flags & STATE_UPDATING_MASK != 0,
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
                // A library on a drive that is not plugged in is normal.
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
    /// Merge in played-but-not-installed games. The installed manifest wins on its own fields,
    /// but playtime only exists in localconfig. Indexed by id to avoid a search per game.
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
                    // The later of the two: the manifest's LastPlayed lags or freezes while
                    // localconfig keeps updating, so `.or()` kept replayed games out of
                    // "recently played" (#111).
                    games[i].last_played = games[i].last_played.max(p.last_played);
                }
                // One entry per Steam account on the machine; the first claims the slot.
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
    // Steam records its location here on install; many people move it off Program Files.
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
        // Per process, so concurrent `cargo test` runs do not delete each other's fixtures.
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

        // StateFlags 1026: a manifest exists but the game is still updating.
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
            update_available: false,
            updating: false,
            install_dir: None,
            size_bytes: 0,
            last_played: None,
            playtime_minutes,
            favourite: false,
            hidden: false,
            art_app_id: None,
        }
    }

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

    /// The manifest's LastPlayed goes stale; preferring it was #111.
    #[test]
    fn a_more_recent_localconfig_last_played_beats_a_stale_manifest_one() {
        let mut installed = game("steam:1", true, 0);
        installed.last_played = Some(100);
        let mut newly_played = game("steam:1", false, 30);
        newly_played.last_played = Some(500);

        let mut games = vec![installed];
        Steam::merge_played(&mut games, vec![newly_played]);

        assert_eq!(games[0].last_played, Some(500));
    }

    /// Each fixture isolates one state in the `StateFlags` bitfield.
    #[test]
    fn update_state_is_read_from_state_flags() {
        let dir = std::env::temp_dir().join("marquee-test-steam-update/steamapps");
        std::fs::create_dir_all(&dir).unwrap();

        // StateFlags 4: fully installed, nothing pending.
        let current = dir.join("appmanifest_365670.acf");
        std::fs::write(
            &current,
            include_str!("../../tests/fixtures/appmanifest_365670.acf"),
        )
        .unwrap();
        let game = Steam::read_manifest(&current).unwrap();
        assert!(game.installed);
        assert!(!game.update_available, "4 has no update-required bit");
        assert!(!game.updating);

        // StateFlags 6 (4 + 2): installed, update waiting but not started.
        let waiting = dir.join("appmanifest_367520.acf");
        std::fs::write(
            &waiting,
            include_str!("../../tests/fixtures/appmanifest_update_available.acf"),
        )
        .unwrap();
        let game = Steam::read_manifest(&waiting).unwrap();
        assert!(game.installed, "still playable while an update only waits");
        assert!(game.update_available, "6 sets the update-required bit");
        assert!(!game.updating, "nothing is downloading yet");

        // StateFlags 1026 (1024 + 2): update required and under way.
        let downloading = dir.join("appmanifest_1145360.acf");
        std::fs::write(
            &downloading,
            include_str!("../../tests/fixtures/appmanifest_partial.acf"),
        )
        .unwrap();
        let game = Steam::read_manifest(&downloading).unwrap();
        assert!(game.update_available, "1026 still has the required bit set");
        assert!(
            game.updating,
            "1024 (Update Started) is in the updating mask"
        );

        std::fs::remove_dir_all(std::env::temp_dir().join("marquee-test-steam-update")).ok();
    }

    #[test]
    fn valve_tooling_is_filtered_out() {
        assert!(is_tool("228980", "Steamworks Common Redistributables"));
        assert!(is_tool("1628350", "Steam Linux Runtime 3.0 (sniper)"));
        assert!(is_tool("999999", "Proton 9.0"));
        assert!(!is_tool("1091500", "Cyberpunk 2077"));
        assert!(!is_tool("367520", "Hollow Knight"));
    }

    /// Depends on whether Steam is open, so it only checks the answer is consistent.
    #[test]
    fn detecting_steam_is_stable_and_cheap() {
        let first = Steam::is_running();
        let second = Steam::is_running();
        assert_eq!(first, second, "detection should not flap");
        println!("  steam running on this machine: {first}");
    }

    /// Depends on this machine's state, so it only checks the answer is consistent.
    #[cfg(target_os = "windows")]
    #[test]
    fn reading_the_running_appid_is_stable_and_cheap() {
        let first = Steam::running_app_id();
        let second = Steam::running_app_id();
        assert_eq!(first, second, "detection should not flap");
        println!("  steam running appid on this machine: {first:?}");
    }

    /// #94 read only `ActiveProcess`, which never fired against a live session. A scratch
    /// registry key means no Steam install is needed.
    #[cfg(target_os = "windows")]
    #[test]
    fn running_app_id_is_read_from_the_steam_key_not_only_active_process() {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let scratch = format!(
            "Software\\MarqueeTest\\running_app_id\\{}",
            std::process::id()
        );
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (steam, _) = hkcu.create_subkey(&scratch).expect("create scratch key");

        // The shape #94 shipped, under ActiveProcess. Kept as a fallback.
        let (active_process, _) = steam
            .create_subkey("ActiveProcess")
            .expect("create ActiveProcess subkey");
        active_process.set_value("RunningAppID", &4321u32).unwrap();
        assert_eq!(
            Steam::running_app_id_from(&steam),
            Some(4321),
            "must still find it nested under ActiveProcess as a fallback"
        );

        // The shape a real session uses: directly under the Steam key.
        steam.delete_subkey_all("ActiveProcess").unwrap();
        steam.set_value("RunningAppID", &1234u32).unwrap();
        assert_eq!(
            Steam::running_app_id_from(&steam),
            Some(1234),
            "must find it directly under the Steam key -- this is the case #94 missed"
        );

        hkcu.delete_subkey_all(&scratch).ok();
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
