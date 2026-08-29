//! Finding a game's executable, so you do not have to.
//!
//! Adding a game is one field by design (docs/PLAN.md §5), but a game with no
//! executable cannot be launched, and pointing at one by hand means knowing
//! which of forty files in a `bin/x64` directory is the real entry point. That
//! is the tedious half of the flow, and it is largely automatable: the folder
//! is usually named after the game, and the executable is usually the biggest
//! one that is not an installer or a crash reporter.
//!
//! This is a **suggestion**, never a silent decision. It proposes a path and
//! the user confirms it, because guessing wrong and launching the wrong
//! program is worse than asking.

use std::path::{Path, PathBuf};

/// Case, punctuation and spacing all vary between a store's title and the
/// folder it installs into: "Baldur's Gate 3" against "Baldurs Gate 3",
/// "S.T.A.L.K.E.R." against "STALKER". Strip everything that is not a letter
/// or a digit and compare what is left.
pub fn normalise(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Does this directory plausibly hold that game?
///
/// Containment in either direction, because a folder is as often shorter than
/// the title ("Witcher3" for "The Witcher 3: Wild Hunt") as longer.
pub fn folder_matches(title: &str, folder: &str) -> bool {
    let (t, f) = (normalise(title), normalise(folder));
    if t.is_empty() || f.is_empty() {
        return false;
    }
    // Three characters is short enough to match almost anything by accident.
    if t.len() < 4 || f.len() < 4 {
        return t == f;
    }
    t.contains(&f) || f.contains(&t)
}

/// Names that are never the game, however large the file.
///
/// Kept grouped and compact on purpose: rustfmt would put each string on its
/// own line, and thirty unlabelled lines is a worse reference than four
/// labelled groups when you are deciding whether something belongs here.
#[rustfmt::skip]
const NEVER: &[&str] = &[
    // Installers and runtimes
    "unins", "uninstall", "setup", "install", "redist", "vcredist", "directx",
    "dxsetup", "dotnet", "oalinst", "prereq",
    // Crash and telemetry companions
    "crashreport", "crashhandler", "crashpad", "reporter", "diagnostic",
    // Engine and platform subprocesses. These sit right beside the real binary
    // and are frequently larger than it -- UnrealCEFSubProcess ships with every
    // Unreal game and would otherwise win on size.
    "subprocess", "cefprocess", "helper", "eossdk", "easyanticheat", "battleye",
    // Tools
    "activation", "touchup", "cleanup", "updater", "patcher", "config",
    "settings", "benchmark",
];

/// Is this a plausible entry point?
pub fn plausible_executable(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    let stem = lower.rsplit_once('.').map(|(s, _)| s).unwrap_or(&lower);
    !NEVER.iter().any(|bad| stem.contains(bad))
}

/// Score a candidate. Higher is better.
///
/// Name similarity beats size, because a 2 GB shipping binary sitting beside a
/// 40 MB `Game.exe` is common and the small one is usually the launcher you
/// actually want.
pub fn score(title: &str, file_name: &str, size: u64) -> i64 {
    let stem = file_name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(file_name);
    let (t, f) = (normalise(title), normalise(stem));
    let mut score = 0i64;
    if !t.is_empty() && !f.is_empty() {
        if t == f {
            score += 10_000;
        } else if t.contains(&f) || f.contains(&t) {
            score += 5_000;
        }
    }
    // Size as a tiebreak only: megabytes, capped, so it can never outweigh a
    // name match.
    score + ((size / 1_048_576) as i64).min(2_000)
}

fn is_executable(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if !plausible_executable(name) {
        return false;
    }
    #[cfg(target_os = "windows")]
    return name.to_lowercase().ends_with(".exe");

    #[cfg(target_os = "macos")]
    return path.extension().map(|e| e == "app").unwrap_or(false);

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        if path
            .extension()
            .map(|e| e == "sh" || e == "AppImage")
            .unwrap_or(false)
        {
            return true;
        }
        path.is_file()
            && std::fs::metadata(path)
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
}

/// Where games usually live. Ordered by likelihood.
fn roots() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let mut out = Vec::new();

    #[cfg(target_os = "windows")]
    {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(base) = std::env::var(var) {
                let base = PathBuf::from(base);
                out.push(base.join("Epic Games"));
                out.push(base.join("EA Games"));
                out.push(base.join("Ubisoft/Ubisoft Game Launcher/games"));
                out.push(base);
            }
        }
        // Whole-drive scans are far too slow, but a `Games` folder at a drive
        // root is a near-universal convention.
        for letter in 'C'..='H' {
            out.push(PathBuf::from(format!("{letter}:\\Games")));
            out.push(PathBuf::from(format!("{letter}:\\GOG Games")));
        }
    }

    #[cfg(target_os = "macos")]
    {
        out.push(PathBuf::from("/Applications"));
        if let Some(h) = &home {
            out.push(h.join("Applications"));
            out.push(h.join("Games"));
        }
    }

    #[cfg(target_os = "linux")]
    if let Some(h) = &home {
        out.push(h.join("Games"));
        out.push(h.join(".local/share/Steam/steamapps/common"));
        out.push(h.join("GOG Games"));
    }

    let _ = &home;
    out.retain(|p| p.is_dir());
    out
}

/// Look for `title`'s executable in the usual places.
///
/// Bounded deliberately: one level of directories under each root, then at most
/// three levels inside a matching folder. An unbounded walk of Program Files
/// takes minutes and would find worse answers.
pub fn find(title: &str) -> Option<PathBuf> {
    for root in roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                // On macOS an .app *is* the answer, not a folder to look inside.
                if is_executable(&path) {
                    if let Some(n) = path.file_stem().and_then(|n| n.to_str()) {
                        if folder_matches(title, n) {
                            return Some(path);
                        }
                    }
                }
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !folder_matches(title, name) {
                continue;
            }
            if is_executable(&path) {
                return Some(path);
            }
            if let Some(found) = best_in(&path, title, 3) {
                return Some(found);
            }
        }
    }
    None
}

fn best_in(dir: &Path, title: &str, depth: usize) -> Option<PathBuf> {
    let mut best: Option<(i64, PathBuf)> = None;
    let mut subdirs = Vec::new();

    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            subdirs.push(path);
            continue;
        }
        if !is_executable(&path) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let s = score(title, name, size);
        if best.as_ref().map(|(b, _)| s > *b).unwrap_or(true) {
            best = Some((s, path));
        }
    }

    if depth > 0 {
        for sub in subdirs {
            if let Some(found) = best_in(&sub, title, depth - 1) {
                let name = found
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default();
                let size = std::fs::metadata(&found).map(|m| m.len()).unwrap_or(0);
                let s = score(title, name, size);
                if best.as_ref().map(|(b, _)| s > *b).unwrap_or(true) {
                    best = Some((s, found));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

#[tauri::command]
pub async fn find_executable(title: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || find(&title))
        .await
        .ok()
        .flatten()
        .map(|p| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_survive_punctuation_and_case() {
        assert!(folder_matches("Baldur's Gate 3", "Baldurs Gate 3"));
        assert!(folder_matches("The Witcher 3: Wild Hunt", "Witcher3"));
        assert!(folder_matches("S.T.A.L.K.E.R. 2", "STALKER 2"));
        assert!(folder_matches("Hollow Knight", "hollow_knight"));
        assert!(folder_matches("DOOM Eternal", "DOOMEternal"));
    }

    #[test]
    fn unrelated_folders_do_not_match() {
        assert!(!folder_matches("Hollow Knight", "Cyberpunk 2077"));
        assert!(!folder_matches("Hades", "Common Redistributables"));
        assert!(!folder_matches("Portal", ""));
        // Short names must match exactly, or "Ori" finds "Origin" and every
        // three-letter title matches half the disk.
        assert!(!folder_matches("Ori", "Origin"));
        assert!(folder_matches("Ori", "ori"));
    }

    #[test]
    fn installers_and_redistributables_are_never_the_game() {
        for bad in [
            "unins000.exe",
            "vcredist_x64.exe",
            "DXSetup.exe",
            "UnrealCEFSubProcess.exe",
            "CrashReportClient.exe",
            "EasyAntiCheat_Setup.exe",
            "GameUpdater.exe",
        ] {
            assert!(!plausible_executable(bad), "{bad} should be rejected");
        }
        for good in [
            "Hades.exe",
            "witcher3.exe",
            "Cyberpunk2077.exe",
            "hollow_knight.x86_64",
        ] {
            assert!(plausible_executable(good), "{good} should be accepted");
        }
    }

    /// A 2 GB shipping binary beside a 40 MB launcher named after the game is
    /// the common shape, and the small one is the one to run.
    #[test]
    fn a_name_match_beats_a_bigger_file() {
        let named = score("Hades", "Hades.exe", 40 * 1_048_576);
        let huge = score("Hades", "GameThread-Win64-Shipping.exe", 2_000 * 1_048_576);
        assert!(named > huge, "named {named} should beat huge {huge}");
    }

    #[test]
    fn size_still_breaks_ties_between_unnamed_candidates() {
        let big = score("Hades", "a.exe", 500 * 1_048_576);
        let small = score("Hades", "b.exe", 5 * 1_048_576);
        assert!(big > small);
    }

    /// Whatever it finds is a suggestion the user confirms, so a miss must be
    /// a quiet None rather than anything louder.
    #[test]
    fn a_title_that_matches_nothing_returns_none() {
        assert!(find("Zzzz No Such Game 91847").is_none());
        assert!(find("").is_none());
    }
}
