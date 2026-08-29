//! Marquee — application entry point.
//!
//! The Rust side owns everything the webview should not: the library scan,
//! metadata, the artwork cache, gamepad input, and launching games. The
//! webview owns the interface and nothing else.

mod art;
mod diag;
mod input;
mod library;
mod locate;
pub mod log;
mod meta;
mod paths;
mod run;
mod search;
mod sgdb;
mod store;
mod vdf;

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use tauri::Manager;

/// Process start, used as the epoch for input timestamps. The frontend pairs
/// it with `clock_sync` to measure input delivery latency against the budget
/// in docs/PLAN.md §2.
static START: OnceLock<Instant> = OnceLock::new();

fn start() -> Instant {
    *START.get_or_init(Instant::now)
}

/// Where the interface should point an `<img>` for cached artwork.
///
/// Tauri exposes custom schemes differently per platform -- `art://` on macOS
/// and Linux, `http://art.localhost/` on Windows -- and the frontend should
/// not have to know that. It asks once.
#[tauri::command]
fn art_url_base() -> String {
    if cfg!(target_os = "windows") {
        "http://art.localhost/".into()
    } else {
        "art://localhost/".into()
    }
}

/// The last scan, kept so a launch can resolve a game by id without the
/// frontend having to send one back. The interface should never be the
/// authority on what a game is.
#[derive(Default)]
struct Library(Mutex<Vec<library::Game>>);

/// Start a game.
///
/// Returns what it did rather than just Ok, so the interface can say
/// "handing off to Steam" rather than a generic spinner -- and so the log
/// records the exact URI or executable.
#[tauri::command]
fn launch_game(id: String, library: tauri::State<'_, Library>) -> Result<String, String> {
    let game = {
        let games = library.0.lock().map_err(|_| "library state is poisoned")?;
        games.iter().find(|g| g.id == id).cloned()
    };
    let game = game.ok_or_else(|| format!("no game with id {id}"))?;
    match run::start(&game) {
        Ok(run::Launch::Uri(uri)) => Ok(uri),
        Ok(run::Launch::Process { program, .. }) => Ok(program.display().to_string()),
        Err(e) => {
            log_error!("run", "could not launch {}: {e}", game.title);
            Err(e)
        }
    }
}

/// Add a game by name.
///
/// The whole custom-game flow in one call: the interface has already searched
/// and the user has already picked, so all that is left is to record it. The
/// executable is set separately and later -- a game is complete once it is
/// identified, and locating it on disk is a different question.
#[tauri::command]
fn add_manual_game(
    title: String,
    steam_app_id: Option<String>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<i64, String> {
    let id = store.add_manual_game(&title, steam_app_id.as_deref())?;
    log_info!("store", "added {title:?} as manual:{id}");
    Ok(id)
}

#[tauri::command]
fn set_manual_executable(
    id: i64,
    executable: Option<String>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    store.set_executable(id, executable.as_deref())?;
    // Learn from it. Guessing at Program Files is worthless for a library kept
    // in a custom folder on whichever drive had room, so every executable
    // chosen by hand makes the next automatic lookup more likely to work.
    if let Some(path) = executable.as_deref() {
        if let Err(e) = store.remember_root(path) {
            log_warn!("store", "could not record a game root: {e}");
        }
    }
    Ok(())
}

#[tauri::command]
fn remove_manual_game(
    id: i64,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    log_info!("store", "removed manual:{id}");
    store.remove_manual_game(id)
}

/// Point a game's artwork at a different Steam appid, or None to undo.
///
/// The appid a game *is* is not always the appid whose artwork it should
/// borrow: a Steam release with no cover on the CDN, a game listed under a
/// different name, a hand-added copy matched to the wrong entry.
#[tauri::command]
fn set_art_source(
    game_id: String,
    app_id: Option<String>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    log_info!("store", "artwork for {game_id} -> {app_id:?}");
    store.set_art_source(&game_id, app_id.as_deref())
}

#[tauri::command]
fn set_custom_title(
    game_id: String,
    title: Option<String>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    store.set_custom_title(&game_id, title.as_deref())
}

/// Settings the interface can read. Only one so far.
#[tauri::command]
fn get_settings(
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "steamgriddbKey": store.setting(sgdb::SETTING_KEY)?.unwrap_or_default(),
    }))
}

/// Set the SteamGridDB key, and re-resolve artwork.
///
/// Clearing the artwork cache is the point rather than housekeeping: every game
/// that previously found nothing has a recorded miss, and without clearing them
/// a new key would visibly do nothing for exactly the games it was added for.
#[tauri::command]
fn set_steamgriddb_key(
    key: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    store.set_setting(sgdb::SETTING_KEY, &key)?;
    match art::clear_cache() {
        Ok(()) => log_info!("art", "artwork cache cleared after a source change"),
        Err(e) => log_warn!("art", "could not clear the artwork cache: {e}"),
    }
    Ok(())
}

#[tauri::command]
fn toggle_favourite(
    game_id: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<bool, String> {
    store.toggle_favourite(&game_id)
}

/// Round-trip probe for the IPC bridge. Deliberately trivial, so the number it
/// produces is the bridge and not the work.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Scan every library provider.
///
/// Returns whatever was found plus a per-provider report, so a store that
/// failed shows as a warning beside the games that did come back rather than
/// as an empty library with no explanation.
#[tauri::command]
async fn scan_library(
    library: tauri::State<'_, Library>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<library::ScanResult, String> {
    // Off the main thread: a cold scan touches the filesystem once per
    // installed game, and docs/PLAN.md §4 says the scan never blocks the UI.
    let store = store.inner().clone();
    let result = match tauri::async_runtime::spawn_blocking(move || library::scan(&store)).await {
        Ok(result) => {
            log_info!(
                "scan",
                "{} games in {} ms ({})",
                result.games.len(),
                result.took_ms,
                result
                    .providers
                    .iter()
                    .map(|p| format!(
                        "{}={}",
                        p.provider,
                        p.error
                            .as_deref()
                            .unwrap_or(if p.detected { "ok" } else { "absent" })
                    ))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            result
        }
        Err(e) => {
            log_error!("scan", "scan task failed: {e}");
            library::ScanResult {
                games: Vec::new(),
                providers: vec![library::ProviderResult {
                    provider: "scan".into(),
                    detected: true,
                    games: Vec::new(),
                    error: Some(format!("scan task failed: {e}")),
                    took_ms: 0,
                }],
                took_ms: 0,
            }
        }
    };

    if let Ok(mut cached) = library.0.lock() {
        cached.clone_from(&result.games);
    }
    Ok(result)
}

/// Milliseconds since the input epoch.
///
/// The frontend calls this alongside `performance.now()` to derive an offset
/// between the two clocks. It is biased by half the IPC round trip, which is
/// well under a millisecond and therefore noise against a 50 ms budget — but
/// the frontend takes the best of several samples anyway.
#[tauri::command]
fn clock_sync() -> f64 {
    start().elapsed().as_secs_f64() * 1000.0
}

pub fn run() {
    let epoch = start();
    log::banner(diag::host_info().webview);

    // A panic anywhere in the Rust core is written to the log before the
    // process dies. Otherwise the app simply vanishes and the only evidence is
    // on a stderr nobody was watching.
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log_error!("panic", "{info}");
        default_panic(info);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Artwork is served from our own cache rather than the network, so the
        // library renders offline and each asset is fetched exactly once ever.
        // Asynchronous because the first request for an asset goes out to the
        // CDN, and a blocking handler would stall the webview.
        .register_asynchronous_uri_scheme_protocol("art", |app, request, responder| {
            // Read once per request rather than captured: the key can be set
            // while the app is running, and artwork should start using it
            // immediately rather than after a restart.
            let sgdb_key = app
                .app_handle()
                .try_state::<std::sync::Arc<store::Store>>()
                .and_then(|s: tauri::State<'_, std::sync::Arc<store::Store>>| {
                    s.setting(sgdb::SETTING_KEY).ok().flatten()
                });
            // `art://localhost/<appid>/<kind>` or, on Windows,
            // `http://art.localhost/<appid>/<kind>`.
            let path = request.uri().path().trim_matches('/').to_string();
            std::thread::spawn(move || {
                let mut parts = path.split('/');
                let app_id = parts.next().unwrap_or_default().to_string();
                let kind = parts.next().and_then(art::Kind::parse);

                // An appid reaches this from a file on disk, so it is validated
                // rather than trusted -- digits only, which cannot traverse a
                // directory whatever else it tries.
                let valid = !app_id.is_empty()
                    && app_id.len() <= 12
                    && app_id.chars().all(|c| c.is_ascii_digit());

                let response = match (valid, kind) {
                    (true, Some(kind)) => match art::fetch(&app_id, kind, sgdb_key.as_deref()) {
                        Some(bytes) => tauri::http::Response::builder()
                            .header("Content-Type", kind.mime())
                            // Immutable: the cache is on disk and keyed by
                            // appid, so the webview need never revalidate.
                            .header("Cache-Control", "public, max-age=31536000, immutable")
                            .body(bytes),
                        None => tauri::http::Response::builder()
                            .status(404)
                            .body(Vec::new()),
                    },
                    _ => tauri::http::Response::builder()
                        .status(400)
                        .body(Vec::new()),
                };
                if let Ok(response) = response {
                    responder.respond(response);
                }
            });
        })
        .setup(move |app| {
            // Opened before anything else needs it. A database that cannot be
            // opened is fatal and should say so immediately rather than
            // surfacing as a confusing failure three commands later.
            match store::Store::open() {
                Ok(s) => app.manage(std::sync::Arc::new(s)),
                Err(e) => {
                    log_error!("store", "could not open the database: {e}");
                    return Err(e.into());
                }
            };
            let status = input::spawn(app.handle().clone(), epoch);
            app.manage(status);
            app.manage(meta::spawn(app.handle().clone()));
            app.manage(Library::default());
            // Before anything draws: cached art from an older pipeline would
            // otherwise answer first and no new logic would ever reach it.
            art::migrate_cache();
            log_info!("boot", "window up");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            clock_sync,
            diag::host_info,
            input::pad_status,
            scan_library,
            log::log_from_ui,
            log::log_path,
            meta::request_meta,
            launch_game,
            search::search_games,
            art_url_base,
            add_manual_game,
            set_manual_executable,
            remove_manual_game,
            toggle_favourite,
            set_art_source,
            set_custom_title,
            locate::find_executable,
            get_settings,
            set_steamgriddb_key,
            art::artwork_report
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Marquee");
}
