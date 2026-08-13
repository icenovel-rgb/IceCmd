//! Thin adapters between the webview and the session registry.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use crate::pty::{spawn_session, SessionManager, SpawnConfig};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionArgs {
    pub session_id: String,
    pub cwd: String,
    pub kind: String,
    pub cols: u16,
    pub rows: u16,
    /// Absent in state written by an older build; off is the old behaviour.
    #[serde(default)]
    pub force_color: bool,
}

#[tauri::command]
pub fn create_session(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    args: CreateSessionArgs,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let id = args.session_id.clone();
    let session = spawn_session(
        app,
        SpawnConfig {
            session_id: args.session_id,
            cwd: args.cwd,
            kind: args.kind,
            cols: args.cols,
            rows: args.rows,
            force_color: args.force_color,
        },
        on_data,
    )?;
    sessions.insert(id, session);
    Ok(())
}

#[tauri::command]
pub fn write_session(
    sessions: State<'_, SessionManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    match sessions.handle(&session_id) {
        Some(handle) => handle.write(&data),
        // A pane can send input (or an automatic DSR reply) a beat before the
        // session lands in the map; dropping it is better than surfacing an error.
        None => Ok(()),
    }
}

#[tauri::command]
pub fn resize_session(
    sessions: State<'_, SessionManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    match sessions.handle(&session_id) {
        Some(handle) => handle.resize(cols, rows),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn ack_output(sessions: State<'_, SessionManager>, session_id: String, bytes: usize) {
    if let Some(handle) = sessions.handle(&session_id) {
        handle.ack(bytes);
    }
}

#[tauri::command]
pub fn kill_session(sessions: State<'_, SessionManager>, session_id: String) {
    sessions.remove(&session_id);
}

#[tauri::command]
pub fn session_alive(sessions: State<'_, SessionManager>, session_id: String) -> bool {
    sessions.is_alive(&session_id)
}

/// Frontend diagnostics land in the `tauri dev` console.
#[tauri::command]
pub fn log_line(message: String) {
    eprintln!("[fe] {message}");
}

/// Opens a folder in the OS file manager.
#[tauri::command]
pub fn open_in_file_manager(path: String) -> Result<(), String> {
    // Only a directory that actually exists. This never takes a command line, only
    // a path, so there is nothing for a crafted string to smuggle in.
    let target = std::path::Path::new(&path);
    if !target.is_dir() {
        return Err(format!("not a folder: {path}"));
    }

    #[cfg(windows)]
    let mut command = {
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(target);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg(target);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(target);
        c
    };

    // explorer.exe reports a non-zero exit even when it opened the window, so the
    // spawn succeeding is the only signal worth checking.
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open folder: {e}"))
}

/// Opens a file with whatever the OS has registered for it.
///
/// Folders are refused on purpose — those belong to `open_in_file_manager`, so
/// each command has exactly one meaning. The path arrives as a single argv entry
/// and no shell is involved, so nothing can be smuggled in alongside it; what
/// this can launch is the handler the user's own system chose for a file the
/// user pointed at in their own project tree.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if !target.is_file() {
        return Err(format!("not a file: {path}"));
    }

    #[cfg(windows)]
    // explorer.exe hands a file to its registered handler, which keeps this on the
    // same footing as open_in_file_manager: one program, one path argument.
    let mut command = {
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(target);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg(target);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(target);
        c
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open file: {e}"))
}

/// Shows a file (or folder) in the file manager with it selected.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if !target.exists() {
        return Err(format!("no such path: {path}"));
    }

    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("explorer.exe");
        // explorer.exe parses its own raw command line instead of taking argv, and
        // it only recognises `/select,` when the quotes sit around the path alone.
        // Rust's normal quoting would wrap the whole `/select,<path>` token, which
        // explorer then fails to read — visible only on paths containing a space.
        c.raw_arg(format!("/select,\"{}\"", target.display()));
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.args(["-R".as_ref(), target.as_os_str()]);
        c
    };
    // No portable "reveal" outside Windows and macOS; showing the parent folder is
    // the closest honest equivalent.
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(target.parent().unwrap_or(target));
        c
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not reveal path: {e}"))
}

/// Hands a web link to the system browser.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    // Refuse anything that is not a plain web link, so this can never be talked
    // into launching a local program.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }

    #[cfg(windows)]
    // FileProtocolHandler takes the URL as one argv entry, so there is no shell
    // quoting to get wrong.
    let mut command = {
        let mut c = std::process::Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open link: {e}"))
}
