//! Marquee — application entry point.
//!
//! The Rust side owns everything the webview should not: the library scan,
//! metadata, the artwork cache, gamepad input, and launching games. The
//! webview owns the interface and nothing else.

mod diag;
mod input;
mod library;
mod vdf;

use std::sync::OnceLock;
use std::time::Instant;

use tauri::Manager;

/// Process start, used as the epoch for input timestamps. The frontend pairs
/// it with `clock_sync` to measure input delivery latency against the budget
/// in docs/PLAN.md §2.
static START: OnceLock<Instant> = OnceLock::new();

fn start() -> Instant {
    *START.get_or_init(Instant::now)
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
async fn scan_library() -> library::ScanResult {
    // Off the main thread: a cold scan touches the filesystem once per
    // installed game, and docs/PLAN.md §4 says the scan never blocks the UI.
    match tauri::async_runtime::spawn_blocking(library::scan).await {
        Ok(result) => result,
        Err(e) => library::ScanResult {
            games: Vec::new(),
            providers: vec![library::ProviderResult {
                provider: "scan".into(),
                detected: true,
                games: Vec::new(),
                error: Some(format!("scan task failed: {e}")),
                took_ms: 0,
            }],
            took_ms: 0,
        },
    }
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

    tauri::Builder::default()
        .setup(move |app| {
            let status = input::spawn(app.handle().clone(), epoch);
            app.manage(status);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            clock_sync,
            diag::host_info,
            input::pad_status,
            scan_library
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Marquee");
}
