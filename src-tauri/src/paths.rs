//! Where Marquee keeps its own files.
//!
//! Plain platform conventions with no dependency on an AppHandle, matching
//! `log.rs`, so anything can find them at any point in startup.

use std::path::PathBuf;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// Durable application data: the library, user data, settings.
///
/// Unused until the SQLite store lands. Defined now so the cache/data split is
/// established before anything writes user data into the wrong one -- that is
/// a mistake you cannot take back once people have libraries.
#[allow(dead_code)]
pub fn data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    return home().join("Library/Application Support/Marquee");

    #[cfg(target_os = "windows")]
    return std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(home)
        .join("Marquee");

    #[cfg(target_os = "linux")]
    return std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/share"))
        .join("marquee");
}

/// Everything here is rebuildable by deleting it and running again. Metadata
/// responses and, later, resized artwork. Kept separate from `data_dir` so
/// "clear the cache" can never touch anything the user authored.
pub fn cache_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    return home().join("Library/Caches/Marquee");

    #[cfg(target_os = "windows")]
    return std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(home)
        .join("Marquee/cache");

    #[cfg(target_os = "linux")]
    return std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".cache"))
        .join("marquee");
}

pub fn ensure(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}
