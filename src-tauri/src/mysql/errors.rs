//! Classification of `sqlx` errors into connection-level (retryable) and query errors.

use sqlx::mysql::MySqlDatabaseError;

use crate::error::AppError;

/// Client/server error numbers that mean the connection itself is gone:
/// 2006 server has gone away, 2013 lost connection during query, 4031 disconnected by server
/// because of inactivity.
const CONNECTION_ERROR_CODES: [u16; 3] = [2006, 2013, 4031];
const CONNECTION_RESET_TEXT: &str = "connection reset";
/// `ER_DBACCESS_DENIED_ERROR` (no access, which is also what a missing database looks like
/// without global privileges) and `ER_BAD_DB_ERROR` (unknown database).
const UNUSABLE_DATABASE_CODES: [u16; 2] = [1044, 1049];

/// Message when every pooled connection stayed checked out for the whole acquire timeout.
pub const POOL_BUSY: &str =
    "All pooled connections are busy; wait for a running query or open another connection";

/// Message for a non-read statement whose connection dropped while it ran.
pub const UNKNOWN_OUTCOME: &str = "The server dropped the connection while the statement was \
     running; it may or may not have been applied. Check the data before running it again.";

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

/// Connection-level errors are retryable. A server (`Database`) error is classified by its
/// error number only: its message can quote user text such as `connection reset`. The message
/// is only inspected for driver-side errors (protocol, TLS, ...).
///
/// `PoolTimedOut` is not a lost connection: it usually means every pooled connection is busy.
/// [`super::session::MysqlSession::acquire`] tells the two causes apart.
pub fn is_connection_error(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Io(_) | sqlx::Error::PoolClosed => true,
        sqlx::Error::PoolTimedOut => false,
        sqlx::Error::Database(_) => {
            mysql_error(err).is_some_and(|db| is_connection_error_code(db.number()))
        }
        _ => mentions_connection_reset(&err.to_string()),
    }
}

pub fn is_unusable_database(err: &sqlx::Error) -> bool {
    mysql_error(err).is_some_and(|db| UNUSABLE_DATABASE_CODES.contains(&db.number()))
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
            OpError::Sql(sqlx::Error::PoolTimedOut) => AppError::Connection(POOL_BUSY.into()),
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
    }

    #[test]
    fn pool_timeout_is_busy_not_lost() {
        assert!(!is_connection_error(&sqlx::Error::PoolTimedOut));
        let op = OpError::Sql(sqlx::Error::PoolTimedOut);
        assert!(!op.is_connection_level(), "never retried");
        let err = op.into_app_error();
        assert_eq!((err.kind(), err.to_string().as_str()), ("connection", POOL_BUSY));
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

    #[derive(Debug)]
    struct FakeDbError(&'static str);

    impl std::fmt::Display for FakeDbError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for FakeDbError {}

    impl sqlx::error::DatabaseError for FakeDbError {
        fn message(&self) -> &str {
            self.0
        }
        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }
        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
    }

    #[test]
    fn database_errors_never_match_on_message_text() {
        let err = sqlx::Error::Database(Box::new(FakeDbError(
            "Unknown column 'connection reset' in 'field list'",
        )));
        assert!(!is_connection_error(&err));
        assert_eq!(OpError::Sql(err).into_app_error().kind(), "query");
        assert!(is_connection_error(&sqlx::Error::Tls("connection reset by peer".into())));
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
