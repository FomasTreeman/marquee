//! Export and import everything the user authored.
//!
//! A profile is the small, irreplaceable half of this app's state: which games
//! are favourited, which are hidden, what was added by hand and where it lives,
//! artwork corrections, learned game folders, and settings. Kilobytes. The
//! large half -- artwork and metadata -- is a cache and rebuilds itself, so it
//! is deliberately not included.
//!
//! The point is surviving a machine. A fresh Windows install wipes `%APPDATA%`
//! and takes the database with it, and none of what it held can be reconstructed
//! by scanning: nobody remembers which forty games they had hidden.
//!
//! So the file goes wherever the user says. Two things make that more than a
//! manual chore:
//!
//!   * **It re-exports itself** whenever the profile changes, if a folder is
//!     configured. Point it at a synced folder and it is cloud sync; point it
//!     at a second drive and it survives the reinstall that took the first one.
//!   * **It is looked for on first run.** A machine with no profile checks the
//!     configured folder and the folders it has learned games live in, which on
//!     a typical setup are on a drive the reinstall did not touch.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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
    /// Format version, so a future change can migrate rather than guess.
    pub format: u32,
    pub exported_at: u64,
    /// Which machine wrote it. Only useful for telling two files apart.
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

    Ok(Profile {
        format: FORMAT,
        exported_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        source: std::env::consts::OS.to_string(),
        settings: store.all_settings()?,
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
    // Temp-then-rename. A profile half-written when the power went out is worse
    // than no profile, because it looks like one.
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

/// Merge a profile into the database.
///
/// Merge rather than replace, and the imported value wins on a conflict: import
/// is something the user asked for explicitly, so it should do what it says.
/// Nothing is deleted -- a game favourited here but absent from the file stays
/// favourited, because losing something on import is the one outcome nobody
/// would want.
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

    // Hand-added games are matched on what they are, not on their row id: two
    // machines number their rows independently, so importing by id would either
    // collide or duplicate.
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
        // The executable path comes from the machine that exported it, and may
        // not exist here. Kept anyway: a path that is wrong is a better
        // starting point than an empty field, and the interface reports a
        // missing executable clearly when it is used.
        if let Some(exe) = &game.executable {
            store.set_executable(id, Some(exe))?;
        }
        added += 1;
    }

    for root in &profile.roots {
        store.remember_root(&format!("{root}/x"))?;
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

/// Places a profile might be, most likely first.
///
/// The configured folder, then every folder the app has learned games live in.
/// That last one is the interesting case: on a machine where games are kept on
/// a second drive, a profile saved beside them survives the reinstall that took
/// the first drive, and is found without anyone remembering where they put it.
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

/// Re-export to the configured folder, if there is one.
///
/// Called after anything that changes the profile. Silent when no folder is
/// configured, and never fatal: a profile that cannot be written is worth a log
/// line, not a failed favourite.
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

    /// Isolated per test. These assert on counts, and a shared database makes
    /// the second run of the suite disagree with the first.
    fn store() -> Store {
        Store::in_memory()
    }

    /// Everything that cannot be reconstructed by scanning has to survive the
    /// round trip. That is the whole point: nobody remembers which forty games
    /// they had hidden.
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

    /// Importing twice must not produce two of every hand-added game. Rows are
    /// numbered per machine, so matching has to be on what a game *is*.
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

    /// A file from a newer version is refused rather than half-understood.
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

    /// The folders games live in are searched, which is what makes a profile
    /// survive a reinstall without anyone remembering where they saved it.
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
