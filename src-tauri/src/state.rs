use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::connections::{
    ConnectionStore, ConnectionsService, FileSecretStore, SecretStore, SwitchableSecretStore,
};
use crate::dynamo::DynamoClients;
use crate::mysql::{MysqlSessions, MysqlStateEvent, STATE_EVENT, StateSink};
use crate::settings::{SettingsService, SettingsStore};

/// Managed Tauri state shared by all commands.
pub struct AppState {
    pub connections: ConnectionsService,
    pub mysql: MysqlSessions,
    pub dynamo: DynamoClients,
    pub settings: Arc<SettingsService>,
}

impl AppState {
    /// `keychain` is the OS keyring store; the file store lives in `config_dir`. Which one is
    /// used is read from settings on every secret operation.
    pub fn new(
        config_dir: &Path,
        keychain: Arc<dyn SecretStore>,
        sink: Arc<dyn StateSink>,
    ) -> Self {
        let settings = Arc::new(SettingsService::new(SettingsStore::new(config_dir)));
        let secrets = SwitchableSecretStore::new(
            Arc::clone(&settings),
            keychain,
            Arc::new(FileSecretStore::new(config_dir)),
        );
        Self {
            connections: ConnectionsService::new(
                ConnectionStore::new(config_dir),
                Arc::new(secrets),
            ),
            mysql: MysqlSessions::new(sink),
            dynamo: DynamoClients::new(),
            settings,
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
