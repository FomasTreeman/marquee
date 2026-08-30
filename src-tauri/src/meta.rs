//! Game metadata, from Steam, with no API key.
//!
//! `store.steampowered.com/api/appdetails` needs no authentication -- see
//! docs/PLAN.md §6. Note the host: `api.steampowered.com` is the one that
//! requires a key, and we never touch it.
//!
//! Two constraints shape everything here:
//!
//!   * **Roughly 200 requests per five minutes.** A library of 213 played
//!     games cannot be fetched at once. So: one worker, one request at a time,
//!     spaced, in priority order, backing off on 429.
//!   * **It is undocumented and Valve owes us nothing.** Every response is
//!     cached to disk permanently. After the first pass the network is never
//!     touched again, so an outage or a format change is invisible to anyone
//!     with an existing library.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{log_debug, log_if_err, log_info, log_warn, paths};

/// Bump when a field is added that existing cache entries will not have.
///
/// Learned the hard way: `header_image` was added to fix artwork for recent
/// releases, but every already-cached entry deserialised it as empty, so the
/// fix silently did nothing for exactly the games that had been seen before.
/// A cache with no version is a cache that can only ever be wrong once.
const CACHE_VERSION: u32 = 2;

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
    /// The wide store capsule, at its real hashed path.
    ///
    /// Needed because the legacy `steam/apps/<id>/header.jpg` route serves a
    /// grey placeholder for newer releases while this one serves the actual
    /// image. It is the only real artwork some games expose publicly.
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
    // An entry written before a field existed is worse than no entry: it
    // answers the question wrongly and stops anything re-asking.
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
    // Write-then-rename: a half-written cache entry that parses as valid
    // JSON would be worse than no entry at all.
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

/// Marks an appid we asked about and Steam does not recognise, so the worker
/// does not ask again on every launch. Delisted games and tools land here.
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

/// The store endpoint's rate limit is per client, not per caller.
///
/// Two things now make requests: the background worker walking the library, and
/// the artwork pipeline resolving a card that is being drawn right now. Spacing
/// them independently would still add up to double the intended rate, so they
/// share one gate.
static LAST_REQUEST: Mutex<Option<std::time::Instant>> = Mutex::new(None);

fn wait_turn() {
    let mut last = match LAST_REQUEST.lock() {
        Ok(l) => l,
        // A poisoned lock must not stop metadata working; the worst case is a
        // slightly bunched pair of requests.
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

/// Fetch one game's metadata, synchronously, and cache it.
///
/// The background worker is the normal path, but the artwork pipeline needs a
/// game's hashed header URL the moment it draws a card and cannot wait several
/// minutes for the queue to reach it. Both go through here, so there is one
/// definition of what fetching means and one cache.
///
/// Returns None for a game with no store page, and caches that too.
pub enum Fetched {
    /// Boxed: the other two variants carry nothing, and an enum sized to its
    /// largest variant would make every return 208 bytes of mostly padding.
    Found(Box<Meta>),
    /// Delisted, region-locked, or a tool. Cached, so it is never re-asked.
    NoStorePage,
    /// Rate limited or offline. Deliberately not cached: recording a busy
    /// minute as "no such game" would make it permanent.
    Retry,
}

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

/// A client configured the way every request in this app should be: bounded,
/// and identifying itself honestly.
pub fn http_client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
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
    /// Queue appids, most important first. Anything already cached is skipped
    /// without touching the network.
    pub fn request(&self, app_ids: Vec<String>) {
        let _ = self.tx.send(app_ids);
    }
}

/// Start the background worker.
///
/// Runs at its own pace and emits a `meta` event per game as it lands, so the
/// interface fills in progressively instead of waiting on a batch. Never
/// blocks the scan, never blocks the UI.
pub fn spawn(app: AppHandle) -> Enricher {
    let (tx, rx) = mpsc::channel::<Vec<String>>();

    std::thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            // Identify honestly. docs/PLAN.md §11: stay on the right side of
            // "calling a public endpoint at a human rate".
            .user_agent(concat!(
                "Marquee/",
                env!("CARGO_PKG_VERSION"),
                " (game launcher)"
            ))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                log_warn!("meta", "no HTTP client, metadata disabled: {e}");
                return;
            }
        };

        let mut queue: VecDeque<String> = VecDeque::new();
        // Every reload re-requests the whole library. Without this the queue
        // grows by 215 each time and the worker spends its budget re-checking
        // things it has already answered.
        let mut queued: HashSet<String> = HashSet::new();
        let mut fetched = 0usize;

        loop {
            // Drain anything newly requested. Blocks when there is nothing
            // left to do, so an idle worker costs nothing.
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
                    // Back of the queue, not the front: a game that cannot be
                    // fetched right now must not block every game behind it.
                    log_debug!("meta", "will retry {app_id}");
                    queue.push_back(app_id);
                    std::thread::sleep(BACKOFF);
                }
            }
        }
    });

    Enricher { tx }
}

/// Ask for metadata. Returns immediately from cache when possible; otherwise
/// queues a fetch and the `meta` event arrives later.
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
