use std::sync::Once;
use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Executor, Row};

use crate::connections::{MysqlConnectionConfig, MysqlTlsMode};
use crate::error::{AppError, AppResult};

pub const MAX_CONNECTIONS: u32 = 4;
pub const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);
const CHARSET: &str = "utf8mb4";

fn ssl_mode(mode: MysqlTlsMode) -> MySqlSslMode {
    match mode {
        MysqlTlsMode::Preferred => MySqlSslMode::Preferred,
        MysqlTlsMode::Required => MySqlSslMode::Required,
        MysqlTlsMode::VerifyCa => MySqlSslMode::VerifyCa,
        MysqlTlsMode::VerifyIdentity => MySqlSslMode::VerifyIdentity,
    }
}

/// sqlx's certificate-verifying TLS modes build a rustls verifier from the process default
/// crypto provider. Both `ring` (sqlx) and `aws-lc-rs` (AWS SDK) are compiled in, so rustls
/// cannot pick one and would panic; install `ring`, the provider sqlx itself uses. The AWS
/// client passes its provider explicitly and is unaffected. An already installed default is
/// kept.
pub fn ensure_tls_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Connect options for a saved config. No session time zone is forced so TIMESTAMP values are
/// shown exactly as the server renders them, and `||` keeps MySQL's default meaning.
pub fn connect_options(
    config: &MysqlConnectionConfig,
    password: Option<&str>,
) -> AppResult<MySqlConnectOptions> {
    ensure_tls_provider();
    let port = u16::try_from(config.port)
        .map_err(|_| AppError::InvalidInput(format!("invalid port {}", config.port)))?;
    let base = MySqlConnectOptions::new()
        .host(&config.host)
        .port(port)
        .username(&config.user)
        .charset(CHARSET)
        .timezone(None)
        .pipes_as_concat(false)
        .ssl_mode(ssl_mode(config.tls_mode()));
    let base = match &config.ca_cert_path {
        Some(path) => base.ssl_ca(path),
        None => base,
    };
    let with_password = match password.filter(|p| !p.is_empty()) {
        Some(password) => base.password(password),
        None => base,
    };
    Ok(match &config.database {
        Some(database) => with_password.database(database),
        None => with_password,
    })
}

pub fn pool_options(acquire_timeout: Duration) -> MySqlPoolOptions {
    MySqlPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .acquire_timeout(acquire_timeout)
        .test_before_acquire(true)
}

async fn single_text(conn: &mut MySqlConnection, sql: &str) -> Result<Option<String>, sqlx::Error> {
    let row: MySqlRow = conn.fetch_one(sqlx::raw_sql(sql)).await?;
    row.try_get_unchecked::<Option<String>, _>(0)
}

pub async fn fetch_server_version(conn: &mut MySqlConnection) -> Result<String, sqlx::Error> {
    Ok(single_text(conn, "SELECT VERSION()").await?.unwrap_or_default())
}

pub async fn fetch_current_database(
    conn: &mut MySqlConnection,
) -> Result<Option<String>, sqlx::Error> {
    single_text(conn, "SELECT DATABASE()").await
}

/// Backtick-quotes an identifier, doubling embedded backticks.
pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(port: i64) -> MysqlConnectionConfig {
        MysqlConnectionConfig {
            id: "x".into(),
            name: "n".into(),
            host: "db.local".into(),
            port,
            user: "dev".into(),
            database: Some("sample".into()),
            color: None,
            tls: None,
            ca_cert_path: None,
            ssh: None,
        }
    }

    #[test]
    fn builds_options_from_config() {
        let options = connect_options(&config(3307), Some("pw")).unwrap();
        assert_eq!(options.get_host(), "db.local");
        assert_eq!(options.get_port(), 3307);
        assert_eq!(options.get_database(), Some("sample"));
        assert_eq!(options.get_charset(), CHARSET);
    }

    #[test]
    fn maps_tls_modes() {
        let options = connect_options(&config(3307), None).unwrap();
        assert!(matches!(options.get_ssl_mode(), MySqlSslMode::Preferred));
        let strict = MysqlConnectionConfig {
            tls: Some(MysqlTlsMode::VerifyIdentity),
            ca_cert_path: Some("/etc/ca.pem".into()),
            ..config(3307)
        };
        let options = connect_options(&strict, None).unwrap();
        assert!(matches!(options.get_ssl_mode(), MySqlSslMode::VerifyIdentity));
        assert!(matches!(ssl_mode(MysqlTlsMode::Required), MySqlSslMode::Required));
        assert!(matches!(ssl_mode(MysqlTlsMode::VerifyCa), MySqlSslMode::VerifyCa));
    }

    #[test]
    fn rejects_port_outside_u16() {
        assert_eq!(connect_options(&config(70_000), None).unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("orders"), "`orders`");
        assert_eq!(quote_ident("we`ird"), "`we``ird`");
    }
}
