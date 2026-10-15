//! One pooled MySQL session per connection id, with connection-loss tracking and the
//! retry-once policy for connection-level errors.

use std::future::Future;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use sqlx::pool::PoolConnection;
use sqlx::{Connection, MySql, MySqlPool};
use tokio::task::AbortHandle;

use super::errors::{OpError, POOL_BUSY, describe_sqlx_error};
use super::events::StateSink;
use super::model::{MysqlStateEvent, SessionState};
use crate::error::{AppError, AppResult};

const PING_TIMEOUT: Duration = Duration::from_secs(10);

/// Counts connections the session handed out; dropping the lease gives the slot back.
struct Lease(Arc<AtomicU32>);

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A pooled connection checked out by a query. Derefs to the sqlx connection.
pub struct MysqlConn {
    conn: PoolConnection<MySql>,
    _lease: Lease,
}

impl Deref for MysqlConn {
    type Target = PoolConnection<MySql>;

    fn deref(&self) -> &Self::Target {
        &self.conn
    }
}

impl DerefMut for MysqlConn {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.conn
    }
}

/// Outcome of one background health check.
enum PingOutcome {
    Alive,
    Failed(String),
    /// Every pooled connection is checked out; nothing was checked.
    Busy,
}

pub struct MysqlSession {
    id: String,
    pool: MySqlPool,
    /// Connections currently checked out through [`MysqlSession::acquire`].
    in_use: Arc<AtomicU32>,
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
            in_use: Arc::new(AtomicU32::new(0)),
            default_database,
            lost: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            state: Mutex::new(SessionState::Connected),
            sink,
            ping_task: Mutex::new(None),
        }
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

    fn max_connections(&self) -> u32 {
        self.pool.options().get_max_connections()
    }

    /// Checks out a connection. An acquire timeout while every connection is held by this
    /// session's own work is [`POOL_BUSY`] (`connection`, never retried, no state change);
    /// otherwise the pool could not open a connection in time, which is a lost connection.
    pub async fn acquire(&self) -> Result<MysqlConn, OpError> {
        match self.pool.acquire().await {
            Ok(conn) => {
                self.in_use.fetch_add(1, Ordering::SeqCst);
                Ok(MysqlConn { conn, _lease: Lease(Arc::clone(&self.in_use)) })
            }
            Err(sqlx::Error::PoolTimedOut)
                if self.in_use.load(Ordering::SeqCst) >= self.max_connections() =>
            {
                Err(OpError::App(AppError::Connection(POOL_BUSY.into())))
            }
            Err(sqlx::Error::PoolTimedOut) => {
                Err(OpError::Sql(sqlx::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "could not open a connection to the server in time",
                ))))
            }
            Err(err) => Err(err.into()),
        }
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

    /// Pings an idle connection without the pool's own test, so a dead one is noticed rather
    /// than silently replaced. When every open connection is checked out (running queries) the
    /// check is skipped: waiting would only measure the queries, and opening another
    /// connection would grow the pool. Only an empty pool opens a new connection to check.
    async fn check_once(&self) -> PingOutcome {
        let mut conn = match self.pool.try_acquire() {
            Some(conn) => conn,
            None if self.pool.size() > 0 => return PingOutcome::Busy,
            None => match self.pool.acquire().await {
                Ok(conn) => conn,
                Err(err) => return PingOutcome::Failed(describe_sqlx_error(&err)),
            },
        };
        match conn.ping().await {
            Ok(()) => PingOutcome::Alive,
            Err(err) => {
                // Do not hand the dead connection to the next query.
                conn.close_on_drop();
                PingOutcome::Failed(describe_sqlx_error(&err))
            }
        }
    }

    /// Background health check; a busy pool leaves the state unchanged.
    pub async fn ping(&self) {
        let outcome = tokio::time::timeout(PING_TIMEOUT, self.check_once())
            .await
            .unwrap_or_else(|_| PingOutcome::Failed("ping timed out".into()));
        match outcome {
            PingOutcome::Busy => {}
            PingOutcome::Alive => self.set_state(SessionState::Connected, None),
            PingOutcome::Failed(message) => {
                self.mark_lost();
                self.set_state(SessionState::Error, Some(message));
            }
        }
    }

    /// Stops the health check and closes the pool in the background: `pool.close()` waits for
    /// checked-out connections, and a disconnect must not block on a running query. New
    /// acquires fail immediately with `PoolClosed`.
    ///
    /// Spawned on Tauri's runtime, so it also works outside a Tokio context (e.g. app exit).
    pub fn shutdown(&self) {
        let pool = self.stop();
        tauri::async_runtime::spawn(async move { pool.close().await });
    }

    /// Like [`MysqlSession::shutdown`] but waits until the pool is closed, which includes
    /// waiting for checked-out connections; callers bound it with a timeout.
    pub async fn close(&self) {
        self.stop().close().await;
    }

    /// Marks the session closed, stops the health check and returns the pool to close.
    fn stop(&self) -> MySqlPool {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut task) = self.ping_task.lock()
            && let Some(handle) = task.take()
        {
            handle.abort();
        }
        self.pool.clone()
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
