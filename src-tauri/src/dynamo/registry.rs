//! Per-connection DynamoDB clients, created on first use and cached until the connection is
//! deleted, edited or its credentials fail.

use std::collections::HashMap;
use std::sync::Arc;

use aws_config::BehaviorVersion;
use aws_config::profile::ProfileFileCredentialsProvider;
use aws_config::provider_config::ProviderConfig;
use aws_credential_types::provider::ProvideCredentials;
use aws_sdk_dynamodb::Client;
use aws_sdk_dynamodb::config::{Credentials, Region};
use tokio::sync::RwLock;

use super::errors::{credential_error, credentials_resolution_error};
use super::model::TableDescription;
use crate::connections::{DynamoAuth, DynamoConnectionConfig};
use crate::error::AppResult;

const CREDENTIALS_PROVIDER_NAME: &str = "dbclient";

/// One connection's client plus its DescribeTable cache.
pub struct DynamoHandle {
    client: Client,
    auth: DynamoAuth,
    tables: RwLock<HashMap<String, Arc<TableDescription>>>,
}

impl DynamoHandle {
    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn auth(&self) -> &DynamoAuth {
        &self.auth
    }

    pub async fn cached_table(&self, table: &str) -> Option<Arc<TableDescription>> {
        self.tables.read().await.get(table).cloned()
    }

    pub async fn cache_table(
        &self,
        table: &str,
        description: TableDescription,
    ) -> Arc<TableDescription> {
        let shared = Arc::new(description);
        self.tables.write().await.insert(table.to_string(), Arc::clone(&shared));
        shared
    }

    pub async fn forget_table(&self, table: &str) {
        self.tables.write().await.remove(table);
    }
}

/// Credentials of exactly the named `~/.aws` profile (static keys, SSO, `credential_process`,
/// assume-role chains). Unlike the default chain it never consults `AWS_ACCESS_KEY_ID` /
/// `AWS_SECRET_ACCESS_KEY` first, so environment keys cannot replace the chosen profile.
/// `region` is the connection's region, used by STS calls in assume-role chains (SSO uses the
/// profile's `sso_region`).
pub fn profile_credentials(profile: &str, region: &str) -> ProfileFileCredentialsProvider {
    let provider_config =
        ProviderConfig::without_region().with_region(Some(Region::new(region.to_string())));
    ProfileFileCredentialsProvider::builder()
        .configure(&provider_config)
        .profile_name(profile)
        .build()
}

/// SDK config for a connection: its region, optional endpoint and either exactly the named
/// profile or the stored access key. A missing secret for a `keys` connection is `credential`.
pub async fn sdk_config(
    config: &DynamoConnectionConfig,
    secret: Option<&str>,
) -> AppResult<aws_types::SdkConfig> {
    let loader =
        aws_config::defaults(BehaviorVersion::latest()).region(Region::new(config.region.clone()));
    let loader = match &config.endpoint {
        Some(endpoint) => loader.endpoint_url(endpoint),
        None => loader,
    };
    let loader = match &config.auth {
        DynamoAuth::Profile { profile } => loader
            .profile_name(profile)
            .credentials_provider(profile_credentials(profile, &config.region)),
        DynamoAuth::Keys { access_key_id } => {
            let secret = secret.filter(|s| !s.is_empty()).ok_or_else(|| {
                credential_error(&config.auth, "the secret access key is not set")
            })?;
            let credentials =
                Credentials::new(access_key_id, secret, None, None, CREDENTIALS_PROVIDER_NAME);
            loader.credentials_provider(credentials)
        }
    };
    Ok(loader.load().await)
}

/// Builds a client and resolves its credentials once so missing or expired credentials surface
/// as `credential` before any request is made.
pub async fn open_handle(
    config: &DynamoConnectionConfig,
    secret: Option<&str>,
) -> AppResult<DynamoHandle> {
    let sdk_config = sdk_config(config, secret).await?;
    let provider = sdk_config
        .credentials_provider()
        .ok_or_else(|| credential_error(&config.auth, "no credentials provider is configured"))?;
    provider
        .provide_credentials()
        .await
        .map_err(|e| credentials_resolution_error(&config.auth, &e))?;
    Ok(DynamoHandle {
        client: Client::new(&sdk_config),
        auth: config.auth.clone(),
        tables: RwLock::new(HashMap::new()),
    })
}

/// All cached DynamoDB handles keyed by connection id.
#[derive(Default)]
pub struct DynamoClients {
    handles: RwLock<HashMap<String, Arc<DynamoHandle>>>,
}

impl DynamoClients {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get(&self, id: &str) -> Option<Arc<DynamoHandle>> {
        self.handles.read().await.get(id).cloned()
    }

    /// Cached handle for `config.id`, or a new one built from `config` and `secret`.
    /// When two callers race on first use, the first stored handle wins.
    pub async fn connect(
        &self,
        config: &DynamoConnectionConfig,
        secret: Option<&str>,
    ) -> AppResult<Arc<DynamoHandle>> {
        if let Some(handle) = self.get(&config.id).await {
            return Ok(handle);
        }
        let handle = Arc::new(open_handle(config, secret).await?);
        let mut handles = self.handles.write().await;
        Ok(Arc::clone(handles.entry(config.id.clone()).or_insert(handle)))
    }

    /// Drops the cached handle. Removing an unknown id is a no-op.
    pub async fn remove(&self, id: &str) {
        self.handles.write().await.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHILD_VAR: &str = "DBCLIENT_TEST_PROFILE_CHILD";
    const TEST_NAME: &str = "dynamo::registry::tests::profile_auth_ignores_environment_keys";

    fn profile_config() -> DynamoConnectionConfig {
        DynamoConnectionConfig {
            id: "test".into(),
            name: "test".into(),
            region: "ap-northeast-2".into(),
            endpoint: Some("http://127.0.0.1:1".into()),
            auth: DynamoAuth::Profile { profile: "picked".into() },
            color: None,
        }
    }

    /// Environment variables are process-wide, so the check runs in a child test process that
    /// gets environment keys plus a temp credentials file defining the `picked` profile.
    #[test]
    fn profile_auth_ignores_environment_keys() {
        if std::env::var_os(CHILD_VAR).is_some() {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let credentials = runtime.block_on(async {
                let sdk = sdk_config(&profile_config(), None).await.unwrap();
                sdk.credentials_provider().unwrap().provide_credentials().await.unwrap()
            });
            assert_eq!(credentials.access_key_id(), "PROFILEKEY");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let credentials = dir.path().join("credentials");
        std::fs::write(
            &credentials,
            "[picked]\naws_access_key_id = PROFILEKEY\naws_secret_access_key = profile-secret\n",
        )
        .unwrap();
        let config = dir.path().join("config");
        std::fs::write(&config, "").unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--test-threads=1"])
            .env(CHILD_VAR, "1")
            .env("AWS_ACCESS_KEY_ID", "ENVKEY")
            .env("AWS_SECRET_ACCESS_KEY", "env-secret")
            .env("AWS_SHARED_CREDENTIALS_FILE", &credentials)
            .env("AWS_CONFIG_FILE", &config)
            .env_remove("AWS_SESSION_TOKEN")
            .env_remove("AWS_PROFILE")
            .status()
            .unwrap();
        assert!(status.success(), "child test failed: {status}");
    }
}
