//! Per-connection Athena clients, created on first use and cached until the connection is
//! deleted, edited or its credentials fail. Each keeps its resolved output location and the
//! executions it started, which are stopped when the connection is deleted or edited.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use aws_sdk_athena::Client;
use aws_sdk_athena::error::DisplayErrorContext;
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

    /// Executions started through this handle that were not waited for or cancelled yet.
    pub fn started_ids(&self) -> Vec<String> {
        self.started.lock().map(|s| s.keys().cloned().collect()).unwrap_or_default()
    }

    /// Sends StopQueryExecution for every recorded execution in a background task, so the
    /// caller does not wait for AWS. Best effort: failures are only logged to stderr and
    /// nothing is re-run.
    fn stop_started(&self) {
        let ids = self.started_ids();
        if ids.is_empty() {
            return;
        }
        let client = self.client.clone();
        tokio::spawn(async move {
            for id in ids {
                let sent = client.stop_query_execution().query_execution_id(&id).send().await;
                if let Err(err) = sent {
                    eprintln!(
                        "athena: could not stop execution {id}: {}",
                        DisplayErrorContext(&err)
                    );
                }
            }
        });
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

    /// Drops the cached handle after asking Athena to stop the executions it started and
    /// nobody waited for (connection deleted or edited). Removing an unknown id is a no-op.
    pub async fn remove(&self, id: &str) {
        let removed = self.handles.write().await.remove(id);
        if let Some(handle) = removed {
            handle.stop_started();
        }
    }

    /// Drops the cached handle without touching its executions, so the next call builds a
    /// fresh client (credential failure, output bucket created). Unknown ids are a no-op.
    pub async fn invalidate(&self, id: &str) {
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
        clients.invalidate("a").await;
    }

    /// A handle built offline: constructing SDK clients makes no AWS call.
    fn offline_handle() -> AthenaHandle {
        let sdk =
            SdkConfig::builder().behavior_version(aws_config::BehaviorVersion::latest()).build();
        AthenaHandle {
            client: Client::new(&sdk),
            sdk,
            config: keys_config(),
            output: RwLock::new(ResolvedOutput::Managed),
            started: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn started_ids_track_record_and_forget() {
        let handle = offline_handle();
        assert!(handle.started_ids().is_empty());
        handle.record_start("e1");
        handle.record_start("e2");
        let mut ids = handle.started_ids();
        ids.sort();
        assert_eq!(ids, ["e1", "e2"]);
        assert!(handle.started_at("e1").is_some());
        handle.forget_start("e1");
        assert_eq!(handle.started_ids(), ["e2"]);
        handle.forget_start("unknown");
        assert_eq!(handle.started_ids(), ["e2"]);
    }
}
