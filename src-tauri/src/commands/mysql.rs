use std::sync::Arc;

use tauri::{AppHandle, State};

use super::export::authorize_export_path;
use crate::error::AppResult;
use crate::export::{ExportOptions, ExportResult};
use crate::mysql::{
    self, ApplyChangesResult, ChangePreview, MysqlSessionInfo, QueryOptions, QueryResult,
    RowChange, SchemaSnapshot, TableDetails, TrashTarget,
};
use crate::state::AppState;
use crate::util::run_blocking;

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

/// DELETE statements are backed up to the trash unless listed in `options.deleteBackup.skip`
/// (see `mysql_delete_plan`).
#[tauri::command]
pub async fn mysql_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    options: Option<QueryOptions>,
) -> AppResult<Vec<QueryResult>> {
    let session = state.mysql.get(&connection_id).await?;
    let options = options.unwrap_or_default();
    let trash = if mysql::delete_plan(&mysql::split_statements(&sql)).is_empty() {
        None
    } else {
        Some(trash_target(&state, &connection_id).await)
    };
    mysql::run_query_with_trash(&session, &sql, &options, trash.as_ref()).await
}

/// Gives back the connection a stopped run kept for continuing (`resumeToken`), when the user
/// doesn't continue. Unknown tokens and closed sessions are fine.
#[tauri::command]
pub async fn mysql_release_resume(
    state: State<'_, AppState>,
    connection_id: String,
    token: String,
) -> AppResult<()> {
    if let Ok(session) = state.mysql.get(&connection_id).await {
        session.release_parked(&token);
    }
    Ok(())
}

/// For each statement of `sql` (as `mysql_query` splits it) that deletes rows: whether it can
/// be backed up to the trash, and why not. Runs nothing.
#[tauri::command]
pub fn mysql_delete_plan(sql: String) -> Vec<mysql::DeletePlanEntry> {
    mysql::delete_plan(&mysql::split_statements(&sql))
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

/// Deleted rows are saved to the trash first unless `skip_backup` is true.
#[tauri::command]
pub async fn mysql_apply_changes(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    changes: Vec<RowChange>,
    skip_backup: Option<bool>,
) -> AppResult<ApplyChangesResult> {
    let session = state.mysql.get(&connection_id).await?;
    let has_delete = changes.iter().any(|c| matches!(c, RowChange::Delete { .. }));
    let trash = if has_delete && !skip_backup.unwrap_or(false) {
        Some(trash_target(&state, &connection_id).await)
    } else {
        None
    };
    mysql::apply_changes(&session, &database, &table, &changes, trash.as_ref()).await
}

/// The trash and the connection's current name. When the saved connection cannot be read the
/// id stands in for the name, so the backup still happens.
async fn trash_target(state: &AppState, connection_id: &str) -> TrashTarget {
    let connections = Arc::clone(&state.connections);
    let id = connection_id.to_string();
    let name = run_blocking(move || connections.get(&id).map(|c| c.name().to_string()))
        .await
        .unwrap_or_else(|err| {
            eprintln!("could not read the name of connection {connection_id}: {err}");
            connection_id.to_string()
        });
    TrashTarget {
        store: Arc::clone(&state.trash),
        connection_id: connection_id.to_string(),
        connection_name: name,
    }
}

/// The statements `mysql_apply_changes` would run, with values written as literals. Nothing
/// is executed.
#[tauri::command]
pub async fn mysql_preview_changes(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    changes: Vec<RowChange>,
) -> AppResult<ChangePreview> {
    let session = state.mysql.get(&connection_id).await?;
    mysql::preview_changes(&session, &database, &table, &changes).await
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
