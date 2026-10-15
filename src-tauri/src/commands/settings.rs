use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::connections::update_settings;
use crate::error::AppResult;
use crate::settings::Settings;
use crate::state::AppState;
use crate::util::run_blocking;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> AppResult<Settings> {
    let settings = Arc::clone(&state.settings);
    run_blocking(move || settings.get()).await
}

/// Takes raw JSON so type errors come back as `invalid_input` instead of an argument error.
/// Switching `secretStore` moves the saved secrets to the new store (best effort).
#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, settings: Value) -> AppResult<Settings> {
    let service = Arc::clone(&state.settings);
    let connections = Arc::clone(&state.connections);
    let secrets = Arc::clone(&state.secrets);
    run_blocking(move || update_settings(&service, &connections, &secrets, &settings)).await
}
