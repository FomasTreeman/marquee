//! Host reporting: which webview is drawing this. A frame rate or a
//! rendering bug means nothing without knowing the engine behind it, so
//! every measurement and report is stamped with it.

use serde::Serialize;

#[derive(Serialize)]
pub struct HostInfo {
    /// "windows" | "macos" | "linux"
    pub os: &'static str,
    /// The webview actually rendering the interface. This is the axis every
    /// rendering bug in this project will turn out to lie along.
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
