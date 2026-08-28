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

pub mod steam;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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
    pub install_dir: Option<PathBuf>,
    pub size_bytes: u64,
    /// Unix seconds, or None if the provider does not track it.
    pub last_played: Option<u64>,
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

fn providers() -> Vec<Box<dyn LibraryProvider>> {
    vec![Box::new(steam::Steam::default())]
}

/// Scan every provider. Never fails as a whole.
pub fn scan() -> ScanResult {
    let started = std::time::Instant::now();
    let mut games = Vec::new();
    let mut results = Vec::new();

    for p in providers() {
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

    // Alphabetical by default. Sorting here rather than in the interface means
    // the frontend can hand the grid an index range without holding the whole
    // library, which is what §4 asks for.
    games.sort_by(|a, b| sort_key(&a.title).cmp(&sort_key(&b.title)));

    ScanResult { games, providers: results, took_ms: started.elapsed().as_millis() as u64 }
}

/// Sort "The Witcher 3" under W, and lowercase so case never splits the list.
fn sort_key(title: &str) -> String {
    let t = title.trim();
    for article in ["The ", "A ", "An "] {
        if let Some(rest) = t.strip_prefix(article) {
            return rest.to_lowercase();
        }
    }
    t.to_lowercase()
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
        let r = super::scan();
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
