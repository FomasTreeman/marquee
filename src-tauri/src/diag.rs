//! Host reporting, so measurements and bug reports name the webview engine.

use serde::Serialize;

#[derive(Serialize)]
pub struct HostInfo {
    /// "windows" | "macos" | "linux"
    pub os: &'static str,
    /// The webview rendering the interface.
    pub webview: &'static str,
    pub arch: &'static str,
    pub version: &'static str,
    pub debug: bool,
}

#[tauri::command]
pub fn host_info() -> HostInfo {
    HostInfo {
        os: std::env::consts::OS,
        webview: if cfg!(target_os = "windows") {
            "WebView2 (Chromium)"
        } else if cfg!(target_os = "macos") {
            "WKWebView (WebKit)"
        } else {
            "WebKitGTK (WebKit)"
        },
        arch: std::env::consts::ARCH,
        version: env!("CARGO_PKG_VERSION"),
        debug: cfg!(debug_assertions),
    }
}
