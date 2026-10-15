//! Saved connection configs (JSON file) and their secrets (OS keyring or `secrets.json`).

mod file_secrets;
mod model;
mod probe;
mod secrets;
mod service;
mod store;
mod switchable_secrets;
mod validate;

pub use file_secrets::FileSecretStore;
pub use model::{
    ConnectionConfig, ConnectionTestResult, DynamoAuth, DynamoConnectionConfig,
    MysqlConnectionConfig, MysqlTlsMode,
};
pub use probe::{probe_dynamodb, probe_mysql};
pub use secrets::{KeyringSecretStore, MemorySecretStore, SecretStore};
pub use service::ConnectionsService;
pub use store::ConnectionStore;
pub use switchable_secrets::SwitchableSecretStore;
pub use validate::{same_target, validate_config};
