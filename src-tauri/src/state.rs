use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::connections::{ConnectionStore, ConnectionsService, SecretStore};
use crate::dynamo::DynamoClients;
use crate::mysql::{MysqlSessions, MysqlStateEvent, STATE_EVENT, StateSink};
use crate::settings::{SettingsService, SettingsStore};

/// Managed Tauri state shared by all commands.
pub struct AppState {
    pub connections: ConnectionsService,
    pub mysql: MysqlSessions,
    pub dynamo: DynamoClients,
    pub settings: SettingsService,
}

impl AppState {
    pub fn new(config_dir: &Path, secrets: Arc<dyn SecretStore>, sink: Arc<dyn StateSink>) -> Self {
        Self {
            connections: ConnectionsService::new(ConnectionStore::new(config_dir), secrets),
            mysql: MysqlSessions::new(sink),
            dynamo: DynamoClients::new(),
            settings: SettingsService::new(SettingsStore::new(config_dir)),
        }
    }
}

/// Forwards session state events to the webview.
pub struct TauriStateSink {
    app: AppHandle,
}

impl TauriStateSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl StateSink for TauriStateSink {
    fn emit(&self, event: MysqlStateEvent) {
        if let Err(err) = self.app.emit(STATE_EVENT, &event) {
            eprintln!("failed to emit {STATE_EVENT} for {}: {err}", event.connection_id);
        }
    }
}
