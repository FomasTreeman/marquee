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
mod screen;
mod search;
mod sgdb;
mod store;
mod system;
mod vdf;

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use tauri::{Emitter, Manager};

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
fn launch_game(
    app: tauri::AppHandle,
    id: String,
    library: tauri::State<'_, Library>,
) -> Result<String, String> {
    let game = {
        let games = library.0.lock().map_err(|_| "library state is poisoned")?;
        games.iter().find(|g| g.id == id).cloned()
    };
    let game = game.ok_or_else(|| format!("no game with id {id}"))?;
    // A game that dies on startup is reported after the fact, because spawn()
    // succeeding says nothing about whether the thing actually ran.
    let title = game.title.clone();
    let notify = move |detail: String| {
        let _ = app.emit(
            "launch-failed",
            serde_json::json!({ "title": title, "detail": detail }),
        );
    };
    match run::start(&game, notify) {
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

/// Search SteamGridDB by name, for the artwork picker.
///
/// Distinct from `search_games`, which searches the Steam store. That one
/// answers "which game is this"; this one answers "whose artwork should this
/// use", and they are different questions -- searching Steam could only ever
/// re-point a game at another Steam appid, which is no help when the missing
/// artwork is Steam's.
#[tauri::command]
async fn search_artwork(
    term: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<Vec<sgdb::Entry>, String> {
    let Some(key) = store.setting(sgdb::SETTING_KEY)?.filter(|k| !k.is_empty()) else {
        return Err("no SteamGridDB key — add one in Settings".into());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let client = crate::meta::http_client().ok_or("no HTTP client")?;
        Ok(sgdb::search(&client, &key, &term))
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?
}

/// Toggle fullscreen, returning the new state.
///
/// Remembered, so the app comes back the way it was left. A launcher used on a
/// television is fullscreen essentially always, and asking every launch would
/// be a poor way to treat that.
#[tauri::command]
fn toggle_fullscreen(
    window: tauri::Window,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    store.set_setting("fullscreen", if next { "1" } else { "" })?;
    log_info!("window", "fullscreen {}", if next { "on" } else { "off" });
    Ok(next)
}

/// Store a single setting. Preferences the interface owns, like sort order.
#[tauri::command]
fn set_setting(
    key: String,
    value: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    // Allowlisted rather than open: a command that writes an arbitrary key is a
    // command the interface can use to store anything anywhere, and the key
    // space is small enough to name.
    const ALLOWED: &[&str] = &["sort", "fullscreen"];
    if !ALLOWED.contains(&key.as_str()) {
        return Err(format!("not a settable preference: {key}"));
    }
    store.set_setting(&key, &value)
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
        "sort": store.setting("sort")?.unwrap_or_default(),
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

/// Quit, minimise, restart or shut down.
///
/// The last two end the user's session with everything else open in it, so the
/// interface arms them with a second press before calling this. Here the only
/// protection that matters is that the action name is parsed against a closed
/// set rather than passed to a shell.
#[tauri::command]
fn system_action(window: tauri::Window, action: String) -> Result<(), String> {
    let parsed =
        system::Action::parse(&action).ok_or_else(|| format!("unknown action: {action}"))?;
    if parsed.affects_the_machine() {
        // Logged distinctly from everything else. Someone who finds their
        // machine off and wonders why should find the line that says so.
        log_warn!("system", "ending the session: {parsed:?}");
    }
    match parsed {
        system::Action::Minimise => window.minimize().map_err(|e| e.to_string()),
        system::Action::Quit => {
            log_info!("system", "quitting");
            window.app_handle().exit(0);
            Ok(())
        }
        other => system::run(other),
    }
}

/// Hide a game from the library, or bring it back.
///
/// User data, in the table no scanner may touch, so it survives every rescan.
#[tauri::command]
fn set_hidden(
    game_id: String,
    hidden: bool,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    log_info!(
        "store",
        "{game_id} {}",
        if hidden { "hidden" } else { "shown" }
    );
    store.set_hidden(&game_id, hidden)
}

/// Uninstall a game.
///
/// For a Steam game this hands off to Steam, which owns the files and the
/// bookkeeping -- there is no version of this we should be doing ourselves. For
/// a hand-added one there is nothing to uninstall, so it forgets the
/// executable and keeps the entry.
#[tauri::command]
fn uninstall_game(
    id: String,
    library: tauri::State<'_, Library>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<String, String> {
    let game = {
        let games = library.0.lock().map_err(|_| "library state is poisoned")?;
        games.iter().find(|g| g.id == id).cloned()
    }
    .ok_or_else(|| format!("no game with id {id}"))?;

    match game.provider.as_str() {
        "steam" => {
            let uri = format!("steam://uninstall/{}", game.provider_id);
            run::open_uri(&uri)?;
            log_info!("run", "handed {} to Steam to uninstall", game.title);
            Ok(uri)
        }
        "manual" => {
            let row = id
                .split(':')
                .nth(1)
                .and_then(|n| n.parse::<i64>().ok())
                .ok_or("not a manual game id")?;
            store.set_executable(row, None)?;
            log_info!("store", "cleared the executable for {}", game.title);
            Ok("removed its executable".into())
        }
        other => Err(format!("cannot uninstall a {other} game")),
    }
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
            // Read per request rather than captured: the key can be set while
            // the app is running, and artwork should start using it at once.
            let sgdb_key = app
                .app_handle()
                .try_state::<std::sync::Arc<store::Store>>()
                .and_then(|s: tauri::State<'_, std::sync::Arc<store::Store>>| {
                    s.setting(sgdb::SETTING_KEY).ok().flatten()
                });

            // `art://localhost/<source>-<id>/<kind>`, where source is `steam`
            // or `sgdb`. Source-qualified because a game can borrow artwork
            // from a SteamGridDB entry that has no Steam appid at all.
            let path = request.uri().path().trim_matches('/').to_string();
            std::thread::spawn(move || {
                let mut parts = path.split('/');
                let key = parts.next().and_then(art::SourceKey::parse);
                let kind = parts.next().and_then(art::Kind::parse);

                let response = match (key, kind) {
                    (Some(key), Some(kind)) => {
                        match art::fetch(&key, kind, sgdb_key.as_deref()) {
                            Some(bytes) => tauri::http::Response::builder()
                                .header("Content-Type", kind.mime())
                                // Immutable: the cache is on disk and keyed by
                                // source and id, so the webview need never
                                // revalidate.
                                .header("Cache-Control", "public, max-age=31536000, immutable")
                                .body(bytes),
                            None => tauri::http::Response::builder()
                                .status(404)
                                .body(Vec::new()),
                        }
                    }
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
            // Come back the way it was left. A launcher on a television is
            // fullscreen essentially always, and asking every launch would be
            // a poor way to treat that.
            if let Some(w) = app.get_webview_window("main") {
                let store = app.state::<std::sync::Arc<store::Store>>();
                if store.setting("fullscreen").ok().flatten().is_some() {
                    let _ = w.set_fullscreen(true);
                }

                // Hold the display awake only while focused, and only when a
                // pad is connected: with a keyboard and mouse the OS already
                // sees activity, and a launcher sitting behind a running game
                // has no business keeping a screen on.
                let handle = app.handle().clone();
                w.on_window_event(move |event| match event {
                    tauri::WindowEvent::Focused(focused) => {
                        let pads = handle
                            .try_state::<std::sync::Arc<input::Status>>()
                            .map(|s: tauri::State<'_, std::sync::Arc<input::Status>>| {
                                s.connected.load(std::sync::atomic::Ordering::Relaxed)
                            })
                            .unwrap_or(0);
                        screen::keep_awake(*focused && pads > 0);
                    }
                    tauri::WindowEvent::Destroyed => screen::release_on_exit(),
                    _ => {}
                });
            }

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
            toggle_fullscreen,
            set_art_source,
            set_custom_title,
            locate::find_executable,
            get_settings,
            set_steamgriddb_key,
            set_setting,
            system_action,
            set_hidden,
            uninstall_game,
            art::artwork_report,
            search_artwork
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Marquee");
}
