//! The SSH tunnel a MySQL session owns, and re-opening it when the SSH session dropped.

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use sqlx::MySqlPool;
use sqlx::mysql::MySqlConnectOptions;

use super::options::pool_options;
use crate::error::AppResult;
use crate::ssh::{SshTunnel, TunnelRequest};

/// Message of the `reconnecting` state while the tunnel is re-opened.
pub const TUNNEL_DOWN: &str = "The SSH tunnel closed; reopening it";
const LOOPBACK: &str = "127.0.0.1";

/// The MySQL options pointed at the local end of `tunnel`.
pub fn through(options: &MySqlConnectOptions, tunnel: &SshTunnel) -> MySqlConnectOptions {
    options.clone().host(LOOPBACK).port(tunnel.local_addr().port())
}

pub struct SessionTunnel {
    request: TunnelRequest,
    /// Connect options with the real MySQL address (as seen from the bastion).
    options: MySqlConnectOptions,
    acquire_timeout: Duration,
    /// `None` once the session closed.
    current: Mutex<Option<SshTunnel>>,
    /// Serializes re-opening so concurrent queries open one tunnel.
    reopening: tokio::sync::Mutex<()>,
}

impl SessionTunnel {
    pub fn new(
        request: TunnelRequest,
        tunnel: SshTunnel,
        options: MySqlConnectOptions,
        acquire_timeout: Duration,
    ) -> Self {
        Self {
            request,
            options,
            acquire_timeout,
            current: Mutex::new(Some(tunnel)),
            reopening: tokio::sync::Mutex::new(()),
        }
    }

    pub fn lock(&self) -> MutexGuard<'_, Option<SshTunnel>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True while the current tunnel works; false when it dropped or the session closed.
    pub fn is_alive(&self) -> bool {
        self.lock().as_ref().is_some_and(SshTunnel::is_alive)
    }

    pub async fn reopening(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.reopening.lock().await
    }

    /// Opens a new tunnel and a (lazy) pool through it. Nothing is installed yet.
    pub async fn open(&self) -> AppResult<(SshTunnel, MySqlPool)> {
        let tunnel = SshTunnel::open(&self.request).await?;
        let pool =
            pool_options(self.acquire_timeout).connect_lazy_with(through(&self.options, &tunnel));
        Ok((tunnel, pool))
    }

    /// Closes the current tunnel (the session stays; the next use re-opens it). Returns false
    /// when the session already closed.
    pub fn close_current(&self) -> bool {
        match self.lock().as_ref() {
            Some(tunnel) => {
                tunnel.close();
                true
            }
            None => false,
        }
    }
}
