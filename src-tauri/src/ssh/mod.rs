//! SSH tunnels for MySQL connections: host key checks, authentication and local port
//! forwarding (russh).

mod auth;
mod known_hosts;
mod tunnel;

pub use auth::PASSPHRASE_REQUIRED;
pub use known_hosts::{
    HostKeyStatus, KNOWN_HOSTS_FILE, KnownHosts, describe_key, host_token, key_line,
};
pub use tunnel::{KEEPALIVE_INTERVAL, OPEN_TIMEOUT, SshTunnel, TunnelRequest};

use crate::connections::MysqlConnectionConfig;
use crate::error::{AppError, AppResult};

/// The tunnel a MySQL config needs, if any. `secret` is the SSH password or key passphrase.
pub fn tunnel_request(
    config: &MysqlConnectionConfig,
    secret: Option<String>,
    known_hosts: &KnownHosts,
) -> AppResult<Option<TunnelRequest>> {
    let Some(ssh) = &config.ssh else { return Ok(None) };
    let port = u16::try_from(config.port)
        .map_err(|_| AppError::InvalidInput(format!("invalid port {}", config.port)))?;
    Ok(Some(TunnelRequest::new(ssh.clone(), &config.host, port, secret, known_hosts.clone())))
}
