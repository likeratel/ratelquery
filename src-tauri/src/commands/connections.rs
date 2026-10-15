use tauri::State;

use crate::connections::{
    ConnectionConfig, ConnectionTestResult, probe_dynamodb, probe_mysql, validate_config,
};
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub async fn connections_list(state: State<'_, AppState>) -> AppResult<Vec<ConnectionConfig>> {
    state.connections.list()
}

#[tauri::command]
pub async fn connections_save(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    secret: Option<String>,
) -> AppResult<ConnectionConfig> {
    state.connections.save(&config, secret.as_deref())
}

#[tauri::command]
pub async fn connections_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.mysql.disconnect(&id).await;
    state.connections.delete(&id)
}

#[tauri::command]
pub async fn connections_has_secret(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    state.connections.has_secret(&id)
}

#[tauri::command]
pub async fn connections_test(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    secret: Option<String>,
) -> AppResult<ConnectionTestResult> {
    let config = validate_config(&config)?;
    let secret = state.connections.resolve_secret(config.id(), secret.as_deref())?;
    match &config {
        ConnectionConfig::Mysql(c) => probe_mysql(c, secret.as_deref()).await,
        ConnectionConfig::Dynamodb(c) => probe_dynamodb(c, secret.as_deref()).await,
    }
}
