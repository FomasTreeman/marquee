//! Marquee — application entry point.
//!
//! The Rust side owns everything the webview should not: the library scan,
//! metadata, the artwork cache, gamepad input, and launching games. The
//! webview owns the interface and nothing else.

mod diag;

/// Round-trip probe for the IPC bridge, used by the Phase 0 spike to measure
/// command latency. Kept deliberately trivial so the number it produces is
/// the bridge and not the work.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping, diag::host_info])
        .run(tauri::generate_context!())
        .expect("failed to start Marquee");
}
