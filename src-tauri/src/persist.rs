//! Projects and layout live in one JSON file under the app config directory.
//! The frontend owns the schema; this side only moves bytes.

use tauri::{AppHandle, Manager};

/*
 * 개발 빌드는 다른 파일을 쓴다.
 *
 * 설치본과 `tauri dev` 는 identifier 가 같아서 같은 설정 디렉토리를 본다. 그래서
 * 검사 하네스가 state.json 을 지우면 **설치본에 등록해 둔 프로젝트 목록이 함께
 * 사라졌다** (2026-08-09 실제 사고). 파일 이름을 갈라 두면 개발 쪽에서 무엇을 하든
 * 설치본 설정에 닿지 않는다.
 */
fn state_file() -> &'static str {
    if cfg!(debug_assertions) {
        "state.dev.json"
    } else {
        "state.json"
    }
}

fn state_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join(state_file()))
}

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = state_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(json) => Ok(Some(json)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 본 파일이 없으면 마지막 백업으로 되살린다. 사람이 실수로 지웠을 때
            // 프로젝트 목록을 통째로 잃는 것보다 한 세대 전 상태가 낫다.
            let backup = path.with_extension("json.bak");
            match std::fs::read_to_string(&backup) {
                Ok(json) => Ok(Some(json)),
                Err(_) => Ok(None),
            }
        }
        Err(e) => Err(format!("read state: {e}")),
    }
}

#[tauri::command]
pub fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    let path = state_path(&app)?;

    // 직전 상태를 한 세대 남긴다. 실패해도 저장은 계속한다 — 백업은 보너스지,
    // 이것 때문에 지금 저장이 막히면 안 된다.
    if path.exists() {
        let _ = std::fs::copy(&path, path.with_extension("json.bak"));
    }

    // Write-then-rename so a crash mid-write cannot leave a truncated state file.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json.as_bytes()).map_err(|e| format!("write state: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| format!("replace state: {e}"))
}
