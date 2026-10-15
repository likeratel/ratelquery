use std::path::Path;

use tauri::{AppHandle, Runtime};
use tauri_plugin_fs::FsExt;

use crate::error::AppResult;
use crate::export::{self, ExportOptions, ExportResult, authorize_target};
use crate::mysql::{Cell, ColumnInfo};

/// Rejects export paths the user did not pick in the save dialog. The dialog plugin adds the
/// chosen file to the fs plugin's runtime scope (`allow_file`); nothing else extends that
/// scope (no fs permissions are granted to the webview and dropped paths are not scoped).
pub fn authorize_export_path<R: Runtime>(app: &AppHandle<R>, path: &str) -> AppResult<()> {
    let scope = app.try_fs_scope();
    let policy = |candidate: &Path| scope.as_ref().is_some_and(|s| s.is_allowed(candidate));
    authorize_target(path, &policy).map(|_| ())
}

#[tauri::command]
pub async fn export_rows(
    app: AppHandle,
    columns: Vec<ColumnInfo>,
    rows: Vec<Vec<Cell>>,
    options: ExportOptions,
) -> AppResult<ExportResult> {
    authorize_export_path(&app, &options.path)?;
    export::run_blocking(move || export::export_rows(&columns, &rows, &options)).await
}
