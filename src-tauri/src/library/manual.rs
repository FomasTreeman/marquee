//! Games added by hand: everything that is not Steam.
//!
//! One code path instead of a parser per store. A game is added by name (see
//! `search.rs`); its executable can be set later.

use std::path::PathBuf;

use super::{Game, LibraryProvider};
use crate::store::Store;

pub struct Manual<'a>(pub &'a Store);

impl LibraryProvider for Manual<'_> {
    fn id(&self) -> &'static str {
        "manual"
    }

    /// Always available, unlike a store.
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
                // Steam appid from search, for artwork and metadata. Empty
                // otherwise: falling back to the row id made digits look like
                // an appid, so game 10 became Counter-Strike.
                provider_id: m.steam_app_id.clone().unwrap_or_default(),
                title: m.title,
                // "Installed" means we know where the executable is.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_game_with_no_steam_entry_does_not_borrow_one_by_accident() {
        let store = Store::in_memory();
        store.add_manual_game("Some Emulator", None).unwrap();
        let games = Manual(&store).scan().unwrap();
        assert!(
            !games[0].provider_id.chars().any(|c| c.is_ascii_digit()),
            "{:?} would be taken for a Steam appid",
            games[0].provider_id
        );
    }
}
