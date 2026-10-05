//! Suggests a game's executable from its title: a folder named after the game,
//! then the best-scoring executable inside it. The user confirms the result,
//! because launching the wrong program is worse than asking.

use std::path::{Path, PathBuf};

/// Lower-case letters and digits only, so "S.T.A.L.K.E.R." matches "STALKER".
pub fn normalise(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Containment either way, as a folder can be shorter than the title
/// ("Witcher3" for "The Witcher 3: Wild Hunt") or longer.
pub fn folder_matches(title: &str, folder: &str) -> bool {
    let (t, f) = (normalise(title), normalise(folder));
    if t.is_empty() || f.is_empty() {
        return false;
    }
    // Short names would match almost anything by containment.
    if t.len() < 4 || f.len() < 4 {
        return t == f;
    }
    t.contains(&f) || f.contains(&t)
}

/// Names that are never the game, however large the file. Skips rustfmt to
/// keep the labelled groups.
#[rustfmt::skip]
const NEVER: &[&str] = &[
    // Installers and runtimes
    "unins", "uninstall", "setup", "install", "redist", "vcredist", "directx",
    "dxsetup", "dotnet", "oalinst", "prereq",
    // Crash and telemetry companions
    "crashreport", "crashhandler", "crashpad", "reporter", "diagnostic",
    // Engine subprocesses, often bigger than the game (UnrealCEFSubProcess)
    "subprocess", "cefprocess", "helper", "eossdk", "easyanticheat", "battleye",
    // Tools
    "activation", "touchup", "cleanup", "updater", "patcher", "config",
    "settings", "benchmark",
];

pub fn plausible_executable(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    let stem = lower.rsplit_once('.').map(|(s, _)| s).unwrap_or(&lower);
    !NEVER.iter().any(|bad| stem.contains(bad))
}

/// Higher is better. A name match beats size, since a small `Game.exe` beside
/// a huge shipping binary is usually the one to run.
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
    // Capped so size only breaks ties and never outweighs a name match.
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

/// Where games usually live, most likely first.
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
        // Scanning whole drives is too slow; `X:\Games` is the common convention.
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

    // Only some platforms' arms read it.
    let _ = &home;
    out.retain(|p| p.is_dir());
    out
}

/// Look for `title`'s executable in the usual places. Bounded to one level
/// under each root and three inside a match; walking Program Files takes minutes.
pub fn find(title: &str, learned: &[String]) -> Option<PathBuf> {
    // Learned roots first: big collections live wherever there was room.
    let mut search: Vec<PathBuf> = learned.iter().map(PathBuf::from).collect();
    search.extend(roots());
    search.retain(|p| p.is_dir());

    for root in search {
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
pub async fn find_executable(
    title: String,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<Option<String>, String> {
    // Without the learned roots the search still runs, over the default
    // folders only -- but "not found" then means something else.
    let learned = store.game_roots().unwrap_or_else(|e| {
        crate::log_warn!("locate", "could not read the learned game roots: {e}");
        Vec::new()
    });
    let found = tauri::async_runtime::spawn_blocking(move || find(&title, &learned))
        .await
        .map_err(|e| format!("the search thread died: {e}"))?;
    Ok(found.map(|p| p.display().to_string()))
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
        // Short names must match exactly, or "Ori" finds "Origin".
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

    #[test]
    fn a_title_that_matches_nothing_returns_none() {
        assert!(find("Zzzz No Such Game 91847", &[]).is_none());
        assert!(find("", &[]).is_none());
    }

    /// Such as an unplugged drive.
    #[test]
    fn a_missing_learned_root_is_skipped() {
        let learned = vec!["/no/such/place/at/all".to_string()];
        assert!(find("Anything", &learned).is_none());
    }
}
