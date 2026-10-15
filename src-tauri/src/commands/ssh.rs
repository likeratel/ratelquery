use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::run_blocking;

/// Appends `key_line` (the last line of an `ssh_host_key` error) to the app's known_hosts for
/// `host:port`. A key that is already known is a no-op; a changed or revoked key is refused
/// with `invalid_input`.
#[tauri::command]
pub async fn ssh_trust_host(
    state: State<'_, AppState>,
    host: String,
    port: i64,
    key_line: String,
) -> AppResult<()> {
    let port = u16::try_from(port)
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| AppError::InvalidInput(format!("invalid ssh port {port}")))?;
    let known_hosts = state.known_hosts.clone();
    run_blocking(move || known_hosts.trust(host.trim(), port, key_line.trim())).await
}
