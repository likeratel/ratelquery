use std::future::Future;
use std::sync::Arc;

use tauri::{AppHandle, State};

use super::export::authorize_export_path;
use crate::connections::{ConnectionConfig, DynamoAuth};
use crate::dynamo::{
    self, DynamoExportOptions, DynamoExportRequest, DynamoHandle, Page, PutExpectation,
    QueryRequest, ScanRequest, TableDescription, WireItem,
};
use crate::error::{AppError, AppResult};
use crate::export::ExportResult;
use crate::state::AppState;
use crate::util::run_blocking;

const MISSING_KEY_MESSAGE: &str = "No secret access key is stored for this connection in the \
                                   active secret store; edit the connection to enter it";

/// The stored secret access key of a `keys` connection, or a `credential` error asking the user
/// to edit the connection (the active secret store may have been switched).
fn require_stored_key(secret: Option<String>) -> AppResult<String> {
    secret
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Credential(MISSING_KEY_MESSAGE.to_string()))
}

/// Cached handle for the connection, created from the saved config and stored secret on first
/// use.
async fn handle(state: &AppState, connection_id: &str) -> AppResult<Arc<DynamoHandle>> {
    if let Some(handle) = state.dynamo.get(connection_id).await {
        return Ok(handle);
    }
    let connections = Arc::clone(&state.connections);
    let id = connection_id.to_string();
    // Config file and secret store reads run on the blocking pool.
    let (config, secret) = run_blocking(move || {
        let ConnectionConfig::Dynamodb(config) = connections.get(&id)? else {
            return Err(AppError::InvalidInput(format!("{id} is not a DynamoDB connection")));
        };
        let secret = match &config.auth {
            DynamoAuth::Keys { .. } => {
                Some(require_stored_key(connections.resolve_secret(&id, None)?)?)
            }
            DynamoAuth::Profile { .. } => None,
        };
        Ok((config, secret))
    })
    .await?;
    state.dynamo.connect(&config, secret.as_deref()).await
}

/// Runs `op` with the connection's handle. Credential failures drop the cached handle so the
/// next call reloads credentials (e.g. after `aws sso login`).
async fn with_handle<T, F, Fut>(state: &AppState, connection_id: &str, op: F) -> AppResult<T>
where
    F: FnOnce(Arc<DynamoHandle>) -> Fut,
    Fut: Future<Output = AppResult<T>>,
{
    let result = op(handle(state, connection_id).await?).await;
    if matches!(result, Err(AppError::Credential(_))) {
        state.dynamo.remove(connection_id).await;
    }
    result
}

#[tauri::command]
pub async fn dynamo_list_tables(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<String>> {
    with_handle(&state, &connection_id, |h| async move { dynamo::list_tables(&h).await }).await
}

#[tauri::command]
pub async fn dynamo_describe_table(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> AppResult<TableDescription> {
    with_handle(&state, &connection_id, |h| async move {
        Ok(dynamo::describe_table(&h, &table).await?.as_ref().clone())
    })
    .await
}

#[tauri::command]
pub async fn dynamo_query(
    state: State<'_, AppState>,
    connection_id: String,
    request: QueryRequest,
) -> AppResult<Page> {
    with_handle(&state, &connection_id, |h| async move { dynamo::query(&h, &request).await }).await
}

#[tauri::command]
pub async fn dynamo_scan(
    state: State<'_, AppState>,
    connection_id: String,
    request: ScanRequest,
) -> AppResult<Page> {
    with_handle(&state, &connection_id, |h| async move { dynamo::scan(&h, &request).await }).await
}

#[tauri::command]
pub async fn dynamo_get_item(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
    key: WireItem,
) -> AppResult<Option<WireItem>> {
    with_handle(&state, &connection_id, |h| async move { dynamo::get_item(&h, &table, &key).await })
        .await
}

#[tauri::command]
pub async fn dynamo_put_item(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
    item: WireItem,
    expect: PutExpectation,
) -> AppResult<()> {
    with_handle(&state, &connection_id, |h| async move {
        dynamo::put_item(&h, &table, &item, expect).await
    })
    .await
}

#[tauri::command]
pub async fn dynamo_delete_item(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
    key: WireItem,
) -> AppResult<()> {
    with_handle(
        &state,
        &connection_id,
        |h| async move { dynamo::delete_item(&h, &table, &key).await },
    )
    .await
}

#[tauri::command]
pub async fn dynamo_export(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    request: DynamoExportRequest,
    options: DynamoExportOptions,
) -> AppResult<ExportResult> {
    authorize_export_path(&app, &options.path)?;
    with_handle(&state, &connection_id, |h| async move {
        dynamo::run_export(&h, &request, &options).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_stored_key_is_a_credential_error() {
        for missing in [None, Some(String::new())] {
            let err = require_stored_key(missing).unwrap_err();
            assert_eq!(err.kind(), "credential");
            assert!(err.to_string().contains("edit the connection"), "{err}");
        }
        assert_eq!(require_stored_key(Some("k".into())).unwrap(), "k");
    }
}
