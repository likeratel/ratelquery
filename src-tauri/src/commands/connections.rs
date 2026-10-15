use std::sync::Arc;

use tauri::State;

use crate::connections::{
    ConnectionConfig, ConnectionTestResult, ConnectionsService, probe_dynamodb, probe_mysql,
    validate_config,
};
use crate::error::AppResult;
use crate::state::AppState;
use crate::util::run_blocking;

/// Runs a call on the connections service (config file and secret store I/O) on the blocking
/// pool.
async fn blocking<T, F>(state: &AppState, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&ConnectionsService) -> AppResult<T> + Send + 'static,
{
    let connections = Arc::clone(&state.connections);
    run_blocking(move || work(&connections)).await
}

#[tauri::command]
pub async fn connections_list(state: State<'_, AppState>) -> AppResult<Vec<ConnectionConfig>> {
    blocking(&state, |c| c.list()).await
}

#[tauri::command]
pub async fn connections_save(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    secret: Option<String>,
) -> AppResult<ConnectionConfig> {
    let saved = blocking(&state, move |c| c.save(&config, secret.as_deref())).await?;
    // A cached DynamoDB client would keep the old region, endpoint or credentials.
    state.dynamo.remove(saved.id()).await;
    Ok(saved)
}

/// Closes any open session first (without waiting for running queries), then removes the
/// stored secret and the config.
#[tauri::command]
pub async fn connections_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.mysql.disconnect(&id).await;
    state.dynamo.remove(&id).await;
    blocking(&state, move |c| c.delete(&id)).await
}

#[tauri::command]
pub async fn connections_has_secret(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    blocking(&state, move |c| c.has_secret(&id)).await
}

#[tauri::command]
pub async fn connections_test(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    secret: Option<String>,
) -> AppResult<ConnectionTestResult> {
    let config = validate_config(&config)?;
    let lookup = config.clone();
    let secret =
        blocking(&state, move |c| c.resolve_test_secret(&lookup, secret.as_deref())).await?;
    match &config {
        ConnectionConfig::Mysql(c) => probe_mysql(c, secret.as_deref()).await,
        ConnectionConfig::Dynamodb(c) => probe_dynamodb(c, secret.as_deref()).await,
    }
}
