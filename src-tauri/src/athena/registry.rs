//! Per-connection Athena clients, created on first use and cached until the connection is
//! deleted, edited or its credentials fail. Each keeps its resolved output location.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use aws_sdk_athena::Client;
use aws_types::SdkConfig;
use tokio::sync::RwLock;

use super::output::{ResolvedOutput, resolve_output};
use crate::connections::{AthenaConnectionConfig, AwsAuth};
use crate::dynamo::{aws_sdk_config, resolve_credentials};
use crate::error::AppResult;

/// SDK config with credentials resolved once (so missing or expired credentials surface as
/// `credential` first) and the Athena client built from it.
pub async fn connect_sdk(
    config: &AthenaConnectionConfig,
    secret: Option<&str>,
) -> AppResult<(SdkConfig, Client)> {
    let sdk = aws_sdk_config(&config.region, None, &config.auth, secret).await?;
    resolve_credentials(&sdk, &config.auth).await?;
    let client = Client::new(&sdk);
    Ok((sdk, client))
}

pub struct AthenaHandle {
    sdk: SdkConfig,
    client: Client,
    config: AthenaConnectionConfig,
    output: RwLock<ResolvedOutput>,
    /// When `athena_start` started each execution, for `elapsedMs`.
    started: Mutex<HashMap<String, Instant>>,
}

impl AthenaHandle {
    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn auth(&self) -> &AwsAuth {
        &self.config.auth
    }

    pub fn workgroup(&self) -> &str {
        self.config.workgroup_name()
    }

    /// Output location for a new query. A missing default bucket is looked up again (it may
    /// have been created since) and stays `invalid_input` while it is still missing.
    pub async fn output_for_query(&self) -> AppResult<Option<String>> {
        let current = self.output.read().await.clone();
        if current.missing_bucket().is_none() {
            return current.for_query();
        }
        let fresh = resolve_output(&self.sdk, &self.client, &self.config).await?;
        *self.output.write().await = fresh.clone();
        fresh.for_query()
    }

    pub fn record_start(&self, execution_id: &str) {
        if let Ok(mut started) = self.started.lock() {
            started.insert(execution_id.to_string(), Instant::now());
        }
    }

    pub fn started_at(&self, execution_id: &str) -> Option<Instant> {
        self.started.lock().ok().and_then(|s| s.get(execution_id).copied())
    }

    pub fn forget_start(&self, execution_id: &str) {
        if let Ok(mut started) = self.started.lock() {
            started.remove(execution_id);
        }
    }
}

pub async fn open_handle(
    config: &AthenaConnectionConfig,
    secret: Option<&str>,
) -> AppResult<AthenaHandle> {
    let (sdk, client) = connect_sdk(config, secret).await?;
    let output = resolve_output(&sdk, &client, config).await?;
    Ok(AthenaHandle {
        sdk,
        client,
        config: config.clone(),
        output: RwLock::new(output),
        started: Mutex::new(HashMap::new()),
    })
}

/// All cached Athena handles keyed by connection id.
#[derive(Default)]
pub struct AthenaClients {
    handles: RwLock<HashMap<String, Arc<AthenaHandle>>>,
}

impl AthenaClients {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get(&self, id: &str) -> Option<Arc<AthenaHandle>> {
        self.handles.read().await.get(id).cloned()
    }

    /// Cached handle for `config.id`, or a new one built from `config` and `secret`.
    /// When two callers race on first use, the first stored handle wins.
    pub async fn connect(
        &self,
        config: &AthenaConnectionConfig,
        secret: Option<&str>,
    ) -> AppResult<Arc<AthenaHandle>> {
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

    fn keys_config() -> AthenaConnectionConfig {
        AthenaConnectionConfig {
            id: "a".into(),
            name: "a".into(),
            region: "ap-northeast-2".into(),
            auth: AwsAuth::Keys { access_key_id: "AKIA".into() },
            workgroup: None,
            output_location: None,
            database: None,
            color: None,
        }
    }

    #[tokio::test]
    async fn missing_key_secret_is_a_credential_error_and_nothing_is_cached() {
        let clients = AthenaClients::new();
        let Err(err) = clients.connect(&keys_config(), None).await else {
            panic!("expected an error");
        };
        assert_eq!(err.kind(), "credential");
        assert!(err.to_string().contains("secret access key is not set"), "{err}");
        assert!(clients.get("a").await.is_none());
        clients.remove("a").await;
    }
}
