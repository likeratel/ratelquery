use tauri::{AppHandle, State};

use super::export::authorize_export_path;
use crate::connections::ConnectionConfig;
use crate::error::{AppError, AppResult};
use crate::export::{ExportOptions, ExportResult};
use crate::mysql::{
    self, ApplyChangesResult, MysqlSessionInfo, QueryOptions, QueryResult, RowChange,
    SchemaSnapshot, TableDetails,
};
use crate::state::AppState;

#[tauri::command]
pub async fn mysql_connect(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<MysqlSessionInfo> {
    let ConnectionConfig::Mysql(config) = state.connections.get(&connection_id)? else {
        return Err(AppError::InvalidInput(format!("{connection_id} is not a MySQL connection")));
    };
    let password = state.connections.resolve_secret(&connection_id, None)?;
    state.mysql.connect(&connection_id, &config, password.as_deref()).await
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
