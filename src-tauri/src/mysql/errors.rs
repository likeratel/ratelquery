//! Classification of `sqlx` errors into connection-level (retryable) and query errors.

use sqlx::mysql::MySqlDatabaseError;

use crate::error::AppError;

/// Client/server error numbers that mean the connection itself is gone:
/// 2006 server has gone away, 2013 lost connection during query, 4031 disconnected by server
/// because of inactivity.
const CONNECTION_ERROR_CODES: [u16; 3] = [2006, 2013, 4031];
const CONNECTION_RESET_TEXT: &str = "connection reset";

pub fn is_connection_error_code(number: u16) -> bool {
    CONNECTION_ERROR_CODES.contains(&number)
}

pub fn mentions_connection_reset(message: &str) -> bool {
    message.to_lowercase().contains(CONNECTION_RESET_TEXT)
}

fn mysql_error(err: &sqlx::Error) -> Option<&MySqlDatabaseError> {
    match err {
        sqlx::Error::Database(db) => db.try_downcast_ref::<MySqlDatabaseError>(),
        _ => None,
    }
}

pub fn is_connection_error(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Io(_) | sqlx::Error::PoolClosed | sqlx::Error::PoolTimedOut => true,
        _ => {
            mysql_error(err).is_some_and(|db| is_connection_error_code(db.number()))
                || mentions_connection_reset(&err.to_string())
        }
    }
}

/// MySQL errors start with the server's message text, followed by the error number.
pub fn describe_sqlx_error(err: &sqlx::Error) -> String {
    match mysql_error(err) {
        Some(db) => format!("{} (MySQL error {})", db.message(), db.number()),
        None => err.to_string(),
    }
}

pub fn query_error(err: &sqlx::Error) -> AppError {
    AppError::Query(describe_sqlx_error(err))
}

pub fn connection_error(err: &sqlx::Error) -> AppError {
    AppError::Connection(describe_sqlx_error(err))
}

/// Error of a unit of work that may be retried: either a database error (classified later) or
/// an already-final application error.
#[derive(Debug)]
pub enum OpError {
    Sql(sqlx::Error),
    App(AppError),
}

impl From<sqlx::Error> for OpError {
    fn from(value: sqlx::Error) -> Self {
        OpError::Sql(value)
    }
}

impl From<AppError> for OpError {
    fn from(value: AppError) -> Self {
        OpError::App(value)
    }
}

impl OpError {
    pub fn is_connection_level(&self) -> bool {
        matches!(self, OpError::Sql(e) if is_connection_error(e))
    }

    /// Final error for the caller; connection-level errors map to `connection`, others to
    /// `query`.
    pub fn into_app_error(self) -> AppError {
        match self {
            OpError::Sql(e) if is_connection_error(&e) => connection_error(&e),
            OpError::Sql(e) => query_error(&e),
            OpError::App(e) => e,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_and_pool_errors_are_connection_level() {
        let io = sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pipe"));
        assert!(is_connection_error(&io));
        assert!(is_connection_error(&sqlx::Error::PoolClosed));
        assert!(is_connection_error(&sqlx::Error::PoolTimedOut));
    }

    #[test]
    fn reset_text_and_codes_are_connection_level() {
        assert!(is_connection_error(&sqlx::Error::Protocol("Connection reset by peer".into())));
        assert!(!is_connection_error(&sqlx::Error::Protocol("bad packet".into())));
        assert!(!is_connection_error(&sqlx::Error::RowNotFound));
        assert!(is_connection_error_code(2006));
        assert!(is_connection_error_code(2013));
        assert!(is_connection_error_code(4031));
        assert!(!is_connection_error_code(1146));
    }

    #[test]
    fn op_error_maps_to_kinds() {
        assert_eq!(OpError::Sql(sqlx::Error::PoolTimedOut).into_app_error().kind(), "connection");
        assert_eq!(OpError::Sql(sqlx::Error::RowNotFound).into_app_error().kind(), "query");
        assert_eq!(
            OpError::App(AppError::InvalidInput("x".into())).into_app_error().kind(),
            "invalid_input"
        );
    }
}
