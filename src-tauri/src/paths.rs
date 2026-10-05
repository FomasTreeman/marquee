//! Where Marquee keeps its own files. No AppHandle needed, so anything can
//! find them at any point in startup.

use std::path::PathBuf;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// Durable application data: the library, user data, settings. Redirected
/// under test so a test run never touches a real user's database.
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

/// Rebuildable data only. Kept apart from `data_dir` so clearing the cache
/// can never delete anything the user authored.
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

    #[test]
    fn data_and_cache_are_never_the_same_place() {
        assert_ne!(data_dir(), cache_dir());
        assert!(!data_dir().starts_with(cache_dir()));
        assert!(!cache_dir().starts_with(data_dir()));
    }

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
        // A file where a directory should be.
        let f = std::env::temp_dir().join("marquee-paths-blocker");
        std::fs::write(&f, b"x").unwrap();
        assert!(ensure(&f.join("child")).is_err());
        std::fs::remove_file(&f).ok();
    }
}
