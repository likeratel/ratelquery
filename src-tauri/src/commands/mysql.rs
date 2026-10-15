use tauri::{AppHandle, State};

use super::export::authorize_export_path;
use crate::error::AppResult;
use crate::export::{ExportOptions, ExportResult};
use crate::mysql::{
    self, ApplyChangesResult, MysqlSessionInfo, QueryOptions, QueryResult, RowChange,
    SchemaSnapshot, TableDetails,
};
use crate::state::AppState;

/// `secret` / `ssh_secret`, when given, are used for this session only and are not stored.
#[tauri::command]
pub async fn mysql_connect(
    state: State<'_, AppState>,
    connection_id: String,
    secret: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<MysqlSessionInfo> {
    state
        .mysql
        .connect_saved(&state.connections, &connection_id, secret.as_deref(), ssh_secret.as_deref())
        .await
}

#[tauri::command]
pub async fn mysql_disconnect(state: State<'_, AppState>, connection_id: String) -> AppResult<()> {
    state.mysql.disconnect(&connection_id).await;
    Ok(())
}

#[tauri::command]
pub async fn mysql_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    options: Option<QueryOptions>,
) -> AppResult<Vec<QueryResult>> {
    let session = state.mysql.get(&connection_id).await?;
    mysql::run_query(&session, &sql, &options.unwrap_or_default()).await
}

#[tauri::command]
pub async fn mysql_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<String>> {
    let session = state.mysql.get(&connection_id).await?;
    mysql::databases(&session).await
}

#[tauri::command]
pub async fn mysql_schema(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> AppResult<SchemaSnapshot> {
    let session = state.mysql.get(&connection_id).await?;
    mysql::schema(&session, &database).await
}

#[tauri::command]
pub async fn mysql_table_details(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> AppResult<TableDetails> {
    let session = state.mysql.get(&connection_id).await?;
    mysql::table_details(&session, &database, &table).await
}

#[tauri::command]
pub async fn mysql_apply_changes(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    changes: Vec<RowChange>,
) -> AppResult<ApplyChangesResult> {
    let session = state.mysql.get(&connection_id).await?;
    mysql::apply_changes(&session, &database, &table, &changes).await
}

#[tauri::command]
pub async fn mysql_export(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    options: ExportOptions,
) -> AppResult<ExportResult> {
    authorize_export_path(&app, &options.path)?;
    let session = state.mysql.get(&connection_id).await?;
    mysql::run_export(&session, &sql, &options).await
}
