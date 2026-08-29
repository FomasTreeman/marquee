//! Logging and diagnostics.
//!
//! Built because a Tauri app is two runtimes and, by default, you can see
//! neither: Rust's stdout goes to whatever launched the process, and the
//! webview's console goes nowhere at all. A blank window with a swallowed
//! promise rejection looks exactly like a blank window with a layout bug.
//!
//! So everything lands in one file, in order, with a source tag:
//!
//! ```text
//! 14:22:01.412 INFO  scan     steam: 1 game in 0 ms
//! 14:22:01.418 ERROR ui       TypeError: g.providerId is undefined
//! ```
//!
//! The path is printed on startup and returned by the `log_path` command, so
//! it can always be found without knowing the platform's conventions.

use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn tag(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO ",
            Level::Warn => "WARN ",
            Level::Error => "ERROR",
        }
    }
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.tag().trim())
    }
}

impl From<&str> for Level {
    fn from(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "debug" | "trace" => Level::Debug,
            "warn" | "warning" => Level::Warn,
            "error" | "fatal" => Level::Error,
            _ => Level::Info,
        }
    }
}

struct Sink {
    file: Option<File>,
}

static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();

/// Where logs live. Deliberately a plain platform path with no dependency on
/// an AppHandle, so logging works before Tauri has finished starting -- which
/// is exactly when the interesting failures happen.
fn log_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    #[cfg(target_os = "macos")]
    return home.join("Library/Logs/Marquee");

    #[cfg(target_os = "windows")]
    return std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or(home)
        .join("Marquee/logs");

    #[cfg(target_os = "linux")]
    return std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/state"))
        .join("marquee");
}

/// Roll the file over once it passes this, keeping exactly one previous.
/// A launcher runs for hours on a television; an unbounded log is a slow leak.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

pub fn path() -> PathBuf {
    log_dir().join("marquee.log")
}

fn sink() -> &'static Mutex<Sink> {
    SINK.get_or_init(|| {
        let path = path();
        let file = (|| {
            std::fs::create_dir_all(path.parent()?).ok()?;
            if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
                let _ = std::fs::rename(&path, path.with_extension("log.1"));
            }
            OpenOptions::new().create(true).append(true).open(&path).ok()
        })();
        Mutex::new(Sink { file })
    })
}

fn stamp() -> String {
    // Wall-clock to the millisecond, without pulling in a date library for
    // one line of formatting.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}.{:03}", now.subsec_millis())
}

pub fn write(level: Level, source: &str, message: &str) {
    let line = format!("{} {} {:<8} {}", stamp(), level.tag(), source, message);

    // stderr as well as the file: when run from a terminal the developer
    // should not have to go looking.
    if level >= Level::Warn {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }

    // Logging must never be the thing that breaks the app. A poisoned mutex or
    // an unwritable disk is silently tolerated.
    if let Ok(mut s) = sink().lock() {
        if let Some(f) = s.file.as_mut() {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
    }
}

#[macro_export]
macro_rules! log_info {
    ($src:expr, $($arg:tt)*) => { $crate::log::write($crate::log::Level::Info, $src, &format!($($arg)*)) };
}
#[macro_export]
macro_rules! log_warn {
    ($src:expr, $($arg:tt)*) => { $crate::log::write($crate::log::Level::Warn, $src, &format!($($arg)*)) };
}
#[macro_export]
macro_rules! log_error {
    ($src:expr, $($arg:tt)*) => { $crate::log::write($crate::log::Level::Error, $src, &format!($($arg)*)) };
}
#[macro_export]
macro_rules! log_debug {
    ($src:expr, $($arg:tt)*) => { $crate::log::write($crate::log::Level::Debug, $src, &format!($($arg)*)) };
}

/// Announce the session. Written first so every log file is self-describing:
/// which build, which webview, which machine.
pub fn banner(webview: &str) {
    let p = path();
    write(Level::Info, "start", &"-".repeat(60));
    write(
        Level::Info,
        "start",
        &format!(
            "Marquee {} · {} · {}/{} · log {}",
            env!("CARGO_PKG_VERSION"),
            webview,
            std::env::consts::OS,
            std::env::consts::ARCH,
            p.display()
        ),
    );
}

/// The webview's console, forwarded here.
///
/// Without this, a thrown error in the frontend is invisible unless someone
/// happens to have devtools open at the moment it happens.
#[tauri::command]
pub fn log_from_ui(level: String, source: String, message: String, detail: Option<String>) {
    let level = Level::from(level.as_str());
    match detail {
        Some(d) if !d.is_empty() => write(level, &source, &format!("{message}\n    {d}")),
        _ => write(level, &source, &message),
    }
}

#[tauri::command]
pub fn log_path() -> String {
    path().display().to_string()
}
