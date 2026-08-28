//! Marquee — application entry point.
//!
//! The Rust side owns everything the webview should not: the library scan,
//! metadata, the artwork cache, gamepad input, and launching games. The
//! webview owns the interface and nothing else.

mod diag;
mod input;

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
            input::pad_status
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Marquee");
}
