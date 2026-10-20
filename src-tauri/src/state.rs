use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::athena::AthenaClients;
use crate::connections::{
    ConnectionLayoutStore, ConnectionStore, ConnectionsService, FileSecretStore, SecretStore,
    SwitchableSecretStore,
};
use crate::dynamo::DynamoClients;
use crate::mysql::{MysqlSessions, MysqlStateEvent, STATE_EVENT, StateSink};
use crate::query_output::QueryOutputStore;
use crate::settings::{SettingsService, SettingsStore};
use crate::ssh::KnownHosts;
use crate::workspace::WorkspaceStore;

/// Managed Tauri state shared by all commands. The services doing file or keyring I/O are
/// `Arc`s so commands can move them onto the blocking pool.
pub struct AppState {
    pub connections: Arc<ConnectionsService>,
    pub secrets: Arc<SwitchableSecretStore>,
    pub mysql: MysqlSessions,
    pub dynamo: DynamoClients,
    pub athena: AthenaClients,
    pub settings: Arc<SettingsService>,
    /// `~/.ssh/known_hosts` plus the app's own file, for SSH tunnels.
    pub known_hosts: KnownHosts,
    /// `workspace.json`: the query tabs to reopen on the next launch.
    pub workspace: Arc<WorkspaceStore>,
    /// `connection-layout.json`: sidebar order and folders of the connections.
    pub connection_layout: Arc<ConnectionLayoutStore>,
    /// `query-output.json`: the query output log, kept for the days set in Settings.
    pub query_output: Arc<QueryOutputStore>,
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
        let secrets = Arc::new(SwitchableSecretStore::new(
            Arc::clone(&settings),
            keychain,
            Arc::new(FileSecretStore::new(config_dir)),
        ));
        let shared: Arc<dyn SecretStore> = secrets.clone();
        let known_hosts = KnownHosts::for_app(config_dir);
        Self {
            connections: Arc::new(ConnectionsService::new(
                ConnectionStore::new(config_dir),
                shared,
            )),
            secrets,
            mysql: MysqlSessions::new(sink).with_known_hosts(known_hosts.clone()),
            dynamo: DynamoClients::new(),
            athena: AthenaClients::new(),
            settings,
            known_hosts,
            workspace: Arc::new(WorkspaceStore::new(config_dir)),
            connection_layout: Arc::new(ConnectionLayoutStore::new(config_dir)),
            query_output: Arc::new(QueryOutputStore::new(config_dir)),
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
