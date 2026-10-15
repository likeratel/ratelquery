//! Per-connection DynamoDB clients, created on first use and cached until the connection is
//! deleted, edited or its credentials fail.

use std::collections::HashMap;
use std::sync::Arc;

use aws_config::BehaviorVersion;
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

async fn sdk_config(
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
        DynamoAuth::Profile { profile } => loader.profile_name(profile),
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
