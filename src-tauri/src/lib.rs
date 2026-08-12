mod commands;
mod fs_tree;
mod persist;
mod pty;
mod usage;
mod watch;

use pty::SessionManager;
use tauri::Manager;
use watch::DirWatch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionManager::new())
        .manage(DirWatch::new())
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::write_session,
            commands::resize_session,
            commands::ack_output,
            commands::kill_session,
            commands::session_alive,
            commands::log_line,
            commands::open_external,
            commands::open_in_file_manager,
            commands::open_path,
            commands::reveal_path,
            fs_tree::read_dir,
            fs_tree::path_info,
            watch::watch_dirs,
            persist::load_state,
            persist::save_state,
            usage::cli_usage,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Closing the pseudoconsoles here keeps cmd.exe/conhost.exe from
            // outliving the app.
            if let tauri::RunEvent::Exit = event {
                app.state::<SessionManager>().shutdown();
            }
        });
}
