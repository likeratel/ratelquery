use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::util::run_blocking;

/// The saved query output log as stored, or null when none was saved or the file is unusable
/// (logged). The frontend validates the entries.
#[tauri::command]
pub async fn query_output_load(state: State<'_, AppState>) -> AppResult<Option<Value>> {
    let store = Arc::clone(&state.query_output);
    run_blocking(move || store.load()).await
}

/// Replaces the saved log; null removes the file (output kept for the session only).
#[tauri::command]
pub async fn query_output_save(state: State<'_, AppState>, output: Value) -> AppResult<()> {
    let store = Arc::clone(&state.query_output);
    run_blocking(move || store.save(output)).await
}
