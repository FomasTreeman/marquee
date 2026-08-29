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
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{log_debug, log_info, log_warn, paths};

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
}

fn cache_path(app_id: &str) -> PathBuf {
    paths::cache_dir()
        .join("appdetails")
        .join(format!("{app_id}.json"))
}

pub fn cached(app_id: &str) -> Option<Meta> {
    let text = std::fs::read_to_string(cache_path(app_id)).ok()?;
    serde_json::from_str(&text).ok()
}

fn store(meta: &Meta) {
    let path = cache_path(&meta.app_id);
    if let Some(dir) = path.parent() {
        let _ = paths::ensure(dir);
    }
    if let Ok(text) = serde_json::to_string(meta) {
        // Write-then-rename: a half-written cache entry that parses as valid
        // JSON would be worse than no entry at all.
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Marks an appid we asked about and Steam does not recognise, so the worker
/// does not ask again on every launch. Delisted games and tools land here.
fn store_miss(app_id: &str) {
    store(&Meta {
        app_id: app_id.to_string(),
        name: String::new(),
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
    })
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

            let url = format!("https://store.steampowered.com/api/appdetails?appids={app_id}&l=en");
            match client.get(&url).send() {
                Ok(r) if r.status().as_u16() == 429 => {
                    log_warn!("meta", "rate limited, backing off {}s", BACKOFF.as_secs());
                    queue.push_front(app_id);
                    std::thread::sleep(BACKOFF);
                    continue;
                }
                Ok(r) => match r.json::<serde_json::Value>() {
                    Ok(body) => match parse(&app_id, &body) {
                        Some(meta) => {
                            store(&meta);
                            fetched += 1;
                            if fetched % 25 == 0 {
                                log_info!("meta", "{fetched} fetched, {} queued", queue.len());
                            }
                            let _ = app.emit("meta", &meta);
                        }
                        None => {
                            // Delisted, region-locked, or a tool. Remember the
                            // miss so we never ask again.
                            log_debug!("meta", "no store page for {app_id}");
                            store_miss(&app_id);
                        }
                    },
                    Err(e) => log_warn!("meta", "bad response for {app_id}: {e}"),
                },
                Err(e) => {
                    log_warn!("meta", "request failed for {app_id}: {e}");
                    // Offline is not a permanent condition; do not cache a miss.
                }
            }

            std::thread::sleep(SPACING);
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
