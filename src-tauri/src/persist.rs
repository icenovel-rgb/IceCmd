//! Projects and layout live in one JSON file under the app config directory.
//! The frontend owns the schema; this side only moves bytes.

use tauri::{AppHandle, Manager};

const STATE_FILE: &str = "state.json";

fn state_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join(STATE_FILE))
}

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = state_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(json) => Ok(Some(json)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read state: {e}")),
    }
}

#[tauri::command]
pub fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    let path = state_path(&app)?;
    // Write-then-rename so a crash mid-write cannot leave a truncated state file.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json.as_bytes()).map_err(|e| format!("write state: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| format!("replace state: {e}"))
}
