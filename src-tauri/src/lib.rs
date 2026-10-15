mod commands;
pub mod connections;
pub mod dynamo;
mod error;
pub mod export;
mod fsutil;
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
        .plugin(tauri_plugin_dialog::init())
        // Only for its runtime scope: the save dialog records the chosen file there and the
        // export commands check it. No fs permission is granted to the webview.
        .plugin(tauri_plugin_fs::init())
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
            commands::dynamo::dynamo_list_tables,
            commands::dynamo::dynamo_describe_table,
            commands::dynamo::dynamo_query,
            commands::dynamo::dynamo_scan,
            commands::dynamo::dynamo_get_item,
            commands::dynamo::dynamo_put_item,
            commands::dynamo::dynamo_delete_item,
            commands::dynamo::dynamo_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
