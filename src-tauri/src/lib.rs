mod commands;
mod fs_tree;
mod persist;
mod pty;

use pty::SessionManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionManager::new())
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
            fs_tree::read_dir,
            fs_tree::path_info,
            persist::load_state,
            persist::save_state,
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
