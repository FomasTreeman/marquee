use std::path::Path;

fn main() {
    // `generate_context!` embeds the frontend, but cargo does not track it, so
    // a stale interface once shipped. Every file is declared, since editing a
    // file does not change its parent directories' mtimes.
    if let Some(dist) = frontend_dist() {
        watch(&dist);
    }

    tauri_build::build()
}

/// Read `frontendDist` from tauri.conf.json so the two cannot disagree.
fn frontend_dist() -> Option<std::path::PathBuf> {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let conf = std::fs::read_to_string("tauri.conf.json").ok()?;
    let value: serde_json::Value = serde_json::from_str(&conf).ok()?;
    let relative = value.get("build")?.get("frontendDist")?.as_str()?;
    Some(Path::new(relative).to_path_buf())
}

fn watch(path: &Path) {
    let Ok(entries) = std::fs::read_dir(path) else {
        // Absent before the first frontend build; watch for it appearing.
        println!("cargo:rerun-if-changed={}", path.display());
        return;
    };
    println!("cargo:rerun-if-changed={}", path.display());
    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() {
            watch(&child);
        } else {
            println!("cargo:rerun-if-changed={}", child.display());
        }
    }
}
