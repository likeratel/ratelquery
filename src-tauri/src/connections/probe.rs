//! `connections_test` probes: a real round trip to the server with the given config.

use std::time::{Duration, Instant};

use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::config::{Credentials, Region};
use aws_sdk_dynamodb::error::DisplayErrorContext;
use sqlx::Connection;

use super::model::{
    ConnectionTestResult, DynamoAuth, DynamoConnectionConfig, MysqlConnectionConfig,
};
use crate::error::{AppError, AppResult};
use crate::mysql::{connect_options, describe_sqlx_error, fetch_server_version};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const CREDENTIALS_PROVIDER_NAME: &str = "dbclient";

fn elapsed_ms(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn timed_out(what: &str) -> AppError {
    AppError::Connection(format!("{what} timed out after {}s", PROBE_TIMEOUT.as_secs()))
}

/// Connects once, runs `SELECT VERSION()` and closes the connection.
pub async fn probe_mysql(
    config: &MysqlConnectionConfig,
    password: Option<&str>,
) -> AppResult<ConnectionTestResult> {
    let options = connect_options(config, password)?;
    let start = Instant::now();
    let work = async {
        let mut conn = sqlx::MySqlConnection::connect_with(&options).await?;
        let version = fetch_server_version(&mut conn).await?;
        conn.close().await?;
        Ok::<String, sqlx::Error>(version)
    };
    let version = tokio::time::timeout(PROBE_TIMEOUT, work)
        .await
        .map_err(|_| timed_out("MySQL connection"))?
        .map_err(|e| AppError::Connection(describe_sqlx_error(&e)))?;
    Ok(ConnectionTestResult {
        ok: true,
        server_version: Some(version),
        latency_ms: elapsed_ms(start),
    })
}

async fn dynamo_sdk_config(
    config: &DynamoConnectionConfig,
    secret: Option<&str>,
) -> AppResult<aws_types::SdkConfig> {
    let loader =
        aws_config::defaults(BehaviorVersion::latest()).region(Region::new(config.region.clone()));
    let loader = match &config.endpoint {
        Some(endpoint) => loader.endpoint_url(endpoint),
        None => loader,
    };
    let loader = match &config.auth {
        DynamoAuth::Profile { profile } => loader.profile_name(profile),
        DynamoAuth::Keys { access_key_id } => {
            let secret = secret.filter(|s| !s.is_empty()).ok_or_else(|| {
                AppError::Connection("the AWS secret access key is not set".into())
            })?;
            let credentials =
                Credentials::new(access_key_id, secret, None, None, CREDENTIALS_PROVIDER_NAME);
            loader.credentials_provider(credentials)
        }
    };
    Ok(loader.load().await)
}

/// Loads credentials and calls `ListTables(limit 1)`.
pub async fn probe_dynamodb(
    config: &DynamoConnectionConfig,
    secret: Option<&str>,
) -> AppResult<ConnectionTestResult> {
    let start = Instant::now();
    let work = async {
        let sdk_config = dynamo_sdk_config(config, secret).await?;
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
