use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::connections::update_settings;
use crate::error::AppResult;
use crate::settings::Settings;
use crate::state::AppState;
use crate::trash;
use crate::util::run_blocking;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> AppResult<Settings> {
    let settings = Arc::clone(&state.settings);
    run_blocking(move || settings.get()).await
}

/// Takes raw JSON so type errors come back as `invalid_input` instead of an argument error.
/// Switching `secretStore` moves the saved secrets to the new store (best effort). A changed
/// `query.trashRetentionDays` purges the trash right away (failures are logged).
#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, settings: Value) -> AppResult<Settings> {
    let service = Arc::clone(&state.settings);
    let connections = Arc::clone(&state.connections);
    let secrets = Arc::clone(&state.secrets);
    let trash = Arc::clone(&state.trash);
    run_blocking(move || {
        let before = service.get().ok().map(|s| s.query.trash_retention_days);
        let saved = update_settings(&service, &connections, &secrets, &settings)?;
        let after = saved.query.trash_retention_days;
        if before != Some(after) {
            trash::purge_logged(&trash, after);
        }
        Ok(saved)
    })
    .await
}
