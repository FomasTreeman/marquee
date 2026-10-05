//! Export and import what the user authored and a scan cannot rebuild:
//! favourites, hidden games, manual entries, artwork choices, game folders and
//! settings. Artwork and metadata are caches and are left out.
//!
//! When a folder is configured the profile re-exports on every change, and on
//! first run it is looked for there and beside known game folders, so it
//! survives a reinstall that wipes `%APPDATA%`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::sgdb;
use crate::store::{ManualGame, Store};
use crate::{log_info, log_warn};

/// The filename looked for when discovering a profile.
pub const FILENAME: &str = "marquee-profile.json";
/// Setting holding the folder to keep an up-to-date copy in.
pub const FOLDER_SETTING: &str = "profile_folder";

const FORMAT: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub format: u32,
    pub exported_at: u64,
    /// The OS that wrote it, for telling two files apart.
    pub source: String,
    pub settings: Vec<(String, String)>,
    pub games: Vec<UserGame>,
    pub manual: Vec<ManualGame>,
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserGame {
    pub game_id: String,
    pub favourite: bool,
    pub hidden: bool,
    pub custom_title: Option<String>,
    pub art_app_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub settings: usize,
    pub games: usize,
    pub manual: usize,
    pub roots: usize,
}

pub fn collect(store: &Store) -> Result<Profile, String> {
    let games = store
        .user_flags()?
        .into_iter()
        .map(|(game_id, f)| UserGame {
            game_id,
            favourite: f.favourite,
            hidden: f.hidden,
            custom_title: f.custom_title,
            art_app_id: f.art_app_id,
        })
        .collect();

    // The SteamGridDB key is a credential, and a profile is made to be copied
    // and shared, so it stays out.
    let settings = store
        .all_settings()?
        .into_iter()
        .filter(|(key, _)| key != sgdb::SETTING_KEY)
        .collect();

    Ok(Profile {
        format: FORMAT,
        exported_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        source: std::env::consts::OS.to_string(),
        settings,
        games,
        manual: store.manual_games()?,
        roots: store.game_roots()?,
    })
}

pub fn write(store: &Store, path: &Path) -> Result<(), String> {
    let profile = collect(store)?;
    let text = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    // Write then rename, so an interrupted write cannot leave a truncated file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("could not save {}: {e}", path.display()))?;
    log_info!("profile", "exported to {}", path.display());
    Ok(())
}

pub fn read(path: &Path) -> Result<Profile, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let profile: Profile = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not a Marquee profile: {e}", path.display()))?;
    if profile.format > FORMAT {
        return Err(format!(
            "that profile was written by a newer version of Marquee (format {} against {FORMAT})",
            profile.format
        ));
    }
    Ok(profile)
}

/// Merge a profile into the database. The imported value wins on a conflict,
/// and nothing already here is deleted.
pub fn apply(store: &Store, profile: &Profile) -> Result<ImportSummary, String> {
    for (key, value) in &profile.settings {
        store.set_setting(key, value)?;
    }
    for game in &profile.games {
        store.set_user_game(
            &game.game_id,
            game.favourite,
            game.hidden,
            game.custom_title.as_deref(),
            game.art_app_id.as_deref(),
        )?;
    }

    // Match on title and appid, not row id: each machine numbers its own rows.
    let existing = store.manual_games()?;
    let mut added = 0;
    for game in &profile.manual {
        let already = existing.iter().any(|e| {
            e.title.eq_ignore_ascii_case(&game.title) && e.steam_app_id == game.steam_app_id
        });
        if already {
            continue;
        }
        let id = store.add_manual_game(&game.title, game.steam_app_id.as_deref())?;
        // Kept even if it does not exist here: a wrong path is a better start
        // than an empty field, and a missing executable is reported on launch.
        if let Some(exe) = &game.executable {
            store.set_executable(id, Some(exe))?;
        }
        added += 1;
    }

    for root in &profile.roots {
        store.add_root(root)?;
    }

    let summary = ImportSummary {
        settings: profile.settings.len(),
        games: profile.games.len(),
        manual: added,
        roots: profile.roots.len(),
    };
    log_info!(
        "profile",
        "imported {} settings, {} games, {} hand-added, {} folders",
        summary.settings,
        summary.games,
        summary.manual,
        summary.roots
    );
    Ok(summary)
}

/// Places a profile might be: the configured folder, then every known game
/// folder, which is often on a drive a reinstall did not touch.
pub fn search_paths(store: &Store) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(Some(folder)) = store.setting(FOLDER_SETTING) {
        out.push(PathBuf::from(folder).join(FILENAME));
    }
    if let Ok(roots) = store.game_roots() {
        for root in roots {
            out.push(PathBuf::from(root).join(FILENAME));
        }
    }
    out
}

/// The first profile that exists in any of the likely places.
pub fn discover(store: &Store) -> Option<PathBuf> {
    search_paths(store).into_iter().find(|p| p.is_file())
}

/// Re-export to the configured folder, if any. A failure is logged, never
/// returned, so it cannot fail the change that triggered it.
pub fn auto_export(store: &Store) {
    let Ok(Some(folder)) = store.setting(FOLDER_SETTING) else {
        return;
    };
    let path = PathBuf::from(folder).join(FILENAME);
    if let Err(e) = write(store, &path) {
        log_warn!(
            "profile",
            "could not keep {} up to date: {e}",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per test, since the tests assert on counts.
    fn store() -> Store {
        Store::in_memory()
    }

    #[test]
    fn a_profile_round_trips_everything_a_scan_cannot_rebuild() {
        let a = store();
        a.set_setting("sort", "played").unwrap();
        a.toggle_favourite("steam:1091500").unwrap();
        a.set_hidden("steam:440", true).unwrap();
        a.set_art_source("steam:2807960", Some("sgdb:8452"))
            .unwrap();
        a.set_custom_title("steam:620", Some("Portal Two")).unwrap();
        let manual = a
            .add_manual_game("Some Torrented Game", Some("367520"))
            .unwrap();
        a.set_executable(manual, Some("/games/stg/game.exe"))
            .unwrap();

        let exported = collect(&a).unwrap();
        let dir = std::env::temp_dir().join("marquee-profile-test");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(FILENAME);
        write(&a, &path).unwrap();

        let loaded = read(&path).unwrap();
        assert_eq!(loaded.format, FORMAT);
        assert!(loaded
            .settings
            .iter()
            .any(|(k, v)| k == "sort" && v == "played"));
        assert!(loaded
            .games
            .iter()
            .any(|g| g.game_id == "steam:1091500" && g.favourite));
        assert!(loaded
            .games
            .iter()
            .any(|g| g.game_id == "steam:440" && g.hidden));
        assert!(loaded
            .games
            .iter()
            .any(|g| g.game_id == "steam:2807960" && g.art_app_id.as_deref() == Some("sgdb:8452")));
        assert!(loaded
            .games
            .iter()
            .any(|g| g.custom_title.as_deref() == Some("Portal Two")));
        assert!(loaded
            .manual
            .iter()
            .any(|m| m.title == "Some Torrented Game"
                && m.executable.as_deref() == Some("/games/stg/game.exe")));
        assert_eq!(loaded.games.len(), exported.games.len());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_profile_leaves_the_steamgriddb_key_behind() {
        let a = store();
        a.set_setting(sgdb::SETTING_KEY, "0123456789abcdef")
            .unwrap();
        a.set_setting("sort", "name").unwrap();

        let exported = collect(&a).unwrap();
        let text = serde_json::to_string(&exported).unwrap();
        assert!(!text.contains("0123456789abcdef"), "{text}");
        assert!(exported
            .settings
            .iter()
            .any(|(k, v)| k == "sort" && v == "name"));
    }

    #[test]
    fn a_game_root_comes_back_exactly_where_it_was() {
        let a = store();
        a.remember_root("/Volumes/Big/Games/Elden Ring/Game/eldenring.exe")
            .unwrap();
        let before = a.game_roots().unwrap();
        assert!(before.contains(&"/Volumes/Big/Games".to_string()));

        let dir =
            std::env::temp_dir().join(format!("marquee-profile-roots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(FILENAME);
        write(&a, &path).unwrap();
        let b = store();
        apply(&b, &read(&path).unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        let mut after = b.game_roots().unwrap();
        let mut before = before;
        before.sort();
        after.sort();
        assert_eq!(
            after, before,
            "a root must not drift towards / on each round trip"
        );
    }

    #[test]
    fn importing_twice_does_not_duplicate() {
        let s = store();
        let profile = Profile {
            format: FORMAT,
            exported_at: 0,
            source: "test".into(),
            settings: vec![],
            games: vec![],
            manual: vec![ManualGame {
                id: 999,
                title: "Imported Game".into(),
                steam_app_id: Some("1".into()),
                executable: None,
                args: String::new(),
                last_played: None,
            }],
            roots: vec![],
        };

        let before = s.manual_games().unwrap().len();
        let first = apply(&s, &profile).unwrap();
        let second = apply(&s, &profile).unwrap();
        assert_eq!(first.manual, 1);
        assert_eq!(second.manual, 0, "the second import should add nothing");
        assert_eq!(s.manual_games().unwrap().len(), before + 1);
    }

    /// The round-trip test checks the file; this checks applying it.
    #[test]
    fn restores_onto_a_fresh_machine() {
        let old = store();
        old.set_setting("sort", "name").unwrap();
        old.set_setting(super::FOLDER_SETTING, "/Volumes/Games")
            .unwrap();
        old.toggle_favourite("steam:1091500").unwrap();
        old.set_hidden("steam:440", true).unwrap();
        old.set_art_source("steam:2807960", Some("sgdb:8452"))
            .unwrap();
        old.set_custom_title("steam:620", Some("Portal Two"))
            .unwrap();
        let id = old
            .add_manual_game("Torrented Game", Some("367520"))
            .unwrap();
        old.set_executable(id, Some("/games/tg/game.exe")).unwrap();

        let dir = std::env::temp_dir().join("marquee-profile-restore");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(FILENAME);
        write(&old, &path).unwrap();

        let fresh = store();
        assert!(fresh.user_flags().unwrap().is_empty());
        apply(&fresh, &read(&path).unwrap()).unwrap();

        let flags: std::collections::HashMap<_, _> =
            fresh.user_flags().unwrap().into_iter().collect();
        assert!(flags["steam:1091500"].favourite);
        assert!(flags["steam:440"].hidden);
        assert_eq!(
            flags["steam:2807960"].art_app_id.as_deref(),
            Some("sgdb:8452")
        );
        assert_eq!(
            flags["steam:620"].custom_title.as_deref(),
            Some("Portal Two")
        );
        assert_eq!(fresh.setting("sort").unwrap().as_deref(), Some("name"));

        let manual = fresh.manual_games().unwrap();
        assert_eq!(manual.len(), 1);
        assert_eq!(manual[0].title, "Torrented Game");
        assert_eq!(manual[0].executable.as_deref(), Some("/games/tg/game.exe"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_never_deletes_what_is_already_here() {
        let here = store();
        here.toggle_favourite("steam:local-only").unwrap();
        let local_manual = here.add_manual_game("Only On This Machine", None).unwrap();
        assert!(local_manual > 0);

        let incoming = Profile {
            format: FORMAT,
            exported_at: 0,
            source: "elsewhere".into(),
            settings: vec![],
            games: vec![UserGame {
                game_id: "steam:from-file".into(),
                favourite: true,
                hidden: false,
                custom_title: None,
                art_app_id: None,
            }],
            manual: vec![],
            roots: vec![],
        };
        apply(&here, &incoming).unwrap();

        let flags: std::collections::HashMap<_, _> =
            here.user_flags().unwrap().into_iter().collect();
        assert!(
            flags["steam:local-only"].favourite,
            "a local favourite must survive"
        );
        assert!(flags["steam:from-file"].favourite);
        assert!(here
            .manual_games()
            .unwrap()
            .iter()
            .any(|m| m.title == "Only On This Machine"));
    }

    #[test]
    fn the_imported_value_wins_on_a_conflict() {
        let here = store();
        here.set_setting("sort", "size").unwrap();
        here.set_art_source("steam:1", Some("111")).unwrap();

        apply(
            &here,
            &Profile {
                format: FORMAT,
                exported_at: 0,
                source: "elsewhere".into(),
                settings: vec![("sort".into(), "name".into())],
                games: vec![UserGame {
                    game_id: "steam:1".into(),
                    favourite: false,
                    hidden: false,
                    custom_title: None,
                    art_app_id: Some("222".into()),
                }],
                manual: vec![],
                roots: vec![],
            },
        )
        .unwrap();

        assert_eq!(here.setting("sort").unwrap().as_deref(), Some("name"));
        let flags = here.user_flags().unwrap();
        assert_eq!(flags[0].1.art_app_id.as_deref(), Some("222"));
    }

    #[test]
    fn auto_export_only_writes_when_a_folder_is_set() {
        let s = store();
        auto_export(&s); // no folder: must do nothing, and must not panic

        let dir = std::env::temp_dir().join("marquee-profile-auto");
        let _ = std::fs::remove_dir_all(&dir);
        s.set_setting(FOLDER_SETTING, dir.to_str().unwrap())
            .unwrap();
        s.toggle_favourite("steam:1").unwrap();
        auto_export(&s);

        let written = dir.join(FILENAME);
        assert!(written.is_file(), "a configured folder should get a copy");
        assert!(read(&written).unwrap().games.iter().any(|g| g.favourite));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_newer_format_is_refused() {
        let dir = std::env::temp_dir().join("marquee-profile-future");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILENAME);
        std::fs::write(&path, r#"{"format":999,"exportedAt":0,"source":"x","settings":[],"games":[],"manual":[],"roots":[]}"#).unwrap();
        let err = read(&path).unwrap_err();
        assert!(err.contains("newer version"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rubbish_is_a_readable_error_not_a_panic() {
        let dir = std::env::temp_dir().join("marquee-profile-junk");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILENAME);
        std::fs::write(&path, "not json at all").unwrap();
        assert!(read(&path).unwrap_err().contains("not a Marquee profile"));
        assert!(read(&dir.join("no-such-file.json")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovery_looks_where_the_games_are() {
        let s = store();
        s.remember_root("/Volumes/Games/Some Game/game.exe")
            .unwrap();
        let paths = search_paths(&s);
        assert!(
            paths.iter().any(|p| p.starts_with("/Volumes/Games")),
            "learned game folders should be searched: {paths:?}"
        );
        assert!(paths.iter().all(|p| p.ends_with(FILENAME)));
    }
}
