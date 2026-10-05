//! Game metadata from Steam's keyless `store.steampowered.com/api/appdetails`
//! (docs/PLAN.md §6; `api.steampowered.com` needs a key and is not used).
//!
//! The endpoint allows roughly 200 requests per five minutes and is
//! undocumented, so one worker fetches serially with spacing and backoff, and
//! every response is cached on disk permanently.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{log_debug, log_if_err, log_info, log_warn, paths};

/// Bump when adding a field old cache entries lack. Without it, `header_image`
/// deserialised as empty for every game already cached.
const CACHE_VERSION: u32 = 2;

/// Retries per appid per session. A rate limit clears within a few attempts;
/// anything failing beyond that is not transient.
const MAX_RETRIES: u32 = 4;

/// 200 per 5 minutes is one per 1.5 s. Sit just outside it.
const SPACING: Duration = Duration::from_millis(1700);
/// What Valve's 429 asks for, roughly.
const BACKOFF: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub app_id: String,
    pub name: String,
    pub description: String,
    pub developers: Vec<String>,
    pub publishers: Vec<String>,
    pub release_date: String,
    pub genres: Vec<String>,
    pub score: Option<u32>,
    /// The wide store capsule at its hashed path. The legacy
    /// `steam/apps/<id>/header.jpg` serves a grey placeholder for newer releases.
    #[serde(default)]
    pub header_image: String,
    /// Schema version of this cache entry. Absent means version 1.
    #[serde(default)]
    pub v: u32,
}

fn cache_path(app_id: &str) -> PathBuf {
    paths::cache_dir()
        .join("appdetails")
        .join(format!("{app_id}.json"))
}

pub fn cached(app_id: &str) -> Option<Meta> {
    let text = std::fs::read_to_string(cache_path(app_id)).ok()?;
    let meta: Meta = serde_json::from_str(&text).ok()?;
    // An older entry lacks fields and would stop anything re-asking.
    if meta.v < CACHE_VERSION {
        return None;
    }
    Some(meta)
}

fn store(meta: &Meta) {
    let path = cache_path(&meta.app_id);
    if let Some(dir) = path.parent() {
        log_if_err!("meta", paths::ensure(dir), "cache dir {}", dir.display());
    }
    let text = match serde_json::to_string(meta) {
        Ok(t) => t,
        Err(e) => return log_warn!("meta", "encoding {}: {e}", meta.app_id),
    };
    // Write-then-rename so a crash never leaves a half-written entry.
    let tmp = path.with_extension("tmp");
    match std::fs::write(&tmp, text) {
        Ok(()) => log_if_err!(
            "meta",
            std::fs::rename(&tmp, &path),
            "caching {}",
            meta.app_id
        ),
        Err(e) => log_warn!("meta", "caching {}: {e}", meta.app_id),
    }
}

/// Record an appid Steam does not recognise (delisted games, tools) so it is
/// not re-asked on every launch.
fn store_miss(app_id: &str) {
    store(&Meta {
        app_id: app_id.to_string(),
        name: String::new(),
        v: CACHE_VERSION,
        ..Default::default()
    })
}

fn parse(app_id: &str, body: &serde_json::Value) -> Option<Meta> {
    let entry = body.get(app_id)?;
    if !entry.get("success")?.as_bool().unwrap_or(false) {
        return None;
    }
    let d = entry.get("data")?;
    let list = |key: &str| -> Vec<String> {
        d.get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    Some(Meta {
        app_id: app_id.to_string(),
        name: d.get("name")?.as_str().unwrap_or_default().to_string(),
        description: d
            .get("short_description")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        developers: list("developers"),
        publishers: list("publishers"),
        release_date: d
            .get("release_date")
            .and_then(|r| r.get("date"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        genres: d
            .get("genres")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|g| {
                        g.get("description")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    })
                    .collect()
            })
            .unwrap_or_default(),
        score: d
            .get("metacritic")
            .and_then(|m| m.get("score"))
            .and_then(|v| v.as_u64())
            .map(|n| n as u32),
        header_image: d
            .get("header_image")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        v: CACHE_VERSION,
    })
}

/// The rate limit is per client, so the worker and the artwork pipeline share
/// one spacing gate.
static LAST_REQUEST: Mutex<Option<std::time::Instant>> = Mutex::new(None);

fn wait_turn() {
    let mut last = match LAST_REQUEST.lock() {
        Ok(l) => l,
        // Worst case for a poisoned lock is two bunched requests.
        Err(e) => e.into_inner(),
    };
    if let Some(prev) = *last {
        let since = prev.elapsed();
        if since < SPACING {
            std::thread::sleep(SPACING - since);
        }
    }
    *last = Some(std::time::Instant::now());
}

/// The outcome of `fetch_one`.
pub enum Fetched {
    /// Boxed to keep the enum small; the other variants carry nothing.
    Found(Box<Meta>),
    /// Delisted, region-locked, or a tool. Cached, so it is never re-asked.
    NoStorePage,
    /// Rate limited or offline. Not cached, or a busy minute becomes permanent.
    Retry,
}

/// Fetch one game's metadata synchronously and cache it. Shared by the worker
/// and the artwork pipeline, which needs the header URL immediately.
pub fn fetch_one(client: &reqwest::blocking::Client, app_id: &str) -> Fetched {
    if let Some(meta) = cached(app_id) {
        return if meta.name.is_empty() {
            Fetched::NoStorePage
        } else {
            Fetched::Found(Box::new(meta))
        };
    }

    wait_turn();
    let url = format!("https://store.steampowered.com/api/appdetails?appids={app_id}&l=en");
    let Ok(response) = client.get(&url).send() else {
        return Fetched::Retry;
    };
    if response.status().as_u16() == 429 {
        log_warn!("meta", "rate limited fetching {app_id}");
        return Fetched::Retry;
    }
    let Ok(body) = response.json::<serde_json::Value>() else {
        return Fetched::Retry;
    };
    match parse(app_id, &body) {
        Some(meta) => {
            store(&meta);
            Fetched::Found(Box::new(meta))
        }
        None => {
            store_miss(app_id);
            Fetched::NoStorePage
        }
    }
}

/// An HTTP client with a timeout and an honest user agent (docs/PLAN.md §11).
pub fn http_client() -> Option<reqwest::blocking::Client> {
    http_client_with(Duration::from_secs(20))
}

pub fn http_client_with(timeout: Duration) -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .user_agent(concat!(
            "Marquee/",
            env!("CARGO_PKG_VERSION"),
            " (game launcher)"
        ))
        .build()
        .ok()
}

pub struct Enricher {
    tx: Sender<Vec<String>>,
}

impl Enricher {
    /// Queue appids, most important first. Cached ones skip the network.
    pub fn request(&self, app_ids: Vec<String>) {
        let _ = self.tx.send(app_ids);
    }
}

/// Requeue at the back so one failure does not block the rest, up to
/// `MAX_RETRIES` (appid 0 once retried forever and flooded the log). Giving up
/// writes nothing to the cache, or an offline first launch becomes permanent.
fn requeue(
    app_id: String,
    attempts: &mut HashMap<String, u32>,
    queue: &mut VecDeque<String>,
) -> bool {
    let tries = attempts.entry(app_id.clone()).or_insert(0);
    *tries += 1;
    if *tries > MAX_RETRIES {
        log_debug!("meta", "giving up on {app_id} after {tries} tries");
        return false;
    }
    log_debug!("meta", "will retry {app_id} ({tries})");
    queue.push_back(app_id);
    true
}

/// Start the background worker, which emits a `meta` event per game as it lands.
pub fn spawn(app: AppHandle) -> Enricher {
    let (tx, rx) = mpsc::channel::<Vec<String>>();

    std::thread::spawn(move || {
        let Some(client) = http_client() else {
            log_warn!("meta", "no HTTP client, metadata disabled");
            return;
        };

        let mut queue: VecDeque<String> = VecDeque::new();
        // Every reload re-requests the whole library; skip duplicates.
        let mut queued: HashSet<String> = HashSet::new();
        let mut attempts: HashMap<String, u32> = HashMap::new();
        let mut fetched = 0usize;

        loop {
            // Block only when idle.
            while let Some(batch) = if queue.is_empty() {
                rx.recv().ok()
            } else {
                rx.try_recv().ok()
            } {
                for id in batch {
                    if queued.insert(id.clone()) {
                        queue.push_back(id);
                    }
                }
            }
            let Some(app_id) = queue.pop_front() else {
                continue;
            };

            if let Some(meta) = cached(&app_id) {
                if !meta.name.is_empty() {
                    // Both emits: a closed webview is not an error.
                    let _ = app.emit("meta", &meta);
                }
                continue;
            }

            match fetch_one(&client, &app_id) {
                Fetched::Found(meta) => {
                    fetched += 1;
                    if fetched % 25 == 0 {
                        log_info!("meta", "{fetched} fetched, {} queued", queue.len());
                    }
                    let _ = app.emit("meta", &meta);
                }
                Fetched::NoStorePage => log_debug!("meta", "no store page for {app_id}"),
                Fetched::Retry => {
                    if requeue(app_id, &mut attempts, &mut queue) {
                        std::thread::sleep(BACKOFF);
                    }
                }
            }
        }
    });

    Enricher { tx }
}

/// Return cached metadata now and queue the rest; it arrives as `meta` events.
#[tauri::command]
pub fn request_meta(app_ids: Vec<String>, enricher: tauri::State<'_, Enricher>) -> Vec<Meta> {
    let ready: Vec<Meta> = app_ids
        .iter()
        .filter_map(|id| cached(id))
        .filter(|m| !m.name.is_empty())
        .collect();
    enricher.request(app_ids);
    ready
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A response shaped like the real one, trimmed to the fields we read.
    fn full_response() -> serde_json::Value {
        json!({
            "620": {
                "success": true,
                "data": {
                    "name": "Portal 2",
                    "short_description": "The sequel.",
                    "developers": ["Valve"],
                    "publishers": ["Valve"],
                    "release_date": { "coming_soon": false, "date": "18 Apr, 2011" },
                    "genres": [{ "id": "1", "description": "Action" },
                               { "id": "25", "description": "Adventure" }],
                    "metacritic": { "score": 95, "url": "https://example.invalid" },
                    "header_image": "https://cdn.example.invalid/620/header.jpg?t=1"
                }
            }
        })
    }

    #[test]
    fn reads_every_field_we_display() {
        let m = parse("620", &full_response()).expect("a success entry parses");
        assert_eq!(m.name, "Portal 2");
        assert_eq!(m.description, "The sequel.");
        assert_eq!(m.developers, vec!["Valve"]);
        assert_eq!(m.publishers, vec!["Valve"]);
        assert_eq!(m.release_date, "18 Apr, 2011");
        assert_eq!(m.genres, vec!["Action", "Adventure"]);
        assert_eq!(m.score, Some(95));
        assert!(m.header_image.contains("/620/header.jpg"));
    }

    /// Without it, `cached` rejects what was just written and re-fetches forever.
    #[test]
    fn stamps_the_cache_version() {
        assert_eq!(parse("620", &full_response()).unwrap().v, CACHE_VERSION);
    }

    #[test]
    fn an_unsuccessful_entry_is_none_not_a_default() {
        let body = json!({ "620": { "success": false } });
        assert!(parse("620", &body).is_none());
    }

    #[test]
    fn a_response_for_a_different_appid_is_none() {
        assert!(parse("440", &full_response()).is_none());
    }

    #[test]
    fn missing_pieces_are_empty_rather_than_a_panic() {
        let body = json!({ "42": { "success": true, "data": { "name": "Sparse" } } });
        let m = parse("42", &body).expect("a name is all we require");
        assert_eq!(m.name, "Sparse");
        assert_eq!(m.score, None);
        assert!(m.description.is_empty());
        assert!(m.developers.is_empty());
        assert!(m.publishers.is_empty());
        assert!(m.genres.is_empty());
        assert!(m.release_date.is_empty());
        assert!(m.header_image.is_empty());
    }

    #[test]
    fn an_entry_with_no_name_is_none() {
        let body = json!({ "42": { "success": true, "data": { "genres": [] } } });
        assert!(parse("42", &body).is_none());
    }

    #[test]
    fn junk_in_a_list_is_skipped_not_fatal() {
        let body = json!({ "42": { "success": true, "data": {
            "name": "Odd", "developers": ["Real", 7, null], "genres": [{ "id": "1" }]
        } } });
        let m = parse("42", &body).unwrap();
        assert_eq!(m.developers, vec!["Real"]);
        assert!(m.genres.is_empty());
    }

    #[test]
    fn a_cache_entry_from_an_older_schema_is_ignored() {
        let path = cache_path("99001");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"appId":"99001","name":"Stale"}"#).unwrap();
        assert!(cached("99001").is_none(), "a v1 entry must not be trusted");

        store(&Meta {
            app_id: "99001".into(),
            name: "Fresh".into(),
            v: CACHE_VERSION,
            ..Default::default()
        });
        assert_eq!(cached("99001").map(|m| m.name), Some("Fresh".into()));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_recorded_miss_is_remembered() {
        let path = cache_path("99002");
        store_miss("99002");
        let got = cached("99002").expect("the miss was written");
        assert!(got.name.is_empty(), "a miss is an entry with no name");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn giving_up_on_a_transient_failure_leaves_no_cache_entry() {
        // A previous run that failed this test leaves the entry behind.
        std::fs::remove_file(cache_path("99005")).ok();
        let mut attempts = HashMap::new();
        let mut queue = VecDeque::new();
        for _ in 0..=MAX_RETRIES {
            queue.clear();
            requeue("99005".into(), &mut attempts, &mut queue);
        }
        assert!(queue.is_empty(), "dropped after the last try");
        assert!(
            cached("99005").is_none(),
            "a transient failure must not become a recorded miss"
        );
    }

    #[test]
    fn unreadable_or_corrupt_cache_is_a_miss_not_a_panic() {
        let path = cache_path("99003");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ this is not json").unwrap();
        assert!(cached("99003").is_none());
        std::fs::remove_file(&path).ok();
        assert!(cached("99004-never-written").is_none());
    }
}
