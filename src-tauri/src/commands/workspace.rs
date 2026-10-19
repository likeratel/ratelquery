use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::util::run_blocking;
use crate::workspace::Workspace;

/// The saved query tabs, or null when none were saved or the file is corrupt (logged).
#[tauri::command]
pub async fn workspace_load(state: State<'_, AppState>) -> AppResult<Option<Workspace>> {
    let store = Arc::clone(&state.workspace);
    run_blocking(move || store.load()).await
}

/// Takes raw JSON so type errors come back as `invalid_input` instead of an argument error.
#[tauri::command]
pub async fn workspace_save(state: State<'_, AppState>, workspace: Value) -> AppResult<()> {
    let store = Arc::clone(&state.workspace);
    run_blocking(move || store.save(workspace)).await
}
