//! The library.
//!
//! Two providers and only two, per docs/PLAN.md §5: **Steam**, which is
//! automated, and **manual**, which is everything else and is reached by
//! typing a game's name rather than by reverse-engineering another store.
//!
//! Providers are independent and individually fallible. One store failing
//! degrades to a visible warning against that provider and never affects the
//! others or the rest of the scan -- priority #2 is stability, and a launcher
//! that shows nothing because one parser choked is not stable.

pub mod manual;
pub mod steam;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::store::Store;

/// A game as the library knows it, before metadata or artwork.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    /// Stable across scans: `"steam:1091500"`, `"manual:7"`.
    pub id: String,
    pub provider: String,
    /// The provider's own identifier. For Steam this is the appid, which is
    /// also the key to every metadata and artwork source in §6.
    pub provider_id: String,
    pub title: String,
    pub installed: bool,
    /// Steam has content queued that has not been downloaded yet -- an update
    /// to an installed game, distinct from `installed` itself. Always false
    /// for a manual game: nothing here tracks its own version.
    #[serde(default)]
    pub update_available: bool,
    /// Steam is actively fetching or applying that content right now. See
    /// `library::steam` for how both of these are read off `StateFlags`.
    #[serde(default)]
    pub updating: bool,
    pub install_dir: Option<PathBuf>,
    pub size_bytes: u64,
    /// Unix seconds, or None if the provider does not track it.
    pub last_played: Option<u64>,
    pub playtime_minutes: u64,
    /// User-authored, from the `user_game` table. Kept on the Game so the
    /// interface never has to join two lists, but owned by a different table
    /// so no scanner can ever clear it.
    #[serde(default)]
    pub favourite: bool,
    #[serde(default)]
    pub hidden: bool,
    /// Where artwork should come from, when not from `provider_id`. User-set,
    /// and the only thing that decides which appid the art URLs are built on.
    #[serde(default)]
    pub art_app_id: Option<String>,
}

/// What a provider reports after a scan.
///
/// A failed provider returns its error here rather than propagating, so the
/// interface can say "Steam: could not read library" beside the games that did
/// come back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    pub provider: String,
    /// False when the store simply is not installed on this machine, which is
    /// not an error and should not be reported as one.
    pub detected: bool,
    pub games: Vec<Game>,
    pub error: Option<String>,
    pub took_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub games: Vec<Game>,
    pub providers: Vec<ProviderResult>,
    pub took_ms: u64,
}

pub trait LibraryProvider: Send + Sync {
    fn id(&self) -> &'static str;
    /// Is this store present on this machine at all?
    fn detect(&self) -> bool;
    fn scan(&self) -> Result<Vec<Game>, String>;
}

fn providers(store: &Store) -> Vec<Box<dyn LibraryProvider + '_>> {
    vec![Box::new(steam::Steam), Box::new(manual::Manual(store))]
}

/// Scan every provider. Never fails as a whole.
pub fn scan(store: &Store) -> ScanResult {
    let started = std::time::Instant::now();
    let mut games = Vec::new();
    let mut results = Vec::new();

    for p in providers(store) {
        let t = std::time::Instant::now();
        let detected = p.detect();
        let (found, error) = if detected {
            // A provider panicking must not take the app down with it. This is
            // the boundary docs/PLAN.md §2 promises: no panic reaches the UI.
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.scan())) {
                Ok(Ok(g)) => (g, None),
                Ok(Err(e)) => (Vec::new(), Some(e)),
                Err(_) => (Vec::new(), Some(format!("{} scanner panicked", p.id()))),
            }
        } else {
            (Vec::new(), None)
        };

        results.push(ProviderResult {
            provider: p.id().to_string(),
            detected,
            games: Vec::new(),
            error,
            took_ms: t.elapsed().as_millis() as u64,
        });
        games.extend(found);
    }

    // User flags are merged after scanning, never during it. The providers do
    // not know this table exists, which is how docs/PLAN.md §8 guarantees a
    // scanner can never clear a favourite.
    match store.user_flags() {
        Ok(flags) => {
            let by_id: std::collections::HashMap<_, _> = flags.into_iter().collect();
            for g in &mut games {
                if let Some(f) = by_id.get(&g.id) {
                    g.favourite = f.favourite;
                    g.hidden = f.hidden;
                    g.art_app_id = f.art_app_id.clone();
                    if let Some(t) = &f.custom_title {
                        g.title = t.clone();
                    }
                }
            }
        }
        Err(e) => crate::log_warn!("scan", "could not read user flags: {e}"),
    }

    // Hidden games are *not* dropped here. The interface needs them to offer a
    // way back: a hidden game with no route to unhide it is a trap. Filtering
    // is the view's job, and it has a Hidden preset for exactly this.

    // Favourites, then recently played, most played, installed, appid.
    //
    // Deliberately not alphabetical. Titles arrive progressively from the
    // metadata worker, so an alphabetical library would reshuffle itself
    // under the cursor for minutes on first run. Everything here is known the
    // instant the scan finishes, so names fill in without anything moving --
    // and it puts the games worth enriching first at the front of the queue.
    games.sort_by(|a, b| {
        b.favourite
            .cmp(&a.favourite)
            .then(b.last_played.cmp(&a.last_played))
            .then(b.playtime_minutes.cmp(&a.playtime_minutes))
            .then(b.installed.cmp(&a.installed))
            .then(a.provider_id.cmp(&b.provider_id))
    });

    ScanResult {
        games,
        providers: results,
        took_ms: started.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    /// Not an assertion — a scan of whatever is actually installed on the
    /// machine running the tests, printed so a human can sanity-check it.
    ///
    ///     cargo test real_library -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library() {
        let store = crate::store::Store::open().unwrap();
        let r = super::scan(&store);
        println!("\nscanned in {} ms", r.took_ms);
        for p in &r.providers {
            println!(
                "  {:<8} detected={} {:>4} ms {}",
                p.provider,
                p.detected,
                p.took_ms,
                p.error.as_deref().unwrap_or("")
            );
        }
        for g in &r.games {
            println!(
                "  {:<10} {:<40} installed={} {:>8} MB",
                g.provider_id,
                g.title,
                g.installed,
                g.size_bytes / 1_048_576
            );
        }
        println!("{} games\n", r.games.len());
    }
}
