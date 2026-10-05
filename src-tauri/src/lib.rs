//! Marquee's Rust core: library scan, metadata, artwork cache, gamepad input
//! and launching. The webview owns only the interface.

mod art;
mod autostart;
mod diag;
mod input;
mod library;
mod locate;
pub mod log;
mod meta;
mod paths;
mod profile;
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

/// Process start, the epoch for input timestamps. See `clock_sync`.
static START: OnceLock<Instant> = OnceLock::new();

fn start() -> Instant {
    *START.get_or_init(Instant::now)
}

/// Base URL for cached artwork. Tauri serves custom schemes as
/// `http://art.localhost/` on Windows and `art://` elsewhere.
#[tauri::command]
fn art_url_base() -> String {
    if cfg!(target_os = "windows") {
        "http://art.localhost/".into()
    } else {
        "art://localhost/".into()
    }
}

/// The last scan, so commands resolve a game by id rather than trusting the
/// interface's copy.
#[derive(Default)]
struct Library(Mutex<Vec<library::Game>>);

/// Start a game, returning the URI or executable used so the interface can
/// say what is happening.
#[tauri::command]
async fn launch_game(
    app: tauri::AppHandle,
    window: tauri::Window,
    id: String,
    library: tauri::State<'_, Library>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<String, String> {
    let game = {
        let games = library.0.lock().map_err(|_| "library state is poisoned")?;
        games.iter().find(|g| g.id == id).cloned()
    };
    let game = game.ok_or_else(|| format!("no game with id {id}"))?;
    // Off the UI thread: checking for Steam spawns `pgrep` on macOS and Linux.
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || launch(app, window, game, &store))
        .await
        .map_err(|e| format!("the launch thread died: {e}"))?
}

/// How long to wait before checking a restore took: the calls are queued to
/// the UI thread, and Windows is slow to hand back the foreground.
const RESTORE_CHECK: std::time::Duration = std::time::Duration::from_secs(1);

/// Restore the window after a game and log whether it actually came back.
///
/// `unminimize` returns Ok once queued, so the log could not tell a refused
/// restore from one never attempted (#63, #90). Retries once because Windows
/// often refuses the foreground while a fullscreen game tears down.
fn restore_window(window: &tauri::Window) {
    log_info!("run", "restoring the window");
    for attempt in 1..=2 {
        log_if_err!("run", window.unminimize(), "restoring the window");
        log_if_err!("run", window.set_focus(), "focusing the window");
        std::thread::sleep(RESTORE_CHECK);
        match window.is_minimized() {
            Ok(false) => {
                log_info!("run", "the window is back (attempt {attempt})");
                return;
            }
            Ok(true) => log_warn!(
                "run",
                "the window is still minimised after asking to restore it (attempt {attempt})"
            ),
            Err(e) => {
                log_warn!("run", "could not tell whether the window came back: {e}");
                return;
            }
        }
    }
}

fn launch(
    app: tauri::AppHandle,
    window: tauri::Window,
    game: library::Game,
    store: &store::Store,
) -> Result<String, String> {
    let id = game.id.clone();
    // A successful spawn says nothing about whether the game ran, so failures
    // are reported after the fact.
    let title = game.title.clone();
    let notify = {
        // A failure toast behind a minimised window is never seen.
        let window = window.clone();
        move |detail: String| {
            // The only listener is the webview; a closed one is not an error.
            let _ = app.emit(
                "launch-failed",
                serde_json::json!({ "title": title, "detail": detail }),
            );
            restore_window(&window);
        }
    };
    // Nothing else restores the window, so it stayed minimised after the game
    // quit (#63).
    let on_exit = {
        let window = window.clone();
        move || restore_window(&window)
    };
    // Lets the interface warn that a cold Steam takes several seconds.
    let steam_cold = game.provider == "steam" && !library::steam::Steam::is_running();

    // A fullscreen launcher in front of a starting game hides it, and people
    // press Play again.
    let minimise = store
        .setting("minimise_on_launch")
        .ok()
        .flatten()
        .map(|v| v != "0")
        .unwrap_or(true);

    match run::start(&game, notify, on_exit) {
        Ok(run::Launch::Uri(uri)) => {
            if minimise {
                log_if_err!("run", window.minimize(), "minimising for the launch");
            }
            Ok(if steam_cold {
                format!("{uri} (starting Steam first)")
            } else {
                uri
            })
        }
        Ok(run::Launch::Process { program, .. }) => {
            // Steam records last-played itself; for a manual game this is the
            // only chance to.
            if let Some(row_id) = id.strip_prefix("manual:").and_then(|s| s.parse().ok()) {
                if let Err(e) = store.record_manual_play(row_id) {
                    log_warn!("run", "could not record last-played for {id}: {e}");
                }
            }
            if minimise {
                log_if_err!("run", window.minimize(), "minimising for the launch");
            }
            Ok(program.display().to_string())
        }
        Err(e) => {
            log_error!("run", "could not launch {}: {e}", game.title);
            Err(e)
        }
    }
}

/// Add a game by name. The executable is set separately, via
/// `set_manual_executable`.
#[tauri::command]
fn add_manual_game(
    title: String,
    steam_app_id: Option<String>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<i64, String> {
    let id = store.add_manual_game(&title, steam_app_id.as_deref())?;
    log_info!("store", "added {title:?} as manual:{id}");
    profile_changed(&store);
    Ok(id)
}

#[tauri::command]
fn set_manual_executable(
    id: i64,
    executable: Option<String>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    store.set_executable(id, executable.as_deref())?;
    // Remember the folder so later automatic lookups search it too.
    if let Some(path) = executable.as_deref() {
        if let Err(e) = store.remember_root(path) {
            log_warn!("store", "could not record a game root: {e}");
        }
    }
    profile_changed(&store);
    Ok(())
}

#[tauri::command]
fn remove_manual_game(
    id: i64,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    log_info!("store", "removed manual:{id}");
    let out = store.remove_manual_game(id);
    profile_changed(&store);
    out
}

/// Borrow artwork from a different appid, or None to undo. For games with no
/// cover on the CDN or matched to the wrong entry.
#[tauri::command]
fn set_art_source(
    game_id: String,
    app_id: Option<String>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    log_info!("store", "artwork for {game_id} -> {app_id:?}");
    let out = store.set_art_source(&game_id, app_id.as_deref());
    profile_changed(&store);
    out
}

/// Search SteamGridDB and Steam for artwork to borrow. Steam stays in because
/// dropping it hid regional and bundled editions with different art.
#[tauri::command]
async fn search_artwork(
    term: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<Vec<search::SearchHit>, String> {
    let key = store.setting(sgdb::SETTING_KEY)?.filter(|k| !k.is_empty());
    // A Steam failure narrows the results rather than failing the search, but
    // is logged so the missing half is visible.
    let steam = search::search_steam_hits(term.clone())
        .await
        .unwrap_or_else(|e| {
            log_warn!("art", "Steam search for {term:?} failed: {e}");
            Vec::new()
        });

    let Some(key) = key else {
        if steam.is_empty() {
            return Err("no SteamGridDB key — add one in Settings".into());
        }
        log_warn!(
            "art",
            "artwork search without a SteamGridDB key; Steam only"
        );
        return Ok(search::rank(&term, steam));
    };

    let for_sgdb = term.clone();
    let from_sgdb = tauri::async_runtime::spawn_blocking(move || {
        let client = crate::meta::http_client().ok_or("no HTTP client")?;
        Ok::<_, String>(
            sgdb::search(&client, &key, &for_sgdb)
                .into_iter()
                .map(|e| search::SearchHit {
                    source: "sgdb",
                    app_id: e.id,
                    name: e.name,
                    thumbnail: e.cover,
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))??;

    Ok(search::merge(&term, from_sgdb, steam))
}

/// A pasteable report of the platform, controller state and recent log.
/// Never sent anywhere; the user copies it if they choose.
#[tauri::command]
fn diagnostic_report(
    app: tauri::AppHandle,
    status: tauri::State<'_, std::sync::Arc<input::Status>>,
) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let pad = input::pad_status(status);

    // Writing to a String cannot fail, so every `fmt::Result` below is ignored.
    let _ = writeln!(out, "Marquee {}", app.package_info().version);
    let _ = writeln!(
        out,
        "{} {} · {}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    let _ = writeln!(out);

    let _ = writeln!(out, "-- controller --");
    let _ = writeln!(out, "backend: {}", pad.backend);
    let _ = writeln!(
        out,
        "supported: {}  connected: {}",
        pad.supported, pad.connected
    );
    if let Some(f) = &pad.failure {
        let _ = writeln!(out, "failure: {f}");
    }
    let _ = writeln!(out, "{} enumerated:", pad.backend);
    if pad.devices.is_empty() {
        let _ = writeln!(out, "  (nothing)");
    }
    for d in &pad.devices {
        let _ = writeln!(out, "  {d}");
    }
    if !pad.silenced.is_empty() {
        let _ = writeln!(
            out,
            "ignored for reporting too fast: {}",
            pad.silenced.join(", ")
        );
    }
    let _ = writeln!(out);

    let _ = writeln!(out, "-- log, last 120 lines --");
    let _ = writeln!(out, "{}", log::tail(120));
    out
}

/// Toggle fullscreen and remember it, returning the new state.
#[tauri::command]
fn toggle_fullscreen(
    window: tauri::Window,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    // Absent means first run, which should be fullscreen, so windowed is "0".
    store.set_setting("fullscreen", if next { "1" } else { "0" })?;
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
    // Allowlisted so the interface cannot overwrite arbitrary settings, such as
    // the SteamGridDB key or profile folder.
    const ALLOWED: &[&str] = &[
        "sort",
        "fullscreen",
        "minimise_on_launch",
        "background_style",
    ];
    if !ALLOWED.contains(&key.as_str()) {
        return Err(format!("not a settable preference: {key}"));
    }
    let out = store.set_setting(&key, &value);
    profile_changed(&store);
    out
}

#[tauri::command]
fn set_custom_title(
    game_id: String,
    title: Option<String>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    let out = store.set_custom_title(&game_id, title.as_deref());
    profile_changed(&store);
    out
}

/// Settings the interface can read.
#[tauri::command]
fn get_settings(
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "steamgriddbKey": store.setting(sgdb::SETTING_KEY)?.unwrap_or_default(),
        "sort": store.setting("sort")?.unwrap_or_default(),
        "profileFolder": store.setting(profile::FOLDER_SETTING)?.unwrap_or_default(),
        "minimiseOnLaunch": store.setting("minimise_on_launch")?.map(|v| v != "0").unwrap_or(true),
        // Blank resolves to grain; see resolveBackgroundStyle in src/perf.ts.
        "backgroundStyle": store.setting("background_style")?.unwrap_or_default(),
        // The update version last declined, so it is not offered every launch.
        "updateDeclined": store.setting("updateDeclined")?.unwrap_or_default(),
        // Read from the registry so it reflects changes made in Task Manager.
        "startOnLogin": autostart::is_enabled(),
    }))
}

/// Add or remove Marquee from the Windows startup list. See `autostart.rs`.
#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    autostart::set_enabled(enabled)
}

/// Set the SteamGridDB key and clear the artwork cache, whose recorded misses
/// would otherwise stop the new key helping the games that need it.
#[tauri::command]
async fn set_steamgriddb_key(
    key: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    store.set_setting(sgdb::SETTING_KEY, &key)?;
    let store = store.inner().clone();
    // Deleting thousands of files would stall the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        profile_changed(&store);
        match art::clear_cache() {
            Ok(()) => log_info!("art", "artwork cache cleared after a source change"),
            Err(e) => log_warn!("art", "could not clear the artwork cache: {e}"),
        }
    })
    .await
    .map_err(|e| format!("the cache-clearing thread died: {e}"))
}

/// Quit, minimise, restart or shut down. The interface asks for confirmation;
/// here the action is parsed against a closed set, never passed to a shell.
#[tauri::command]
fn system_action(window: tauri::Window, action: String) -> Result<(), String> {
    let parsed =
        system::Action::parse(&action).ok_or_else(|| format!("unknown action: {action}"))?;
    if parsed.affects_the_machine() {
        // So someone who finds their machine off can see why.
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

/// Hide or show a game. Stored as user data, so it survives rescans.
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
    let out = store.set_hidden(&game_id, hidden);
    profile_changed(&store);
    out
}

/// Uninstall a game. Steam games are handed to Steam; a hand-added game just
/// forgets its executable and keeps the entry.
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

/// Ask Steam to download a pending update. `steam://install` queues updates
/// as well as installs; Marquee never downloads anything itself.
#[tauri::command]
fn update_game(id: String, library: tauri::State<'_, Library>) -> Result<String, String> {
    let game = {
        let games = library.0.lock().map_err(|_| "library state is poisoned")?;
        games.iter().find(|g| g.id == id).cloned()
    }
    .ok_or_else(|| format!("no game with id {id}"))?;

    if game.provider != "steam" {
        return Err(format!("cannot update a {} game", game.provider));
    }
    let uri = format!("steam://install/{}", game.provider_id);
    run::open_uri(&uri)?;
    log_info!("run", "handed {} to Steam to update", game.title);
    Ok(uri)
}

/// Open the game's store page in the Steam client. Getting back to Marquee
/// from there (#108) would mean controlling Steam's overlay, so is out of scope.
#[tauri::command]
fn view_in_store(id: String, library: tauri::State<'_, Library>) -> Result<String, String> {
    let game = {
        let games = library.0.lock().map_err(|_| "library state is poisoned")?;
        games.iter().find(|g| g.id == id).cloned()
    }
    .ok_or_else(|| format!("no game with id {id}"))?;

    if game.provider != "steam" {
        return Err(format!(
            "cannot open a store page for a {} game",
            game.provider
        ));
    }
    let uri = format!("steam://store/{}", game.provider_id);
    run::open_uri(&uri)?;
    log_info!("run", "opened the Steam store page for {}", game.title);
    Ok(uri)
}

/// Rewrite the configured profile copy after every change. Not debounced, as
/// it is a few kilobytes; a write failure is logged, never fatal.
fn profile_changed(store: &store::Store) {
    profile::auto_export(store);
}

/// Write the profile to a path the user chose.
#[tauri::command]
fn export_profile(
    path: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    profile::write(&store, std::path::Path::new(&path))
}

/// Read a profile and merge it in.
#[tauri::command]
fn import_profile(
    path: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<profile::ImportSummary, String> {
    let loaded = profile::read(std::path::Path::new(&path))?;
    profile::apply(&store, &loaded)
}

/// Look for an existing profile on first run, e.g. beside games on a drive
/// that survived a reinstall.
#[tauri::command]
fn find_profile(
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<Option<String>, String> {
    Ok(profile::discover(&store).map(|p| p.display().to_string()))
}

/// Set the folder an up-to-date copy is kept in, and write one now.
#[tauri::command]
fn set_profile_folder(
    folder: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<(), String> {
    store.set_setting(profile::FOLDER_SETTING, &folder)?;
    if !folder.trim().is_empty() {
        profile::write(
            &store,
            &std::path::Path::new(&folder).join(profile::FILENAME),
        )?;
    }
    Ok(())
}

#[tauri::command]
fn toggle_favourite(
    game_id: String,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<bool, String> {
    let out = store.toggle_favourite(&game_id);
    profile_changed(&store);
    out
}

/// Trivial on purpose, to measure IPC round-trip time alone.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Scan every library provider. The per-provider report lets one failed store
/// show as a warning rather than an unexplained empty library.
#[tauri::command]
async fn scan_library(
    library: tauri::State<'_, Library>,
    store: tauri::State<'_, std::sync::Arc<store::Store>>,
) -> Result<library::ScanResult, String> {
    // A cold scan touches the disk per game; it must not block the UI.
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

/// Milliseconds since the input epoch, which the frontend pairs with
/// `performance.now()` to measure input latency.
#[tauri::command]
fn clock_sync() -> f64 {
    start().elapsed().as_secs_f64() * 1000.0
}

pub fn run() {
    let epoch = start();
    log::banner(diag::host_info().webview);

    // Log panics; otherwise the app vanishes with the reason on unseen stderr.
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log_error!("panic", "{info}");
        default_panic(info);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The plugin checks the bundle signature against the public key in
        // tauri.conf.json, so a compromised host cannot install anything.
        // See docs/UPDATES.md.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // To restart after an update.
        .plugin(tauri_plugin_process::init())
        // Artwork comes from a local cache, so it works offline and each asset
        // is fetched once. Async because a cache miss goes to the CDN.
        .register_asynchronous_uri_scheme_protocol("art", |app, request, responder| {
            // `art://localhost/<source>-<id>/<kind>`, source `steam` or `sgdb`.
            let path = request.uri().path().trim_matches('/').to_string();
            let app = app.app_handle().clone();
            // This closure runs on the UI thread and a scroll fires hundreds of
            // requests, so all disk work goes to the blocking pool.
            tauri::async_runtime::spawn_blocking(move || {
                // Read per request so a newly set key applies at once.
                let sgdb_key = app
                    .try_state::<std::sync::Arc<store::Store>>()
                    .and_then(|s| s.setting(sgdb::SETTING_KEY).ok().flatten());

                let mut parts = path.split('/');
                let key = parts.next().and_then(art::SourceKey::parse);
                let kind = parts.next().and_then(art::Kind::parse);

                let response = match (key, kind) {
                    (Some(key), Some(kind)) => {
                        match art::fetch(&key, kind, sgdb_key.as_deref()) {
                            Some(bytes) => tauri::http::Response::builder()
                                .header("Content-Type", kind.mime())
                                // Keyed by source and id, so never stale.
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
                // Only fails on a malformed header, and these are constants.
                if let Ok(response) = response {
                    responder.respond(response);
                }
            });
        })
        .setup(move |app| {
            // Fail at startup rather than as a confusing error later.
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
            // Before anything draws, or art cached by an older pipeline is
            // served and never re-resolved.
            art::migrate_cache();
            // Fullscreen by default. The window starts hidden and is shown once
            // the mode is set, so it does not flash the other mode.
            if let Some(w) = app.get_webview_window("main") {
                let store = app.state::<std::sync::Arc<store::Store>>();
                let windowed = store
                    .setting("fullscreen")
                    .ok()
                    .flatten()
                    .is_some_and(|v| v == "0");
                if windowed {
                    log_if_err!("window", w.set_fullscreen(false), "leaving fullscreen");
                }
                log_if_err!("window", w.show(), "showing the window");
                log_if_err!("window", w.set_focus(), "focusing the window");

                // Keep the display awake only while focused with a pad
                // connected; keyboard and mouse input already counts as activity.
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
            diagnostic_report,
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
            set_autostart,
            system_action,
            set_hidden,
            uninstall_game,
            update_game,
            view_in_store,
            export_profile,
            import_profile,
            find_profile,
            set_profile_folder,
            art::artwork_report,
            search_artwork
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Marquee");
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    fn rust_sources(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(rust_sources(&path));
            } else if path.extension().is_some_and(|e| e == "rs") {
                found.push(path);
            }
        }
        found
    }

    /// CI runs `cargo test --lib` to save a link on Windows, which silently
    /// skips tests in main.rs, integration tests and doc tests.
    #[test]
    fn no_test_hides_where_cargo_test_lib_would_not_look() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));

        let main = fs::read_to_string(root.join("src/main.rs")).unwrap();
        assert!(
            !main.contains("#[test]"),
            "src/main.rs has a test; CI runs `cargo test --lib`, which never \
             builds the binary's harness. Move it into the library."
        );

        let integration = rust_sources(&root.join("tests"));
        assert!(
            integration.is_empty(),
            "integration tests CI would not run: {integration:?}. Move them \
             into the library, or drop `--lib` from .github/workflows/ci.yml."
        );

        for path in rust_sources(&root.join("src")) {
            let source = fs::read_to_string(&path).unwrap();
            let mut open_fence: Option<String> = None;
            for line in source.lines() {
                let line = line.trim_start();
                let Some(doc) = line
                    .strip_prefix("///")
                    .or_else(|| line.strip_prefix("//!"))
                else {
                    continue;
                };
                let Some(info) = doc.trim().strip_prefix("```") else {
                    continue;
                };
                match open_fence.take() {
                    Some(_) => {}
                    // A fence is a doc test unless tagged as another language.
                    None if info.is_empty() || info.contains("rust") => {
                        panic!(
                            "{} has a doc test, and `cargo test --lib` runs no doc tests",
                            path.display()
                        )
                    }
                    None => open_fence = Some(info.to_string()),
                }
            }
        }
    }
}
