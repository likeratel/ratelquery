//! One pooled MySQL session per connection id, with connection-loss tracking and the
//! retry-once policy for connection-level errors.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use sqlx::pool::PoolConnection;
use sqlx::{Connection, MySql, MySqlPool};
use tokio::task::AbortHandle;

use super::errors::{OpError, describe_sqlx_error};
use super::events::StateSink;
use super::model::{MysqlStateEvent, SessionState};
use crate::error::AppResult;

const PING_TIMEOUT: Duration = Duration::from_secs(10);

pub type MysqlConn = PoolConnection<MySql>;

pub struct MysqlSession {
    id: String,
    pool: MySqlPool,
    default_database: Option<String>,
    /// Set when the session observed a lost connection; the next successful result reports
    /// `reconnected: true` and clears it.
    lost: AtomicBool,
    /// Set once the session left the registry; later state changes are not reported.
    closed: AtomicBool,
    state: Mutex<SessionState>,
    sink: Arc<dyn StateSink>,
    ping_task: Mutex<Option<AbortHandle>>,
}

impl MysqlSession {
    pub fn new(
        id: &str,
        pool: MySqlPool,
        default_database: Option<String>,
        sink: Arc<dyn StateSink>,
    ) -> Self {
        Self {
            id: id.to_string(),
            pool,
            default_database,
            lost: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            state: Mutex::new(SessionState::Connected),
            sink,
            ping_task: Mutex::new(None),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn pool(&self) -> &MySqlPool {
        &self.pool
    }

    pub fn default_database(&self) -> Option<&str> {
        self.default_database.as_deref()
    }

    /// Emits a state event when the state changes. A closed session stays silent so a query
    /// that finishes after `mysql_disconnect` cannot report a stale state.
    pub fn set_state(&self, state: SessionState, message: Option<String>) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let changed = match self.state.lock() {
            Ok(mut current) => {
                let changed = *current != state;
                *current = state;
                changed
            }
            Err(_) => true,
        };
        if changed {
            self.sink.emit(MysqlStateEvent { connection_id: self.id.clone(), state, message });
        }
    }

    /// A round trip succeeded: leaves `error` / `reconnecting` (e.g. after a failed ping).
    pub fn mark_healthy(&self) {
        self.set_state(SessionState::Connected, None);
    }

    pub fn mark_lost(&self) {
        self.lost.store(true, Ordering::SeqCst);
    }

    pub fn take_lost(&self) -> bool {
        self.lost.swap(false, Ordering::SeqCst)
    }

    pub fn set_ping_task(&self, handle: AbortHandle) {
        if let Ok(mut task) = self.ping_task.lock()
            && let Some(previous) = task.replace(handle)
        {
            previous.abort();
        }
    }

    pub async fn acquire(&self) -> Result<MysqlConn, sqlx::Error> {
        self.pool.acquire().await
    }

    /// After a non-connection error, checks whether the connection survived (for example a
    /// `KILL CONNECTION_ID()`); if not, the next result is flagged as reconnected.
    pub async fn note_if_dead(&self, conn: &mut MysqlConn) {
        if conn.ping().await.is_err() {
            self.mark_lost();
        }
    }

    /// Runs `op` on a pooled connection. A connection-level failure is retried once on a new
    /// connection; the result then reports `reconnected == true`.
    pub async fn run<T, F>(&self, op: F) -> AppResult<(T, bool)>
    where
        F: Fn(MysqlConn) -> BoxFuture<'static, Result<T, OpError>>,
    {
        let pending = self.take_lost();
        let first = self.attempt(&op).await;
        match first {
            Ok(value) => {
                self.mark_healthy();
                Ok((value, pending))
            }
            Err(err) if err.is_connection_level() => self.retry(&op, err).await,
            Err(err) => {
                if pending {
                    self.mark_lost();
                }
                Err(err.into_app_error())
            }
        }
    }

    async fn attempt<T, F>(&self, op: &F) -> Result<T, OpError>
    where
        F: Fn(MysqlConn) -> BoxFuture<'static, Result<T, OpError>>,
    {
        let conn = self.acquire().await?;
        op(conn).await
    }

    async fn retry<T, F>(&self, op: &F, first: OpError) -> AppResult<(T, bool)>
    where
        F: Fn(MysqlConn) -> BoxFuture<'static, Result<T, OpError>>,
    {
        self.set_state(SessionState::Reconnecting, Some(op_message(&first)));
        let second = self.attempt(op).await;
        self.finish_retry(second).map(|value| (value, true))
    }

    /// Updates state after a retry and converts the outcome into the final result.
    pub fn finish_retry<T>(&self, outcome: Result<T, OpError>) -> AppResult<T> {
        match outcome {
            Ok(value) => {
                self.set_state(SessionState::Connected, None);
                Ok(value)
            }
            Err(err) if err.is_connection_level() => {
                self.mark_lost();
                self.set_state(SessionState::Error, Some(op_message(&err)));
                Err(err.into_app_error())
            }
            Err(err) => {
                self.set_state(SessionState::Connected, None);
                Err(err.into_app_error())
            }
        }
    }

    /// Background health check: acquires a connection (the pool pings it) and pings again.
    pub async fn ping(&self) {
        let check = async {
            let mut conn = self.acquire().await?;
            conn.ping().await
        };
        match tokio::time::timeout(PING_TIMEOUT, check).await {
            Ok(Ok(())) => self.set_state(SessionState::Connected, None),
            Ok(Err(err)) => {
                self.mark_lost();
                self.set_state(SessionState::Error, Some(describe_sqlx_error(&err)));
            }
            Err(_) => {
                self.mark_lost();
                self.set_state(SessionState::Error, Some("ping timed out".into()));
            }
        }
    }

    /// Stops the health check and closes the pool in the background: `pool.close()` waits for
    /// checked-out connections, and a disconnect must not block on a running query. New
    /// acquires fail immediately with `PoolClosed`.
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut task) = self.ping_task.lock()
            && let Some(handle) = task.take()
        {
            handle.abort();
        }
        let pool = self.pool.clone();
        tokio::spawn(async move { pool.close().await });
    }
}

pub fn op_message(err: &OpError) -> String {
    match err {
        OpError::Sql(e) => describe_sqlx_error(e),
        OpError::App(e) => e.to_string(),
    }
}

/// Boxes an async closure body for [`MysqlSession::run`].
pub fn boxed<T, Fut>(future: Fut) -> BoxFuture<'static, Result<T, OpError>>
where
    Fut: Future<Output = Result<T, OpError>> + Send + 'static,
{
    Box::pin(future)
}
