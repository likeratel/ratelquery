use std::sync::Arc;

use tauri::State;

use crate::connections::{
    ConnectionConfig, ConnectionTestResult, ConnectionsService, SecretSlot, probe_athena,
    probe_dynamodb, probe_mysql_via, validate_config,
};
use crate::error::AppResult;
use crate::ssh::tunnel_request;
use crate::state::AppState;
use crate::util::run_blocking;

/// Runs a call on the connections service (config file and secret store I/O) on the blocking
/// pool.
pub(super) async fn blocking<T, F>(state: &AppState, work: F) -> AppResult<T>
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
    ssh_secret: Option<String>,
) -> AppResult<ConnectionConfig> {
    let saved = blocking(&state, move |c| {
        c.save_with_ssh(&config, secret.as_deref(), ssh_secret.as_deref())
    })
    .await?;
    // A cached AWS client would keep the old region, endpoint, workgroup or credentials.
    // Athena executions started through the old client are stopped (best effort).
    state.dynamo.remove(saved.id()).await;
    state.athena.remove(saved.id()).await;
    Ok(saved)
}

/// Closes any open session first (without waiting for running queries), then removes the
/// stored secrets (database and SSH) and the config.
#[tauri::command]
pub async fn connections_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.mysql.disconnect(&id).await;
    state.dynamo.remove(&id).await;
    // Athena executions started and not yet waited for are stopped in the background.
    state.athena.remove(&id).await;
    blocking(&state, move |c| c.delete(&id)).await
}

#[tauri::command]
pub async fn connections_has_secret(
    state: State<'_, AppState>,
    id: String,
    which: Option<SecretSlot>,
) -> AppResult<bool> {
    blocking(&state, move |c| c.has_secret_in(&id, which.unwrap_or_default())).await
}

#[tauri::command]
pub async fn connections_test(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    secret: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ConnectionTestResult> {
    let config = validate_config(&config)?;
    let lookup = config.clone();
    let (secret, ssh_secret) = blocking(&state, move |c| {
        let secret = c.resolve_test_secret(&lookup, secret.as_deref())?;
        let ssh_secret = c.resolve_test_ssh_secret(&lookup, ssh_secret.as_deref())?;
        Ok((secret, ssh_secret))
    })
    .await?;
    match &config {
        ConnectionConfig::Mysql(c) => {
            let tunnel = tunnel_request(c, ssh_secret, &state.known_hosts)?;
            probe_mysql_via(c, secret.as_deref(), tunnel.as_ref()).await
        }
        ConnectionConfig::Dynamodb(c) => probe_dynamodb(c, secret.as_deref()).await,
        ConnectionConfig::Athena(c) => probe_athena(c, secret.as_deref()).await,
    }
}
