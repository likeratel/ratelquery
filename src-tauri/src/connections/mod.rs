//! Saved connection configs (JSON file) and their secrets (OS keyring).

mod model;
mod probe;
mod secrets;
mod service;
mod store;
mod validate;

pub use model::{
    ConnectionConfig, ConnectionTestResult, DynamoAuth, DynamoConnectionConfig,
    MysqlConnectionConfig,
};
pub use probe::{probe_dynamodb, probe_mysql};
pub use secrets::{KeyringSecretStore, MemorySecretStore, SecretStore};
pub use service::ConnectionsService;
pub use store::ConnectionStore;
pub use validate::validate_config;
