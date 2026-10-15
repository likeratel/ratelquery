//! `connections_test` probes: a real round trip to the server with the given config.

use std::time::{Duration, Instant};

use aws_sdk_dynamodb::error::DisplayErrorContext;
use sqlx::Connection;

use super::model::{ConnectionTestResult, DynamoConnectionConfig, MysqlConnectionConfig};
use crate::dynamo::sdk_config;
use crate::error::{AppError, AppResult};
use crate::mysql::{connect_options, describe_sqlx_error, fetch_server_version};
use crate::ssh::{SshTunnel, TunnelRequest};
use crate::util::elapsed_ms;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const LOOPBACK: &str = "127.0.0.1";

fn timed_out(what: &str) -> AppError {
    AppError::Connection(format!("{what} timed out after {}s", PROBE_TIMEOUT.as_secs()))
}

/// Connects once, runs `SELECT VERSION()` and closes the connection.
pub async fn probe_mysql(
    config: &MysqlConnectionConfig,
    password: Option<&str>,
) -> AppResult<ConnectionTestResult> {
    probe_mysql_via(config, password, None).await
}

/// [`probe_mysql`] through the SSH tunnel of `tunnel` (opened for the probe and closed after
/// it). The tunnel has its own timeout, followed by the probe timeout.
pub async fn probe_mysql_via(
    config: &MysqlConnectionConfig,
    password: Option<&str>,
    tunnel: Option<&TunnelRequest>,
) -> AppResult<ConnectionTestResult> {
    let options = connect_options(config, password)?;
    let start = Instant::now();
    let tunnel = match tunnel {
        Some(request) => Some(SshTunnel::open(request).await?),
        None => None,
    };
    let options = match &tunnel {
        Some(tunnel) => options.host(LOOPBACK).port(tunnel.local_addr().port()),
        None => options,
    };
    let work = async {
        let mut conn = sqlx::MySqlConnection::connect_with(&options).await?;
        let version = fetch_server_version(&mut conn).await?;
        conn.close().await?;
        Ok::<String, sqlx::Error>(version)
    };
    let version = tokio::time::timeout(PROBE_TIMEOUT, work)
        .await
        .map_err(|_| timed_out("MySQL connection"))?
        .map_err(|e| {
            tunnel
                .as_ref()
                .and_then(SshTunnel::take_forward_error)
                .unwrap_or_else(|| AppError::Connection(describe_sqlx_error(&e)))
        })?;
    Ok(ConnectionTestResult {
        ok: true,
        server_version: Some(version),
        latency_ms: elapsed_ms(start),
    })
}

/// `connections_test` reports every failure, credentials included, as `connection`.
fn as_connection_error(err: AppError) -> AppError {
    match err {
        AppError::Credential(message) => AppError::Connection(message),
        other => other,
    }
}

/// Loads credentials and calls `ListTables(limit 1)`.
pub async fn probe_dynamodb(
    config: &DynamoConnectionConfig,
    secret: Option<&str>,
) -> AppResult<ConnectionTestResult> {
    let start = Instant::now();
    let work = async {
        let sdk_config = sdk_config(config, secret).await.map_err(as_connection_error)?;
        let client = aws_sdk_dynamodb::Client::new(&sdk_config);
        client
            .list_tables()
            .limit(1)
            .send()
            .await
            .map_err(|e| AppError::Connection(DisplayErrorContext(&e).to_string()))
    };
    tokio::time::timeout(PROBE_TIMEOUT, work)
        .await
        .map_err(|_| timed_out("DynamoDB request"))??;
    Ok(ConnectionTestResult { ok: true, server_version: None, latency_ms: elapsed_ms(start) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::DynamoAuth;

    #[tokio::test]
    async fn missing_key_secret_is_a_connection_error() {
        let config = DynamoConnectionConfig {
            id: "x".into(),
            name: "x".into(),
            region: "ap-northeast-2".into(),
            endpoint: Some("http://127.0.0.1:1".into()),
            auth: DynamoAuth::Keys { access_key_id: "AKIA".into() },
            color: None,
        };
        let err = probe_dynamodb(&config, None).await.unwrap_err();
        assert_eq!(err.kind(), "connection");
        assert!(err.to_string().contains("secret access key is not set"), "{err}");
    }
}
