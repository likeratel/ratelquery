//! Saved connection configs (JSON file) and their secrets (OS keyring or `secrets.json`).

mod duplicate;
mod file_secrets;
mod model;
mod probe;
mod secret_migration;
mod secrets;
mod service;
mod store;
mod switchable_secrets;
mod validate;
mod validate_athena;

pub use file_secrets::FileSecretStore;
pub use model::{
    AthenaConnectionConfig, AwsAuth, ConnectionConfig, ConnectionTestResult,
    DEFAULT_ATHENA_WORKGROUP, DynamoAuth, DynamoConnectionConfig, MysqlConnectionConfig,
    MysqlTlsMode, SshAuth, SshConfig,
};
pub use probe::{probe_athena, probe_dynamodb, probe_mysql, probe_mysql_via};
pub use secret_migration::update_settings;
pub use secrets::{
    KeyringSecretStore, MemorySecretStore, SSH_SECRET_SUFFIX, SecretSlot, SecretStore, StuckSecret,
    ssh_secret_id,
};
pub use service::ConnectionsService;
pub use store::ConnectionStore;
pub use switchable_secrets::{MigrationReport, SwitchableSecretStore};
pub use validate::{normalize_output_location, same_ssh_target, same_target, validate_config};
