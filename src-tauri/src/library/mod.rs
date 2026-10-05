//! The library: Steam, scanned automatically, and manual entries for
//! everything else (docs/PLAN.md §5). A failing provider becomes a warning
//! against that provider and never stops the others.

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
    /// The provider's own identifier; for Steam, the appid.
    pub provider_id: String,
    pub title: String,
    pub installed: bool,
    /// Steam has an update queued. Always false for a manual game.
    #[serde(default)]
    pub update_available: bool,
    /// Steam is downloading or applying that update now.
    #[serde(default)]
    pub updating: bool,
    pub install_dir: Option<PathBuf>,
    pub size_bytes: u64,
    /// Unix seconds, or None if the provider does not track it.
    pub last_played: Option<u64>,
    pub playtime_minutes: u64,
    /// From the `user_game` table, which no scanner writes, so a rescan
    /// cannot clear it.
    #[serde(default)]
    pub favourite: bool,
    #[serde(default)]
    pub hidden: bool,
    /// User-chosen appid to take artwork from instead of `provider_id`.
    #[serde(default)]
    pub art_app_id: Option<String>,
}

/// What a provider reports after a scan. Errors are returned here rather than
/// propagated, so the other providers' games still show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    pub provider: String,
    /// False when the store is not installed, which is not an error.
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
            // A panicking provider must not take the app down (docs/PLAN.md §2).
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

    // Merged after scanning so no provider can clear a favourite (PLAN.md §8).
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

    // Hidden games stay in the list so the view's Hidden preset can unhide them.

    // Not alphabetical: titles arrive later from the metadata worker, and an
    // alphabetical grid would reshuffle under the cursor as they did.
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
    /// Prints a scan of this machine for a human to check:
    /// `cargo test real_library -- --ignored --nocapture`
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
