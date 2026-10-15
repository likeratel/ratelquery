mod commands;
pub mod connections;
mod error;
pub mod export;
mod menu;
pub mod mysql;
mod state;

use std::sync::Arc;

use tauri::Manager;

pub use error::{AppError, AppResult};

use connections::KeyringSecretStore;
use state::{AppState, TauriStateSink};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let sink = Arc::new(TauriStateSink::new(app.handle().clone()));
            app.manage(AppState::new(&config_dir, Arc::new(KeyringSecretStore), sink));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::app_info,
            commands::connections::connections_list,
            commands::connections::connections_save,
            commands::connections::connections_delete,
            commands::connections::connections_has_secret,
            commands::connections::connections_test,
            commands::mysql::mysql_connect,
            commands::mysql::mysql_disconnect,
            commands::mysql::mysql_query,
            commands::mysql::mysql_databases,
            commands::mysql::mysql_schema,
            commands::mysql::mysql_apply_changes,
            commands::mysql::mysql_export,
            commands::export::export_rows,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
