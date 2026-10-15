use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::sync::RwLock;

use super::errors::connection_error;
use super::events::StateSink;
use super::model::{MysqlSessionInfo, MysqlStateEvent, SessionState};
use super::options::{
    ACQUIRE_TIMEOUT, connect_options, fetch_current_database, fetch_server_version, pool_options,
};
use super::session::MysqlSession;
use crate::connections::{ConnectionConfig, ConnectionsService, MysqlConnectionConfig};
use crate::error::{AppError, AppResult};
use crate::util::run_blocking;

pub const PING_INTERVAL: Duration = Duration::from_secs(30);

/// All open MySQL sessions keyed by connection id.
///
/// The registry is the single owner of a connection's state: every insert or removal emits its
/// state event while the map is locked, so the last event always matches whether a session is
/// open.
pub struct MysqlSessions {
    sessions: RwLock<HashMap<String, Arc<MysqlSession>>>,
    sink: Arc<dyn StateSink>,
    ping_interval: Duration,
    acquire_timeout: Duration,
}

fn spawn_ping(session: &Arc<MysqlSession>, period: Duration) {
    let weak: Weak<MysqlSession> = Arc::downgrade(session);
    let task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let Some(session) = weak.upgrade() else { break };
            session.ping().await;
        }
    });
    session.set_ping_task(task.abort_handle());
}

impl MysqlSessions {
    pub fn new(sink: Arc<dyn StateSink>) -> Self {
        Self::with_ping_interval(sink, PING_INTERVAL)
    }

    pub fn with_ping_interval(sink: Arc<dyn StateSink>, ping_interval: Duration) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            sink,
            ping_interval,
            acquire_timeout: ACQUIRE_TIMEOUT,
        }
    }

    /// Same registry with a different pool acquire timeout for sessions opened later.
    pub fn with_acquire_timeout(self, acquire_timeout: Duration) -> Self {
        Self { acquire_timeout, ..self }
    }

    fn emit(&self, id: &str, state: SessionState, message: Option<String>) {
        self.sink.emit(MysqlStateEvent { connection_id: id.to_string(), state, message });
    }

    /// Opens the pool for `id` and returns server info. An open session for `id` is closed
    /// first (`disconnected`), so a failed reconnect ends in `error` with no session left
    /// instead of a live session the UI shows as failed.
    pub async fn connect(
        &self,
        id: &str,
        config: &MysqlConnectionConfig,
        password: Option<&str>,
    ) -> AppResult<MysqlSessionInfo> {
        self.disconnect(id).await;
        self.emit(id, SessionState::Connecting, None);
        match self.open(id, config, password).await {
            Ok((session, info)) => {
                spawn_ping(&session, self.ping_interval);
                let previous = {
                    let mut sessions = self.sessions.write().await;
                    let previous = sessions.insert(id.to_string(), session);
                    self.emit(id, SessionState::Connected, None);
                    previous
                };
                // Only a concurrent connect for the same id can leave one; it is replaced.
                if let Some(previous) = previous {
                    previous.shutdown();
                }
                Ok(info)
            }
            Err(err) => {
                let stale = {
                    let mut sessions = self.sessions.write().await;
                    let stale = sessions.remove(id);
                    self.emit(id, SessionState::Error, Some(err.to_string()));
                    stale
                };
                if let Some(stale) = stale {
                    stale.shutdown();
                }
                Err(err)
            }
        }
    }

    /// Opens the saved connection `id`. A given `secret` is used for this session only and is
    /// never stored; without one the stored secret (if any) is used. The config file and the
    /// secret store are read on the blocking pool.
    pub async fn connect_saved(
        &self,
        connections: &Arc<ConnectionsService>,
        id: &str,
        secret: Option<&str>,
    ) -> AppResult<MysqlSessionInfo> {
        let connections = Arc::clone(connections);
        let (owned_id, secret) = (id.to_string(), secret.map(str::to_string));
        let (config, password) = run_blocking(move || {
            let ConnectionConfig::Mysql(config) = connections.get(&owned_id)? else {
                return Err(AppError::InvalidInput(format!(
                    "{owned_id} is not a MySQL connection"
                )));
            };
            let password = connections.resolve_secret(&owned_id, secret.as_deref())?;
            Ok((config, password))
        })
        .await?;
        self.connect(id, &config, password.as_deref()).await
    }

    async fn open(
        &self,
        id: &str,
        config: &MysqlConnectionConfig,
        password: Option<&str>,
    ) -> AppResult<(Arc<MysqlSession>, MysqlSessionInfo)> {
        let options = connect_options(config, password)?;
        let pool = pool_options(self.acquire_timeout)
            .connect_with(options)
            .await
            .map_err(|e| connection_error(&e))?;
        let info = async {
            let mut conn = pool.acquire().await?;
            let server_version = fetch_server_version(&mut conn).await?;
            let current_database = fetch_current_database(&mut conn).await?;
            Ok::<_, sqlx::Error>(MysqlSessionInfo { server_version, current_database })
        }
        .await;
        match info {
            Ok(info) => {
                let session =
                    MysqlSession::new(id, pool, config.database.clone(), Arc::clone(&self.sink));
                Ok((Arc::new(session), info))
            }
            Err(err) => {
                pool.close().await;
                Err(connection_error(&err))
            }
        }
    }

    pub async fn get(&self, id: &str) -> AppResult<Arc<MysqlSession>> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("MySQL connection {id} is not open")))
    }

    pub async fn is_open(&self, id: &str) -> bool {
        self.sessions.read().await.contains_key(id)
    }

    /// Removes every session and waits for their pools to close (app exit). No state events
    /// are emitted. Waits for running queries, so the caller bounds it with a timeout.
    pub async fn shutdown_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.write().await);
        futures_util::future::join_all(sessions.values().map(|session| session.close())).await;
    }

    /// Closes the session if open without waiting for running queries (they finish on their
    /// own connection; the pool closes afterwards). Closing an unknown id is a no-op.
    pub async fn disconnect(&self, id: &str) {
        let removed = {
            let mut sessions = self.sessions.write().await;
            let removed = sessions.remove(id);
            if removed.is_some() {
                self.emit(id, SessionState::Disconnected, None);
            }
            removed
        };
        if let Some(session) = removed {
            session.shutdown();
        }
    }
}
