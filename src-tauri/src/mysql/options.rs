use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlPoolOptions, MySqlRow};
use sqlx::{Executor, Row};

use crate::connections::MysqlConnectionConfig;
use crate::error::{AppError, AppResult};

pub const MAX_CONNECTIONS: u32 = 4;
pub const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);
const CHARSET: &str = "utf8mb4";

/// Connect options for a saved config. No session time zone is forced so TIMESTAMP values are
/// shown exactly as the server renders them, and `||` keeps MySQL's default meaning.
pub fn connect_options(
    config: &MysqlConnectionConfig,
    password: Option<&str>,
) -> AppResult<MySqlConnectOptions> {
    let port = u16::try_from(config.port)
        .map_err(|_| AppError::InvalidInput(format!("invalid port {}", config.port)))?;
    let base = MySqlConnectOptions::new()
        .host(&config.host)
        .port(port)
        .username(&config.user)
        .charset(CHARSET)
        .timezone(None)
        .pipes_as_concat(false);
    let with_password = match password.filter(|p| !p.is_empty()) {
        Some(password) => base.password(password),
        None => base,
    };
    Ok(match &config.database {
        Some(database) => with_password.database(database),
        None => with_password,
    })
}

pub fn pool_options() -> MySqlPoolOptions {
    MySqlPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .acquire_timeout(ACQUIRE_TIMEOUT)
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
    fn rejects_port_outside_u16() {
        assert_eq!(connect_options(&config(70_000), None).unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("orders"), "`orders`");
        assert_eq!(quote_ident("we`ird"), "`we``ird`");
    }
}
