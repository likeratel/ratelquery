use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::sync::RwLock;

use super::errors::connection_error;
use super::events::StateSink;
use super::model::{MysqlSessionInfo, MysqlStateEvent, SessionState};
use super::options::{connect_options, fetch_current_database, fetch_server_version, pool_options};
use super::session::MysqlSession;
use crate::connections::MysqlConnectionConfig;
use crate::error::{AppError, AppResult};

pub const PING_INTERVAL: Duration = Duration::from_secs(30);

/// All open MySQL sessions keyed by connection id.
pub struct MysqlSessions {
    sessions: RwLock<HashMap<String, Arc<MysqlSession>>>,
    sink: Arc<dyn StateSink>,
    ping_interval: Duration,
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
        Self { sessions: RwLock::new(HashMap::new()), sink, ping_interval }
    }

    fn emit(&self, id: &str, state: SessionState, message: Option<String>) {
        self.sink.emit(MysqlStateEvent { connection_id: id.to_string(), state, message });
    }

    /// Opens (or reopens) the pool for `id` and returns server info.
    pub async fn connect(
        &self,
        id: &str,
        config: &MysqlConnectionConfig,
        password: Option<&str>,
    ) -> AppResult<MysqlSessionInfo> {
        self.emit(id, SessionState::Connecting, None);
        match self.open(id, config, password).await {
            Ok((session, info)) => {
                spawn_ping(&session, self.ping_interval);
                let previous = self.sessions.write().await.insert(id.to_string(), session);
                if let Some(previous) = previous {
                    previous.close().await;
                }
                self.emit(id, SessionState::Connected, None);
                Ok(info)
            }
            Err(err) => {
                self.emit(id, SessionState::Error, Some(err.to_string()));
                Err(err)
            }
        }
    }

    async fn open(
        &self,
        id: &str,
        config: &MysqlConnectionConfig,
        password: Option<&str>,
    ) -> AppResult<(Arc<MysqlSession>, MysqlSessionInfo)> {
        let options = connect_options(config, password)?;
        let pool = pool_options().connect_with(options).await.map_err(|e| connection_error(&e))?;
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

    /// Closes the session if open. Closing an unknown id is a no-op.
    pub async fn disconnect(&self, id: &str) {
        let removed = self.sessions.write().await.remove(id);
        if let Some(session) = removed {
            session.close().await;
            self.emit(id, SessionState::Disconnected, None);
        }
    }
}
