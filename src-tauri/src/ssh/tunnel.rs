//! Local port forwarding over one SSH session: `127.0.0.1:<random port>` → `target` as seen
//! from the bastion.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::Disconnect;
use russh::client::{self, Handle};
use russh::keys::{PublicKey, PublicKeyOrCertificate};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{AbortHandle, JoinSet};

use super::auth::authenticate;
use super::known_hosts::KnownHosts;
use crate::connections::SshConfig;
use crate::error::{AppError, AppResult};

/// Upper bound for TCP connect, key exchange and authentication.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// A keepalive is sent after this long without traffic from the server.
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// Unanswered keepalives before the session counts as dropped.
const KEEPALIVE_MAX: usize = 3;
/// Pause after a failed `accept` (for example too many open files) before trying again.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

/// Everything needed to open (and later re-open) a tunnel. The secret is kept for re-opening
/// and never printed.
#[derive(Clone)]
pub struct TunnelRequest {
    pub ssh: SshConfig,
    pub target_host: String,
    pub target_port: u16,
    secret: Option<String>,
    known_hosts: KnownHosts,
}

impl std::fmt::Debug for TunnelRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelRequest")
            .field("ssh", &self.ssh)
            .field("target_host", &self.target_host)
            .field("target_port", &self.target_port)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl TunnelRequest {
    pub fn new(
        ssh: SshConfig,
        target_host: &str,
        target_port: u16,
        secret: Option<String>,
        known_hosts: KnownHosts,
    ) -> Self {
        Self { ssh, target_host: target_host.to_string(), target_port, secret, known_hosts }
    }

    fn ssh_port(&self) -> AppResult<u16> {
        u16::try_from(self.ssh.port)
            .map_err(|_| AppError::InvalidInput(format!("invalid ssh port {}", self.ssh.port)))
    }
}

/// Why the SSH handshake stopped.
#[derive(Debug)]
pub enum HandlerError {
    Ssh(russh::Error),
    /// The host key check rejected the server (`ssh_host_key`).
    Rejected(AppError),
}

impl From<russh::Error> for HandlerError {
    fn from(value: russh::Error) -> Self {
        HandlerError::Ssh(value)
    }
}

pub struct TunnelHandler {
    host: String,
    port: u16,
    known_hosts: KnownHosts,
}

impl client::Handler for TunnelHandler {
    type Error = HandlerError;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        self.known_hosts
            .verify(&self.host, self.port, &key)
            .map(|()| true)
            .map_err(HandlerError::Rejected)
    }
}

/// An open tunnel. Dropping it closes the SSH session and the local listener.
pub struct SshTunnel {
    handle: Arc<Handle<TunnelHandler>>,
    local_addr: SocketAddr,
    accept: AbortHandle,
    closed: AtomicBool,
    /// Last failure opening a forward, so a database error on the local port can be explained.
    forward_error: Arc<Mutex<Option<String>>>,
}

fn ssh_config() -> client::Config {
    client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: KEEPALIVE_MAX,
        nodelay: true,
        ..Default::default()
    }
}

fn handshake_error(err: HandlerError, target: &str) -> AppError {
    match err {
        HandlerError::Rejected(err) => err,
        HandlerError::Ssh(russh::Error::IO(err)) => {
            AppError::Ssh(format!("could not reach the SSH server {target}: {err}"))
        }
        HandlerError::Ssh(err) => {
            AppError::Ssh(format!("SSH handshake with {target} failed: {err}"))
        }
    }
}

async fn connect(request: &TunnelRequest) -> AppResult<Handle<TunnelHandler>> {
    let port = request.ssh_port()?;
    let host = request.ssh.host.clone();
    let target = format!("{host}:{port}");
    let handler =
        TunnelHandler { host: host.clone(), port, known_hosts: request.known_hosts.clone() };
    let mut handle = client::connect(Arc::new(ssh_config()), (host.as_str(), port), handler)
        .await
        .map_err(|e| handshake_error(e, &target))?;
    authenticate(&mut handle, &request.ssh, request.secret.as_deref()).await?;
    Ok(handle)
}

impl SshTunnel {
    /// Connects to the bastion, checks its host key, authenticates and starts forwarding from a
    /// new local port.
    pub async fn open(request: &TunnelRequest) -> AppResult<SshTunnel> {
        let handle =
            tokio::time::timeout(OPEN_TIMEOUT, connect(request)).await.map_err(|_| {
                AppError::Ssh(format!(
                    "connecting to the SSH server {}:{} timed out after {}s",
                    request.ssh.host,
                    request.ssh.port,
                    OPEN_TIMEOUT.as_secs()
                ))
            })??;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| AppError::Ssh(format!("could not open the local tunnel port: {e}")))?;
        let local_addr = listener.local_addr()?;
        let handle = Arc::new(handle);
        let forward_error = Arc::new(Mutex::new(None));
        let target = Target {
            host: request.target_host.clone(),
            port: request.target_port,
            error: Arc::clone(&forward_error),
        };
        let accept = tokio::spawn(accept_loop(listener, Arc::clone(&handle), target));
        Ok(SshTunnel {
            handle,
            local_addr,
            accept: accept.abort_handle(),
            closed: AtomicBool::new(false),
            forward_error,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// False once the tunnel was closed, the SSH session ended (server disconnect, network
    /// failure, unanswered keepalives) or the listener stopped.
    pub fn is_alive(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
            && !self.handle.is_closed()
            && !self.accept.is_finished()
    }

    /// The last forward the server refused, as an SSH error, if any.
    pub fn take_forward_error(&self) -> Option<AppError> {
        let mut slot = self.forward_error.lock().unwrap_or_else(|e| e.into_inner());
        slot.take().map(AppError::Ssh)
    }

    /// Stops the listener and forwarded connections and ends the SSH session. Idempotent; works
    /// outside a Tokio runtime (the session then ends when the last handle is dropped).
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.accept.abort();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let handle = Arc::clone(&self.handle);
            runtime.spawn(async move {
                let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
            });
        }
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.close();
    }
}

struct Target {
    host: String,
    port: u16,
    error: Arc<Mutex<Option<String>>>,
}

/// Accepts local connections until aborted; each one is forwarded in its own task, which is
/// aborted with the loop.
async fn accept_loop(listener: TcpListener, handle: Arc<Handle<TunnelHandler>>, target: Target) {
    let target = Arc::new(target);
    let mut forwards = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    forwards.spawn(forward(stream, peer, Arc::clone(&handle), Arc::clone(&target)));
                }
                Err(err) => {
                    eprintln!("SSH tunnel could not accept a local connection: {err}");
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                }
            },
            Some(_) = forwards.join_next(), if !forwards.is_empty() => {}
        }
        if handle.is_closed() {
            break;
        }
    }
}

async fn forward(
    mut local: TcpStream,
    peer: SocketAddr,
    handle: Arc<Handle<TunnelHandler>>,
    target: Arc<Target>,
) {
    let opened = handle
        .channel_open_direct_tcpip(
            target.host.as_str(),
            u32::from(target.port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await;
    let channel = match opened {
        Ok(channel) => channel,
        Err(err) => {
            let message =
                format!("The SSH server did not forward to {}:{}: {err}", target.host, target.port);
            eprintln!("{message}");
            *target.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(message);
            return;
        }
    };
    let mut remote = channel.into_stream();
    // Either side closing ends the forward; errors only mean the connection is gone.
    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
}
