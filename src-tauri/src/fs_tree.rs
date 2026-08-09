//! One-level directory listing for the folder tree. Lazy by design: no watchers,
//! no recursion, so an idle app does no filesystem work at all.

use std::path::Path;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub exists: bool,
    pub is_dir: bool,
    pub name: String,
}

#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut out: Vec<FsEntry> = Vec::new();

    for entry in entries.flatten() {
        // file_type() avoids a second stat on Windows and never follows symlinks.
        let is_dir = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => entry.path().is_dir(),
            Ok(kind) => kind.is_dir(),
            Err(_) => continue,
        };
        out.push(FsEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir,
        });
    }

    out.sort_by(|a, b| match b.is_dir.cmp(&a.is_dir) {
        std::cmp::Ordering::Equal => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        other => other,
    });
    Ok(out)
}

/// Used to keep dropped files out of the project list and to validate saved paths.
#[tauri::command]
pub fn path_info(path: String) -> PathInfo {
    let p = Path::new(&path);
    let metadata = std::fs::metadata(p);
    PathInfo {
        exists: metadata.is_ok(),
        is_dir: metadata.map(|m| m.is_dir()).unwrap_or(false),
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            // A drive root ("D:\") has no file name.
            .unwrap_or_else(|| path.clone()),
    }
}
