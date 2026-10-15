use crate::error::AppResult;
use crate::export::{self, ExportOptions, ExportResult};
use crate::mysql::{Cell, ColumnInfo};

#[tauri::command]
pub async fn export_rows(
    columns: Vec<ColumnInfo>,
    rows: Vec<Vec<Cell>>,
    options: ExportOptions,
) -> AppResult<ExportResult> {
    tauri::async_runtime::spawn_blocking(move || export::export_rows(&columns, &rows, &options))
        .await
        .map_err(|e| crate::AppError::Io(format!("export task failed: {e}")))?
}
