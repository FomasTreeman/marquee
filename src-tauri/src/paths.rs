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
/// Redirected under test for the same reason as the log directory: a test run
/// must never touch a real user's database.
///
/// Kept strictly separate from `cache_dir` so that clearing the cache can
/// never reach anything the user authored -- a mistake you cannot take back
/// once people have libraries. `store.rs` puts marquee.db here.
pub fn data_dir() -> PathBuf {
    if cfg!(test) {
        return std::env::temp_dir().join("marquee-test-data");
    }

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
    if cfg!(test) {
        return std::env::temp_dir().join("marquee-test-cache");
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    /// The split these two enforce is not recoverable once it is wrong: if
    /// user data ever lands under the cache directory, "clear the cache"
    /// deletes someone's library and there is nothing to restore it from.
    #[test]
    fn data_and_cache_are_never_the_same_place() {
        assert_ne!(data_dir(), cache_dir());
        assert!(!data_dir().starts_with(cache_dir()));
        assert!(!cache_dir().starts_with(data_dir()));
    }

    /// Both are redirected under test so a `cargo test` run can never touch
    /// the database or the artwork cache of the person running it.
    #[test]
    fn tests_are_redirected_away_from_real_user_files() {
        let tmp = std::env::temp_dir();
        assert!(
            data_dir().starts_with(&tmp),
            "{:?} escapes temp",
            data_dir()
        );
        assert!(
            cache_dir().starts_with(&tmp),
            "{:?} escapes temp",
            cache_dir()
        );
    }

    #[test]
    fn both_are_absolute_and_named() {
        for d in [data_dir(), cache_dir()] {
            assert!(d.is_absolute(), "{d:?} is relative");
            assert!(d.file_name().is_some(), "{d:?} has no leaf");
        }
    }

    #[test]
    fn ensure_is_idempotent_and_makes_the_whole_chain() {
        let deep = std::env::temp_dir().join("marquee-paths-test/a/b/c");
        std::fs::remove_dir_all(std::env::temp_dir().join("marquee-paths-test")).ok();
        ensure(&deep).expect("creates missing parents");
        ensure(&deep).expect("a second call on an existing dir is not an error");
        assert!(deep.is_dir());
        std::fs::remove_dir_all(std::env::temp_dir().join("marquee-paths-test")).ok();
    }

    #[test]
    fn ensure_reports_a_path_it_cannot_create() {
        // A file where a directory should be. Silently succeeding here is how
        // a cache write fails on every launch with nothing in the log.
        let f = std::env::temp_dir().join("marquee-paths-blocker");
        std::fs::write(&f, b"x").unwrap();
        assert!(ensure(&f.join("child")).is_err());
        std::fs::remove_file(&f).ok();
    }
}
