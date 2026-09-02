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

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{log_info, log_warn, paths};

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
    // v3. Where this person actually keeps games.
    //
    // Guessing at Program Files and C:\\Games is worthless for anyone whose
    // library lives in a custom folder on whichever drive had room -- which is
    // most people with a large collection. So instead of guessing, learn: every
    // time an executable is chosen by hand, remember the directory its game
    // folder sits in, and search there first next time.
    "CREATE TABLE game_root (
        path     TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
     );",
    // v4. Settings.
    //
    // A plain key/value table rather than typed columns, because settings
    // arrive one at a time and a migration per setting is a poor trade.
    "CREATE TABLE setting (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
     );",
    // v5. Steam learns "last played" from localconfig.vdf on every rescan, but
    // a hand-added game has no such file anywhere -- nothing ever wrote the
    // timestamp, so it read as "never played" forever regardless of how often
    // it was launched. Recorded here instead, at the moment we spawn it
    // ourselves, since a manual game is the one case where we own the launch.
    "ALTER TABLE manual_game ADD COLUMN last_played INTEGER;",
];

pub struct Store(Mutex<Connection>);

fn db_path() -> PathBuf {
    paths::data_dir().join("marquee.db")
}

impl Store {
    /// A fresh, empty database that exists only for the duration of a test.
    ///
    /// Tests previously shared the on-disk database, so one that inserted a row
    /// changed what the next one saw -- and a second run of the suite behaved
    /// differently from the first. Isolation is not optional for a test that
    /// asserts "importing twice adds one row".
    #[cfg(test)]
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory database");
        migrate(&conn).expect("migrations");
        Store(Mutex::new(conn))
    }

    pub fn open() -> Result<Self, String> {
        let path = db_path();
        if let Some(dir) = path.parent() {
            paths::ensure(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        let conn = Connection::open(&path)
            .map_err(|e| format!("could not open {}: {e}", path.display()))?;
        // Survives a power cut mid-write, and lets the metadata worker read
        // while the interface writes. Refused on some network and read-only
        // volumes, where the default rollback journal still works, so a
        // refusal is not worth failing the open for.
        if let Err(e) = conn.pragma_update(None, "journal_mode", "WAL") {
            log_warn!("store", "WAL refused, using a rollback journal: {e}");
        }
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
    /// Unix seconds this was last launched through us. `None` until the first
    /// successful launch -- there is no scanner that could ever learn this from
    /// elsewhere, unlike Steam's `localconfig.vdf`.
    pub last_played: Option<i64>,
}

impl Store {
    pub fn manual_games(&self) -> Result<Vec<ManualGame>, String> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT id, title, steam_app_id, executable, args, last_played FROM manual_game ORDER BY id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(ManualGame {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    steam_app_id: r.get(2)?,
                    executable: r.get(3)?,
                    args: r.get(4)?,
                    last_played: r.get(5)?,
                })
            })?;
            rows.collect()
        })
    }

    /// Record that a hand-added game was just launched.
    ///
    /// Called when we spawn its process ourselves -- the one moment a manual
    /// game's "last played" can be learned, since nothing external tracks it.
    pub fn record_manual_play(&self, id: i64) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "UPDATE manual_game SET last_played = strftime('%s','now') WHERE id = ?1",
                params![id],
            )?;
            Ok(())
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
        // Either a bare Steam appid or a `sgdb:<id>` reference. Both end up in
        // a URL, so both are validated as digits after the prefix rather than
        // trusted.
        if let Some(id) = app_id {
            let digits = id.strip_prefix("sgdb:").unwrap_or(id);
            if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
                return Err(format!("not a valid artwork reference: {id:?}"));
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

impl Store {
    pub fn setting(&self, key: &str) -> Result<Option<String>, String> {
        self.with(|c| {
            c.query_row(
                "SELECT value FROM setting WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
        })
    }

    /// Store a setting, or remove it when the value is blank.
    ///
    /// Blank-means-remove matters for the SteamGridDB key: clearing the field
    /// must actually turn the source off, not store an empty key that fails
    /// every request.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let value = value.trim();
        self.with(|c| {
            if value.is_empty() {
                c.execute("DELETE FROM setting WHERE key = ?1", params![key])?;
            } else {
                c.execute(
                    "INSERT INTO setting (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = ?2",
                    params![key, value],
                )?;
            }
            Ok(())
        })
    }

    /// Every setting, for export.
    pub fn all_settings(&self) -> Result<Vec<(String, String)>, String> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT key, value FROM setting ORDER BY key")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect()
        })
    }

    /// Write a game's user data wholesale, for import.
    ///
    /// One statement rather than four separate toggles: an import that applied
    /// favourite, hidden, title and artwork as four writes would leave a
    /// half-imported game if it failed partway.
    pub fn set_user_game(
        &self,
        game_id: &str,
        favourite: bool,
        hidden: bool,
        custom_title: Option<&str>,
        art_app_id: Option<&str>,
    ) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO user_game (game_id, favourite, hidden, custom_title, art_app_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(game_id) DO UPDATE SET
                   favourite = ?2, hidden = ?3, custom_title = ?4, art_app_id = ?5",
                params![
                    game_id,
                    i64::from(favourite),
                    i64::from(hidden),
                    custom_title,
                    art_app_id
                ],
            )?;
            Ok(())
        })
    }

    /// Hide a game, or bring it back. User data; no scanner may clear it.
    pub fn set_hidden(&self, game_id: &str, hidden: bool) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO user_game (game_id, hidden) VALUES (?1, ?2)
                 ON CONFLICT(game_id) DO UPDATE SET hidden = ?2",
                params![game_id, i64::from(hidden)],
            )?;
            Ok(())
        })
    }

    /// Remember where a game was found, so the next one nearby is found for
    /// free.
    ///
    /// Records the *grandparent* and great-grandparent of the executable, not
    /// its own directory: `E:\\Games\\Elden Ring\\Game\\eldenring.exe` means
    /// the useful root is `E:\\Games`, and scanning the game's own folder would
    /// never help find a different game.
    pub fn remember_root(&self, executable: &str) -> Result<(), String> {
        let path = std::path::Path::new(executable);
        let mut roots = Vec::new();
        // Two levels up covers `<root>/<game>/game.exe`; three covers the very
        // common `<root>/<game>/bin/game.exe`.
        if let Some(p) = path.parent().and_then(|p| p.parent()) {
            roots.push(p.to_path_buf());
            if let Some(g) = p.parent() {
                roots.push(g.to_path_buf());
            }
        }
        for root in roots {
            // A filesystem root is not a useful place to start a scan.
            if root.parent().is_none() {
                continue;
            }
            let Some(text) = root.to_str() else { continue };
            self.add_root(text)?;
        }
        Ok(())
    }

    /// A root as given, for a profile import. Importing used to go through
    /// `remember_root` with a fake file appended, which records the parent
    /// of what it is given: every export-then-import climbed each root one
    /// directory towards `/`.
    pub fn add_root(&self, path: &str) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO game_root (path, added_at)
                 VALUES (?1, strftime('%s','now'))",
                params![path],
            )?;
            Ok(())
        })
    }

    /// Most recently learned first, and capped: an unbounded list would turn
    /// an automatic lookup into a full-disk scan.
    pub fn game_roots(&self) -> Result<Vec<String>, String> {
        self.with(|c| {
            let mut stmt =
                c.prepare("SELECT path FROM game_root ORDER BY added_at DESC LIMIT 16")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Store {
        Store::in_memory()
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

    /// A hand-added game has no `localconfig.vdf` for anything to learn its
    /// last-played time from, so before `record_manual_play` existed the
    /// column stayed NULL forever and the game showed "never played" no
    /// matter how many times it had actually run.
    #[test]
    fn a_manual_game_remembers_when_it_was_last_played() {
        let s = memory();
        let id = s.add_manual_game("Hollow Knight", None).unwrap();
        assert_eq!(s.manual_games().unwrap()[0].last_played, None);

        s.record_manual_play(id).unwrap();

        let played = s.manual_games().unwrap()[0].last_played;
        assert!(played.is_some(), "last_played should be set after a play");
        assert!(played.unwrap() > 0);
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
        for bad in [
            "",
            "abc",
            "../../etc",
            "12 34",
            "1091500; DROP TABLE",
            "sgdb:",
            "sgdb:x",
        ] {
            assert!(s.set_art_source("steam:1", Some(bad)).is_err(), "{bad:?}");
        }
        // A SteamGridDB reference is the other legitimate form.
        assert!(s.set_art_source("steam:1", Some("sgdb:8452")).is_ok());
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

    #[test]
    fn a_chosen_executable_teaches_us_where_games_live() {
        let s = memory();
        s.remember_root("/Volumes/Big/Games/Elden Ring/Game/eldenring.exe")
            .unwrap();
        let roots = s.game_roots().unwrap();
        // The game's own folder is useless for finding a *different* game; its
        // parent is the one worth scanning.
        assert!(roots.contains(&"/Volumes/Big/Games/Elden Ring".to_string()));
        assert!(roots.contains(&"/Volumes/Big/Games".to_string()));
        assert!(!roots.iter().any(|r| r.ends_with("eldenring.exe")));
    }

    #[test]
    fn roots_do_not_pile_up_duplicates() {
        let s = memory();
        for game in ["A", "B", "C"] {
            s.remember_root(&format!("/games/{game}/run.exe")).unwrap();
        }
        let roots = s.game_roots().unwrap();
        assert_eq!(roots.iter().filter(|r| *r == "/games").count(), 1);
    }

    /// Scanning from a filesystem root is a full-disk walk, which is exactly
    /// what this feature exists to avoid.
    #[test]
    fn a_filesystem_root_is_never_recorded() {
        let s = memory();
        s.remember_root("/game.exe").unwrap();
        s.remember_root("/a/game.exe").unwrap();
        assert!(!s.game_roots().unwrap().contains(&"/".to_string()));
    }

    #[test]
    fn a_setting_round_trips_and_blank_removes_it() {
        let s = memory();
        assert_eq!(s.setting("sgdb_key").unwrap(), None);
        s.set_setting("sgdb_key", "  abc123  ").unwrap();
        assert_eq!(s.setting("sgdb_key").unwrap().as_deref(), Some("abc123"));
        // Clearing the field must turn the source off, not store an empty key
        // that fails every request.
        s.set_setting("sgdb_key", "   ").unwrap();
        assert_eq!(s.setting("sgdb_key").unwrap(), None);
    }
}
