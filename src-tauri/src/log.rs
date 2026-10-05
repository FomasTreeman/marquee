//! Logging for both runtimes. Rust output and the webview's console go to one
//! file, in order, tagged by source, since by default the webview's console
//! goes nowhere.

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

/// A plain platform path, not from the AppHandle, so logging works before
/// Tauri has finished starting.
fn log_dir() -> PathBuf {
    // Keep `cargo test` output out of a running app's log.
    if cfg!(test) {
        return std::env::temp_dir().join("marquee-test-logs");
    }

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

/// Roll the file over past this size, keeping one previous file.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

// Big enough to hold a session, small enough to be a real bound.
const _: () = assert!(MAX_BYTES >= 1024 * 1024 && MAX_BYTES <= 16 * 1024 * 1024);

pub fn path() -> PathBuf {
    log_dir().join("marquee.log")
}

fn sink() -> &'static Mutex<Sink> {
    SINK.get_or_init(|| {
        let path = path();
        let file = (|| {
            std::fs::create_dir_all(path.parent()?).ok()?;
            if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
                // Nowhere to log this from inside the sink's initialiser; the
                // next launch retries the rotation.
                let _ = std::fs::rename(&path, path.with_extension("log.1"));
            }
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .ok()
        })();
        Mutex::new(Sink { file })
    })
}

fn stamp() -> String {
    // UTC time of day, without a date library.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}.{:03}", now.subsec_millis())
}

pub fn write(level: Level, source: &str, message: &str) {
    let line = format!("{} {} {:<8} {}", stamp(), level.tag(), source, message);

    if level >= Level::Warn {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }

    // Logging must never break the app, so a poisoned mutex or full disk is
    // ignored.
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

/// Log a failure the caller has decided to survive, instead of `let _ =`.
///
/// ```text
/// log_if_err!("art", std::fs::rename(&tmp, path), "caching {}", slug);
/// ```
#[macro_export]
macro_rules! log_if_err {
    ($src:expr, $expr:expr, $($arg:tt)*) => {
        if let Err(e) = $expr {
            $crate::log::write(
                $crate::log::Level::Warn,
                $src,
                &format!("{}: {e}", format_args!($($arg)*)),
            );
        }
    };
}

/// Session header: build, webview and platform.
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

/// The webview's console, forwarded to the log.
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

/// The last `lines` of the log, short enough to paste into an issue.
pub fn tail(lines: usize) -> String {
    let Ok(text) = std::fs::read_to_string(path()) else {
        return String::from("(no log file yet)");
    };
    let all: Vec<&str> = text.lines().collect();
    let from = all.len().saturating_sub(lines);
    all[from..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_level_from_the_ui_is_parsed_generously() {
        assert_eq!(Level::from("debug"), Level::Debug);
        assert_eq!(Level::from("trace"), Level::Debug);
        assert_eq!(Level::from("info"), Level::Info);
        assert_eq!(Level::from("WARN"), Level::Warn);
        assert_eq!(Level::from("Warning"), Level::Warn);
        assert_eq!(Level::from("error"), Level::Error);
        assert_eq!(Level::from("fatal"), Level::Error);
    }

    #[test]
    fn an_unknown_level_becomes_info_rather_than_disappearing() {
        assert_eq!(Level::from(""), Level::Info);
        assert_eq!(Level::from("catastrophe"), Level::Info);
    }

    /// `write` sends Warn and above to stderr, so the order matters.
    #[test]
    fn levels_order_by_severity() {
        assert!(Level::Debug < Level::Info);
        assert!(Level::Info < Level::Warn);
        assert!(Level::Warn < Level::Error);
    }

    #[test]
    fn tags_are_a_fixed_width() {
        for l in [Level::Debug, Level::Info, Level::Warn, Level::Error] {
            assert_eq!(l.tag().len(), 5, "{l} breaks the column");
        }
    }

    #[test]
    fn display_drops_the_padding() {
        assert_eq!(Level::Info.to_string(), "INFO");
        assert_eq!(Level::Error.to_string(), "ERROR");
    }

    #[test]
    fn the_timestamp_is_fixed_width() {
        let s = stamp();
        assert_eq!(s.len(), 12, "{s} is not hh:mm:ss.mmm");
        let (time, ms) = s.split_once('.').expect("a millisecond field");
        assert_eq!(ms.len(), 3);
        let parts: Vec<u32> = time
            .split(':')
            .map(|p| p.parse().expect("numeric"))
            .collect();
        assert_eq!(parts.len(), 3);
        assert!(
            parts[0] < 24 && parts[1] < 60 && parts[2] < 60,
            "{s} is not a time"
        );
    }

    #[test]
    fn the_log_path_is_absolute_and_named_for_the_app() {
        let p = path();
        assert!(p.is_absolute(), "{p:?} is relative");
        assert_eq!(p.file_name().unwrap(), "marquee.log");
        // Rotation renames onto this name.
        assert_eq!(
            p.with_extension("log.1").file_name().unwrap(),
            "marquee.log.1"
        );
    }
}
