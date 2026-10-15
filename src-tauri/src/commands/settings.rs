use serde_json::Value;
use tauri::State;

use crate::error::AppResult;
use crate::settings::Settings;
use crate::state::AppState;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> AppResult<Settings> {
    state.settings.get()
}

/// Takes raw JSON so type errors come back as `invalid_input` instead of an argument error.
#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, settings: Value) -> AppResult<Settings> {
    state.settings.set(&settings)
}
