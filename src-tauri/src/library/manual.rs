//! Games added by hand — everything that is not Steam.
//!
//! Epic, GOG, EA, Ubisoft, emulators, a decade-old installer: one code path
//! instead of five undocumented per-store parsers, which is why there is no EA
//! integration here to break.
//!
//! A game is added by **name** (see `search.rs`) and is complete the moment it
//! is identified. Its executable is set separately and later, so it appears in
//! the library looking finished before anything is known about where it lives
//! on disk.

use std::path::PathBuf;

use super::{Game, LibraryProvider};
use crate::store::Store;

pub struct Manual<'a>(pub &'a Store);

impl LibraryProvider for Manual<'_> {
    fn id(&self) -> &'static str {
        "manual"
    }

    /// Always present. Unlike a store, this provider cannot be "not installed"
    /// -- it is the escape hatch that works when nothing else does.
    fn detect(&self) -> bool {
        true
    }

    fn scan(&self) -> Result<Vec<Game>, String> {
        Ok(self
            .0
            .manual_games()?
            .into_iter()
            .map(|m| Game {
                id: format!("manual:{}", m.id),
                provider: "manual".into(),
                // The Steam appid when the game was identified through search,
                // which is what lets it borrow artwork and metadata. Falls back
                // to the row id so the field is never empty.
                provider_id: m.steam_app_id.clone().unwrap_or_else(|| m.id.to_string()),
                title: m.title,
                // "Installed" here means playable: we know where it is.
                installed: m.executable.is_some(),
                update_available: false,
                updating: false,
                install_dir: m.executable.map(PathBuf::from),
                size_bytes: 0,
                last_played: m.last_played.and_then(|t| u64::try_from(t).ok()),
                playtime_minutes: 0,
                favourite: false,
                hidden: false,
                art_app_id: None,
            })
            .collect())
    }
}
