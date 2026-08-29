//! Persistent storage.
//!
//! The structural decision from docs/PLAN.md §8, and the most important one in
//! the schema:
//!
//! > **Scanner-owned data and user-owned data live in different tables.**
//!
//! `manual_game` and `user_game` are authored by the user. **No scanner may
//! ever delete from them.** If Steam is uninstalled and its games vanish from
//! a scan, favourites and hand-added games survive untouched. That single
//! property is most of what "stability" means to somebody two years in.
//!
//! Migrations are versioned from the first release, because a schema change
//! after other people have libraries is otherwise unrecoverable.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::{log_info, paths};

/// Each entry runs once, in order, and is never edited afterwards -- an edited
/// migration is a schema that differs between a fresh install and an upgrade.
const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE manual_game (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT    NOT NULL,
        steam_app_id TEXT,
        executable   TEXT,
        args         TEXT    NOT NULL DEFAULT '',
        added_at     INTEGER NOT NULL
     );
     CREATE TABLE user_game (
        game_id      TEXT    PRIMARY KEY,
        favourite    INTEGER NOT NULL DEFAULT 0,
        hidden       INTEGER NOT NULL DEFAULT 0,
        custom_title TEXT
     );",
    // v2. Artwork is keyed by Steam appid, and the appid a game *is* is not
    // always the appid whose artwork it should borrow. A Steam release with no
    // cover on the CDN, a game listed under a different name, a hand-added
    // GOG copy matched to the wrong entry -- all are fixed by pointing the art
    // somewhere else, and none of them are fixed by editing a title.
    //
    // In user_game deliberately: it is a correction the user made, and no
    // scanner may ever clear it.
    "ALTER TABLE user_game ADD COLUMN art_app_id TEXT;",
];

pub struct Store(Mutex<Connection>);

fn db_path() -> PathBuf {
    paths::data_dir().join("marquee.db")
}

impl Store {
    pub fn open() -> Result<Self, String> {
        let path = db_path();
        if let Some(dir) = path.parent() {
            paths::ensure(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        let conn = Connection::open(&path)
            .map_err(|e| format!("could not open {}: {e}", path.display()))?;
        // Survives a power cut mid-write, and lets the metadata worker read
        // while the interface writes.
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        migrate(&conn)?;
        log_info!("store", "opened {}", path.display());
        Ok(Store(Mutex::new(conn)))
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let conn = self
            .0
            .lock()
            .map_err(|_| "database lock is poisoned".to_string())?;
        f(&conn).map_err(|e| e.to_string())
    }
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)
            .map_err(|e| format!("migration {} failed: {e}", i + 1))?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)
            .map_err(|e| e.to_string())?;
        log_info!("store", "migrated to schema v{}", i + 1);
    }
    Ok(())
}

// --- manual games -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualGame {
    pub id: i64,
    pub title: String,
    /// Set when the game was identified through the Steam store search, which
    /// is what lets a GOG or Epic copy borrow Steam's artwork and metadata.
    /// It does not mean the game came from Steam.
    pub steam_app_id: Option<String>,
    pub executable: Option<String>,
    pub args: String,
}

impl Store {
    pub fn manual_games(&self) -> Result<Vec<ManualGame>, String> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT id, title, steam_app_id, executable, args FROM manual_game ORDER BY id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(ManualGame {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    steam_app_id: r.get(2)?,
                    executable: r.get(3)?,
                    args: r.get(4)?,
                })
            })?;
            rows.collect()
        })
    }

    pub fn add_manual_game(&self, title: &str, steam_app_id: Option<&str>) -> Result<i64, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("a game needs a name".into());
        }
        self.with(|c| {
            c.execute(
                "INSERT INTO manual_game (title, steam_app_id, added_at)
                 VALUES (?1, ?2, strftime('%s','now'))",
                params![title, steam_app_id],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    pub fn set_executable(&self, id: i64, executable: Option<&str>) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "UPDATE manual_game SET executable = ?2 WHERE id = ?1",
                params![id, executable],
            )?;
            Ok(())
        })
    }

    pub fn remove_manual_game(&self, id: i64) -> Result<(), String> {
        self.with(|c| {
            c.execute("DELETE FROM manual_game WHERE id = ?1", params![id])?;
            // The user data keyed to it goes too -- this is the one deletion
            // that is the user's own instruction rather than a scanner's.
            c.execute(
                "DELETE FROM user_game WHERE game_id = ?1",
                params![format!("manual:{id}")],
            )?;
            Ok(())
        })
    }
}

// --- user data ----------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserFlags {
    pub favourite: bool,
    pub hidden: bool,
    pub custom_title: Option<String>,
    /// Where this game's artwork should come from, when it should not come
    /// from its own appid.
    pub art_app_id: Option<String>,
}

impl Store {
    pub fn user_flags(&self) -> Result<Vec<(String, UserFlags)>, String> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT game_id, favourite, hidden, custom_title, art_app_id FROM user_game",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    UserFlags {
                        favourite: r.get::<_, i64>(1)? != 0,
                        hidden: r.get::<_, i64>(2)? != 0,
                        custom_title: r.get(3)?,
                        art_app_id: r.get(4)?,
                    },
                ))
            })?;
            rows.collect()
        })
    }

    /// Toggle a flag, returning the new value.
    ///
    /// Upserts, because a game acquires a row here the first time the user
    /// expresses an opinion about it and not before -- there is no reason to
    /// carry a row per game in the library.
    pub fn toggle_favourite(&self, game_id: &str) -> Result<bool, String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO user_game (game_id, favourite) VALUES (?1, 1)
                 ON CONFLICT(game_id) DO UPDATE SET favourite = 1 - favourite",
                params![game_id],
            )?;
            c.query_row(
                "SELECT favourite FROM user_game WHERE game_id = ?1",
                params![game_id],
                |r| Ok(r.get::<_, i64>(0)? != 0),
            )
        })
    }
}

impl Store {
    /// Point a game's artwork at a different Steam appid.
    ///
    /// Passing None clears the override and returns the game to its own
    /// artwork, which is the escape hatch when a correction was itself wrong.
    pub fn set_art_source(&self, game_id: &str, app_id: Option<&str>) -> Result<(), String> {
        if let Some(id) = app_id {
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
                return Err(format!("not a valid Steam appid: {id:?}"));
            }
        }
        self.with(|c| {
            c.execute(
                "INSERT INTO user_game (game_id, art_app_id) VALUES (?1, ?2)
                 ON CONFLICT(game_id) DO UPDATE SET art_app_id = ?2",
                params![game_id, app_id],
            )?;
            Ok(())
        })
    }

    /// Rename a game, or clear the rename with None.
    pub fn set_custom_title(&self, game_id: &str, title: Option<&str>) -> Result<(), String> {
        let title = title.map(str::trim).filter(|t| !t.is_empty());
        self.with(|c| {
            c.execute(
                "INSERT INTO user_game (game_id, custom_title) VALUES (?1, ?2)
                 ON CONFLICT(game_id) DO UPDATE SET custom_title = ?2",
                params![game_id, title],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Store {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        Store(Mutex::new(conn))
    }

    #[test]
    fn migrations_are_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Running again on an up-to-date database must do nothing rather than
        // fail on "table already exists".
        migrate(&conn).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
    }

    #[test]
    fn a_manual_game_round_trips() {
        let s = memory();
        let id = s.add_manual_game("Hollow Knight", Some("367520")).unwrap();
        s.set_executable(id, Some("/games/hk/hk.exe")).unwrap();
        let games = s.manual_games().unwrap();
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].title, "Hollow Knight");
        assert_eq!(games[0].steam_app_id.as_deref(), Some("367520"));
        assert_eq!(games[0].executable.as_deref(), Some("/games/hk/hk.exe"));
    }

    #[test]
    fn a_game_needs_a_name() {
        let s = memory();
        assert!(s.add_manual_game("   ", None).is_err());
    }

    #[test]
    fn favourite_toggles_and_persists() {
        let s = memory();
        assert!(s.toggle_favourite("steam:1091500").unwrap());
        assert!(!s.toggle_favourite("steam:1091500").unwrap());
        assert!(s.toggle_favourite("steam:1091500").unwrap());
        let flags = s.user_flags().unwrap();
        assert_eq!(flags.len(), 1);
        assert!(flags[0].1.favourite);
    }

    #[test]
    fn artwork_can_be_pointed_at_another_appid_and_back() {
        let s = memory();
        s.set_art_source("steam:4254230", Some("1091500")).unwrap();
        let flags = s.user_flags().unwrap();
        assert_eq!(flags[0].1.art_app_id.as_deref(), Some("1091500"));

        // A correction can itself be wrong, so it must be reversible.
        s.set_art_source("steam:4254230", None).unwrap();
        assert_eq!(s.user_flags().unwrap()[0].1.art_app_id, None);
    }

    /// An appid ends up in a URL. Anything that is not digits must not.
    #[test]
    fn an_art_source_must_be_digits() {
        let s = memory();
        for bad in ["", "abc", "../../etc", "12 34", "1091500; DROP TABLE"] {
            assert!(s.set_art_source("steam:1", Some(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_rename_survives_and_can_be_cleared() {
        let s = memory();
        s.set_custom_title("steam:1", Some("  My Name  ")).unwrap();
        assert_eq!(
            s.user_flags().unwrap()[0].1.custom_title.as_deref(),
            Some("My Name")
        );
        s.set_custom_title("steam:1", Some("   ")).unwrap();
        assert_eq!(s.user_flags().unwrap()[0].1.custom_title, None);
    }

    /// Corrections and favourites share a row and must not clobber each other.
    #[test]
    fn user_edits_compose_rather_than_overwrite() {
        let s = memory();
        s.toggle_favourite("steam:7").unwrap();
        s.set_art_source("steam:7", Some("440")).unwrap();
        s.set_custom_title("steam:7", Some("Renamed")).unwrap();
        let (_, f) = s.user_flags().unwrap().into_iter().next().unwrap();
        assert!(f.favourite, "favourite lost when artwork was set");
        assert_eq!(f.art_app_id.as_deref(), Some("440"));
        assert_eq!(f.custom_title.as_deref(), Some("Renamed"));
    }

    /// The property the whole schema exists for.
    #[test]
    fn user_data_outlives_the_game_it_describes() {
        let s = memory();
        s.toggle_favourite("steam:1091500").unwrap();
        // A scan finding nothing must not be able to remove this. There is no
        // API that would let it -- that is the point -- so this asserts the
        // absence: nothing but remove_manual_game deletes from user_game.
        let flags = s.user_flags().unwrap();
        assert!(flags
            .iter()
            .any(|(id, f)| id == "steam:1091500" && f.favourite));
    }
}
