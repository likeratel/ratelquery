//! One pooled MySQL session per connection id, with connection-loss tracking and the
//! retry-once policy for connection-level errors.

use std::future::Future;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use sqlx::pool::PoolConnection;
use sqlx::{Connection, MySql, MySqlPool};
use tokio::task::AbortHandle;

use super::errors::{OpError, POOL_BUSY, describe_sqlx_error};
use super::events::StateSink;
use super::model::{MysqlStateEvent, SessionState};
use super::tunnel::{SessionTunnel, TUNNEL_DOWN};
use crate::error::{AppError, AppResult};

const PING_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a connection kept for continuing a stopped script waits for the user.
pub const RESUME_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// A connection kept out of the pool after a script stopped at a DELETE that couldn't be backed
/// up, so continuing it sees the same session state (variables, `SET SESSION`, `USE`).
struct Parked {
    token: String,
    /// The run the connection was kept for; continuing another text or statement is refused.
    resume: ResumePoint,
    conn: MysqlConn,
    expires: Instant,
}

/// Where a stopped run continues: a hash of its SQL text and the statement it stopped at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResumePoint {
    pub sql_hash: u64,
    pub statement_index: usize,
}

impl ResumePoint {
    pub fn new(sql: &str, statement_index: usize) -> Self {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        sql.hash(&mut hasher);
        Self { sql_hash: hasher.finish(), statement_index }
    }
}

/// Why a kept connection could not be taken back.
#[derive(Debug, PartialEq, Eq)]
pub enum ResumeRefused {
    /// No connection is kept for the token (expired, released, replaced or closed).
    Gone,
    /// The token is for another script text or statement.
    Mismatch,
}

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
    /// Replaced when the SSH tunnel is re-opened (the old pool is closed).
    pool: RwLock<MySqlPool>,
    /// The SSH tunnel the pool connects through, if the connection uses one.
    tunnel: Option<SessionTunnel>,
    /// Set when the tunnel was re-opened; the next successful result reports
    /// `reconnected: true`.
    reopened: AtomicBool,
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
    /// At most one kept connection per session, so it never takes more than one pool slot.
    parked: Mutex<Option<Parked>>,
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
            pool: RwLock::new(pool),
            tunnel: None,
            reopened: AtomicBool::new(false),
            in_use: Arc::new(AtomicU32::new(0)),
            default_database,
            lost: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            state: Mutex::new(SessionState::Connected),
            sink,
            ping_task: Mutex::new(None),
            parked: Mutex::new(None),
        }
    }

    /// The session owns `tunnel`; the pool must connect through it.
    pub fn with_tunnel(self, tunnel: SessionTunnel) -> Self {
        Self { tunnel: Some(tunnel), ..self }
    }

    /// The current pool (a cheap handle). It changes when the SSH tunnel is re-opened.
    pub fn pool(&self) -> MySqlPool {
        self.pool.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// `Some(alive)` for a tunnelled session, `None` for a direct one.
    pub fn tunnel_alive(&self) -> Option<bool> {
        self.tunnel.as_ref().map(SessionTunnel::is_alive)
    }

    /// Closes the SSH tunnel but keeps the session, as if the SSH connection dropped: the next
    /// use (or health check) re-opens it.
    pub fn close_tunnel(&self) {
        if let Some(tunnel) = &self.tunnel {
            tunnel.close_current();
        }
    }

    /// Whether the tunnel was re-opened since the last call (then the result is reported as
    /// reconnected).
    pub fn take_reopened(&self) -> bool {
        self.reopened.swap(false, Ordering::SeqCst)
    }

    /// Re-opens a dropped SSH tunnel and switches to a new pool through it; a no-op for direct
    /// sessions and live tunnels. On failure the state becomes `error` with the SSH message.
    pub async fn restore_tunnel(&self) -> Result<(), OpError> {
        let Some(tunnel) = &self.tunnel else { return Ok(()) };
        if tunnel.is_alive() {
            return Ok(());
        }
        let _reopening = tunnel.reopening().await;
        if tunnel.is_alive() {
            return Ok(());
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(OpError::Sql(sqlx::Error::PoolClosed));
        }
        self.set_state(SessionState::Reconnecting, Some(TUNNEL_DOWN.into()));
        let (new_tunnel, new_pool) = match tunnel.open().await {
            Ok(opened) => opened,
            Err(err) => {
                self.mark_lost();
                self.set_state(SessionState::Error, Some(err.to_string()));
                return Err(OpError::App(err));
            }
        };
        let old_pool = {
            let mut current = tunnel.lock();
            if current.is_none() {
                // The session closed meanwhile; do not leave the new tunnel behind.
                drop(current);
                new_tunnel.close();
                tauri::async_runtime::spawn(async move { new_pool.close().await });
                return Err(OpError::Sql(sqlx::Error::PoolClosed));
            }
            *current = Some(new_tunnel);
            let mut pool = self.pool.write().unwrap_or_else(|e| e.into_inner());
            std::mem::replace(&mut *pool, new_pool)
        };
        tauri::async_runtime::spawn(async move { old_pool.close().await });
        self.reopened.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn parked(&self) -> std::sync::MutexGuard<'_, Option<Parked>> {
        self.parked.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Keeps `conn` for [`RESUME_TIMEOUT`] and returns the token that takes it back. A
    /// connection kept earlier goes back to the pool. A closed session keeps nothing.
    pub fn park(&self, conn: MysqlConn, resume: ResumePoint) -> Option<String> {
        let mut parked = self.parked();
        // Checked under the lock: `stop` marks the session closed before it empties the slot.
        if self.closed.load(Ordering::SeqCst) {
            return None;
        }
        let token = uuid::Uuid::new_v4().to_string();
        let previous = parked.replace(Parked {
            token: token.clone(),
            resume,
            conn,
            expires: Instant::now() + RESUME_TIMEOUT,
        });
        drop(parked);
        drop(previous);
        Some(token)
    }

    /// The kept connection for `token`, when it is still kept and was kept for `resume`. An
    /// expired one is released; one kept for another run stays kept.
    pub fn take_parked(
        &self,
        token: &str,
        resume: ResumePoint,
    ) -> Result<MysqlConn, ResumeRefused> {
        let mut parked = self.parked();
        if parked.as_ref().is_some_and(|p| p.expires <= Instant::now()) {
            *parked = None;
        }
        match parked.take() {
            Some(p) if p.token == token && p.resume == resume => Ok(p.conn),
            Some(p) if p.token == token => {
                *parked = Some(p);
                Err(ResumeRefused::Mismatch)
            }
            other => {
                *parked = other;
                Err(ResumeRefused::Gone)
            }
        }
    }

    /// Gives the connection kept for `token` back to the pool (the user stopped the script).
    pub fn release_parked(&self, token: &str) {
        let mut parked = self.parked();
        if parked.as_ref().is_some_and(|p| p.token == token) {
            *parked = None;
        }
    }

    /// Releases a kept connection whose time is up; run by the health check.
    fn expire_parked(&self) {
        let mut parked = self.parked();
        if parked.as_ref().is_some_and(|p| p.expires <= Instant::now()) {
            *parked = None;
        }
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
        self.pool().options().get_max_connections()
    }

    /// Checks out a connection. An acquire timeout while every connection is held by this
    /// session's own work is [`POOL_BUSY`] (`connection`, never retried, no state change);
    /// otherwise the pool could not open a connection in time, which is a lost connection.
    ///
    /// A dropped SSH tunnel is re-opened first.
    pub async fn acquire(&self) -> Result<MysqlConn, OpError> {
        self.restore_tunnel().await?;
        match self.pool().acquire().await {
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
                Ok((value, pending || self.take_reopened()))
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
                self.take_reopened();
                self.set_state(SessionState::Connected, None);
                Ok(value)
            }
            // The tunnel could not be re-opened; `restore_tunnel` already reported `error`.
            Err(err) if err.is_tunnel_failure() => Err(err.into_app_error()),
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
        let pool = self.pool();
        let mut conn = match pool.try_acquire() {
            Some(conn) => conn,
            None if pool.size() > 0 => return PingOutcome::Busy,
            None => match pool.acquire().await {
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

    /// Background health check; a busy pool leaves the state unchanged. A dropped SSH tunnel is
    /// re-opened first (`reconnecting`, then `connected` or `error`).
    pub async fn ping(&self) {
        self.expire_parked();
        if self.restore_tunnel().await.is_err() {
            return;
        }
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
        let (pool, tunnel) = self.stop();
        tauri::async_runtime::spawn(async move {
            pool.close().await;
            drop(tunnel);
        });
    }

    /// Like [`MysqlSession::shutdown`] but waits until the pool is closed, which includes
    /// waiting for checked-out connections; callers bound it with a timeout.
    pub async fn close(&self) {
        let (pool, tunnel) = self.stop();
        pool.close().await;
        drop(tunnel);
    }

    /// Marks the session closed, stops the health check and returns the pool to close and the
    /// tunnel to close after it (so connections can end cleanly through it). Taking the tunnel
    /// stops any re-open from installing a new one.
    fn stop(&self) -> (MySqlPool, Option<crate::ssh::SshTunnel>) {
        self.closed.store(true, Ordering::SeqCst);
        // A kept connection must go back before the pool can close.
        let kept = self.parked().take();
        drop(kept);
        if let Ok(mut task) = self.ping_task.lock()
            && let Some(handle) = task.take()
        {
            handle.abort();
        }
        match &self.tunnel {
            Some(tunnel) => {
                let mut current = tunnel.lock();
                (self.pool(), current.take())
            }
            None => (self.pool(), None),
        }
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
