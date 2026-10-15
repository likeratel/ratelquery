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
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};

pub use error::{AppError, AppResult};

use connections::KeyringSecretStore;
use state::{AppState, TauriStateSink};

/// Upper bound for closing MySQL pools on exit; running queries are not waited for longer.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// Closes open MySQL sessions so their connections end cleanly instead of being dropped.
fn close_sessions_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    tauri::async_runtime::block_on(async {
        if tokio::time::timeout(SHUTDOWN_TIMEOUT, state.mysql.shutdown_all()).await.is_err() {
            eprintln!(
                "MySQL sessions did not close within {}s; exiting anyway",
                SHUTDOWN_TIMEOUT.as_secs()
            );
        }
    });
}

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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                close_sessions_on_exit(app);
            }
        });
}
