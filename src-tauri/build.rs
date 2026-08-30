use std::path::Path;

fn main() {
    // Cargo does not know the interface is an input.
    //
    // `generate_context!` compiles the built frontend into the binary, but
    // nothing tells cargo that. So rebuilding the frontend and then building
    // the crate produces a binary with the *previous* interface embedded, and
    // reports success: a stale build that looks identical to a fresh one. That
    // shipped once, silently, and was only caught by checking the asset hash
    // inside the executable.
    //
    // Directory mtimes are not enough either: changing a file's contents does
    // not touch the mtime of every directory above it. So every file is
    // declared individually.
    if let Some(dist) = frontend_dist() {
        watch(&dist);
    }

    tauri_build::build()
}

/// Read `frontendDist` from tauri.conf.json rather than assuming `../dist`, so
/// the two cannot disagree.
fn frontend_dist() -> Option<std::path::PathBuf> {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let conf = std::fs::read_to_string("tauri.conf.json").ok()?;
    let value: serde_json::Value = serde_json::from_str(&conf).ok()?;
    let relative = value.get("build")?.get("frontendDist")?.as_str()?;
    Some(Path::new(relative).to_path_buf())
}

fn watch(path: &Path) {
    let Ok(entries) = std::fs::read_dir(path) else {
        // Absent before the first frontend build. Declaring the directory means
        // cargo notices when it appears.
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
