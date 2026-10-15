use std::future::Future;
use std::sync::Arc;

use tauri::State;

use super::connections::blocking;
use super::dynamo::require_stored_key;
use crate::athena::{
    self, AthenaBucketCreated, AthenaHandle, AthenaQueryOptions, AthenaRowsResult, AthenaStarted,
    connect_sdk,
};
use crate::connections::{AthenaConnectionConfig, AwsAuth, ConnectionConfig, validate_config};
use crate::error::{AppError, AppResult};
use crate::mysql::SchemaSnapshot;
use crate::state::AppState;
use crate::util::run_blocking;

/// Cached handle for the connection, created from the saved config and stored secret on first
/// use.
async fn handle(state: &AppState, connection_id: &str) -> AppResult<Arc<AthenaHandle>> {
    if let Some(handle) = state.athena.get(connection_id).await {
        return Ok(handle);
    }
    let connections = Arc::clone(&state.connections);
    let id = connection_id.to_string();
    // Config file and secret store reads run on the blocking pool.
    let (config, secret) = run_blocking(move || {
        let ConnectionConfig::Athena(config) = connections.get(&id)? else {
            return Err(AppError::InvalidInput(format!("{id} is not an Athena connection")));
        };
        let secret = match &config.auth {
            AwsAuth::Keys { .. } => {
                Some(require_stored_key(connections.resolve_secret(&id, None)?)?)
            }
            AwsAuth::Profile { .. } => None,
        };
        Ok((config, secret))
    })
    .await?;
    state.athena.connect(&config, secret.as_deref()).await
}

/// Runs `op` with the connection's handle. Credential failures drop the cached handle so the
/// next call reloads credentials (e.g. after `aws sso login`).
async fn with_handle<T, F, Fut>(state: &AppState, connection_id: &str, op: F) -> AppResult<T>
where
    F: FnOnce(Arc<AthenaHandle>) -> Fut,
    Fut: Future<Output = AppResult<T>>,
{
    let result = op(handle(state, connection_id).await?).await;
    if matches!(result, Err(AppError::Credential(_))) {
        state.athena.remove(connection_id).await;
    }
    result
}

/// Validates an unsaved Athena config and resolves its secret like `connections_test`.
async fn unsaved_config(
    state: &AppState,
    config: ConnectionConfig,
    secret: Option<String>,
) -> AppResult<(AthenaConnectionConfig, Option<String>)> {
    let ConnectionConfig::Athena(athena) = validate_config(&config)? else {
        return Err(AppError::InvalidInput("The config is not an Athena connection".into()));
    };
    let lookup = ConnectionConfig::Athena(athena.clone());
    let secret =
        blocking(state, move |c| c.resolve_test_secret(&lookup, secret.as_deref())).await?;
    Ok((athena, secret))
}

#[tauri::command]
pub async fn athena_workgroups(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    secret: Option<String>,
) -> AppResult<Vec<String>> {
    let (config, secret) = unsaved_config(&state, config, secret).await?;
    let (_, client) = connect_sdk(&config, secret.as_deref()).await?;
    athena::list_workgroups(&client, &config.auth).await
}

/// Only called after the user confirmed creating the bucket in the connection dialog.
#[tauri::command]
pub async fn athena_create_output_bucket(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    secret: Option<String>,
    bucket: String,
) -> AppResult<AthenaBucketCreated> {
    let (config, secret) = unsaved_config(&state, config, secret).await?;
    let (sdk, _) = connect_sdk(&config, secret.as_deref()).await?;
    let output_location = athena::create_output_bucket(&sdk, &config, &bucket).await?;
    // A cached handle may still remember the bucket as missing.
    state.athena.remove(&config.id).await;
    Ok(AthenaBucketCreated { output_location })
}

#[tauri::command]
pub async fn athena_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<String>> {
    with_handle(&state, &connection_id, |h| async move { athena::list_databases(&h).await }).await
}

#[tauri::command]
pub async fn athena_schema(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> AppResult<SchemaSnapshot> {
    let database = database.trim().to_string();
    if database.is_empty() {
        return Err(AppError::InvalidInput("database must not be empty".into()));
    }
    with_handle(&state, &connection_id, |h| async move { athena::schema(&h, &database).await })
        .await
}

#[tauri::command]
pub async fn athena_start(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    options: AthenaQueryOptions,
) -> AppResult<AthenaStarted> {
    if sql.trim().is_empty() {
        return Err(AppError::InvalidInput("The statement is empty".into()));
    }
    with_handle(&state, &connection_id, |h| async move { athena::start(&h, &sql, &options).await })
        .await
}

#[tauri::command]
pub async fn athena_wait(
    state: State<'_, AppState>,
    connection_id: String,
    execution_id: String,
    max_rows: Option<i64>,
) -> AppResult<AthenaRowsResult> {
    with_handle(&state, &connection_id, |h| async move {
        athena::wait(&h, &execution_id, max_rows).await
    })
    .await
}

#[tauri::command]
pub async fn athena_cancel(
    state: State<'_, AppState>,
    connection_id: String,
    execution_id: String,
) -> AppResult<()> {
    with_handle(&state, &connection_id, |h| async move { athena::cancel(&h, &execution_id).await })
        .await
}
