//! `mysql_query`: runs each statement of a script on one pooled connection.

use std::time::Instant;

use futures_util::TryStreamExt;
use sqlx::Either;
use sqlx::mysql::MySqlConnection;
use sqlx::{Executor, Row, Statement};

use super::binary_hint::{self, has_maybe_text};
use super::cell::Cell;
use super::classify::{is_read_statement, is_use_statement};
use super::decode::{column_metas, column_names, decode_row, settle_columns};
use super::errors::{
    OpError, UNKNOWN_OUTCOME, describe_sqlx_error, is_connection_error, is_unusable_database,
};
use super::model::{
    ColumnInfo, DEFAULT_MAX_ROWS, ExecResult, QueryOptions, QueryResult, RowsResult, SessionState,
};
use super::options::quote_ident;
use super::session::{MysqlConn, MysqlSession};
use super::splitter::split_statements;
use super::type_meta::TypeMeta;
use crate::error::{AppError, AppResult};
use crate::util::elapsed_ms;

pub fn resolve_max_rows(requested: Option<i64>) -> AppResult<usize> {
    match requested {
        None => Ok(DEFAULT_MAX_ROWS),
        Some(n) if n > 0 => Ok(usize::try_from(n).unwrap_or(usize::MAX)),
        Some(n) => Err(AppError::InvalidInput(format!("maxRows must be positive, got {n}"))),
    }
}

/// Column names and metadata of the first result set.
struct ResultShape {
    names: Vec<String>,
    metas: Vec<TypeMeta>,
}

struct Collected {
    shape: Option<ResultShape>,
    rows: Vec<Vec<Cell>>,
    truncated: bool,
    affected_rows: u64,
    last_insert_id: u64,
}

/// Streams one statement over the text protocol. Only the first result set is kept (it ends at
/// the first `Left`, even when it had no rows, so a `CALL`'s later sets never mix in); rows
/// past `max_rows` are not decoded (the driver drains them before the next command).
async fn collect(
    conn: &mut MySqlConnection,
    statement: &str,
    max_rows: usize,
) -> Result<Collected, sqlx::Error> {
    let mut out = Collected {
        shape: None,
        rows: Vec::new(),
        truncated: false,
        affected_rows: 0,
        last_insert_id: 0,
    };
    let mut first_set_done = false;
    let mut stream = conn.fetch_many(sqlx::raw_sql(statement));
    while let Some(item) = stream.try_next().await? {
        match item {
            Either::Left(done) => {
                out.affected_rows += done.rows_affected();
                if done.last_insert_id() > 0 {
                    out.last_insert_id = done.last_insert_id();
                }
                first_set_done = true;
            }
            Either::Right(_) if first_set_done => {}
            Either::Right(row) => {
                let shape = out.shape.get_or_insert_with(|| ResultShape {
                    names: column_names(row.columns()),
                    metas: column_metas(row.columns()),
                });
                if out.rows.len() >= max_rows {
                    out.truncated = true;
                    break;
                }
                out.rows.push(decode_row(&row, &shape.metas)?);
            }
        }
    }
    Ok(out)
}

/// Column metadata for a statement that returned no rows, via a prepare (no side effects).
/// Statements that cannot be prepared are treated as returning no result set.
async fn prepared_shape(conn: &mut MySqlConnection, statement: &str) -> Option<ResultShape> {
    let prepared = conn.prepare(statement).await.ok()?;
    let columns = prepared.columns();
    (!columns.is_empty())
        .then(|| ResultShape { names: column_names(columns), metas: column_metas(columns) })
}

/// Final columns and rows: binary-flagged columns are settled from the schema when the
/// statement reads one base table, then from the decoded values.
async fn finish_rows(
    conn: &mut MySqlConnection,
    statement: &str,
    shape: ResultShape,
    rows: Vec<Vec<Cell>>,
) -> (Vec<ColumnInfo>, Vec<Vec<Cell>>) {
    let metas = if has_maybe_text(&shape.metas) {
        let hint = binary_hint::lookup(conn, statement).await;
        binary_hint::apply(&shape.names, &shape.metas, &hint)
    } else {
        shape.metas
    };
    settle_columns(&shape.names, &metas, rows)
}

pub async fn execute_statement(
    conn: &mut MySqlConnection,
    statement: &str,
    max_rows: usize,
) -> Result<QueryResult, sqlx::Error> {
    let start = Instant::now();
    let collected = collect(conn, statement, max_rows).await?;
    let shape = match collected.shape {
        Some(shape) => Some(shape),
        None if collected.affected_rows == 0 => prepared_shape(conn, statement).await,
        None => None,
    };
    let elapsed = elapsed_ms(start);
    Ok(match shape {
        Some(shape) => {
            let (columns, rows) = finish_rows(conn, statement, shape, collected.rows).await;
            QueryResult::Rows(RowsResult {
                columns,
                row_count: rows.len(),
                rows,
                truncated: collected.truncated,
                elapsed_ms: elapsed,
                reconnected: false,
                statement: statement.to_string(),
            })
        }
        None => QueryResult::Exec(ExecResult {
            affected_rows: collected.affected_rows,
            last_insert_id: (collected.last_insert_id > 0)
                .then(|| collected.last_insert_id.to_string()),
            elapsed_ms: elapsed,
            reconnected: false,
            statement: statement.to_string(),
        }),
    })
}

async fn run_raw(conn: &mut MySqlConnection, sql: &str) -> Result<(), sqlx::Error> {
    conn.execute(sqlx::raw_sql(sql)).await.map(|_| ())
}

/// `USE <database>` for the requested or default database. An unknown database is
/// `invalid_input`: the option, not the statement, is wrong.
pub async fn use_database(conn: &mut MySqlConnection, database: &str) -> Result<(), OpError> {
    match run_raw(conn, &format!("USE {}", quote_ident(database))).await {
        Err(err) if is_unusable_database(&err) => {
            Err(OpError::App(AppError::InvalidInput(describe_sqlx_error(&err))))
        }
        other => Ok(other?),
    }
}

/// Acquires a connection and selects the database plus any `USE` replayed after a reconnect.
async fn prepare_conn(
    session: &MysqlSession,
    database: Option<&str>,
    replay: Option<&str>,
) -> Result<MysqlConn, OpError> {
    let mut conn = session.acquire().await?;
    if let Some(database) = database {
        use_database(&mut conn, database).await?;
    }
    if let Some(statement) = replay {
        run_raw(&mut conn, statement).await?;
    }
    Ok(conn)
}

async fn open_with_retry(
    session: &MysqlSession,
    database: Option<&str>,
) -> AppResult<(MysqlConn, bool)> {
    match prepare_conn(session, database, None).await {
        Ok(conn) => {
            session.mark_healthy();
            Ok((conn, false))
        }
        Err(err) if err.is_connection_level() => {
            session.set_state(SessionState::Reconnecting, Some(super::session::op_message(&err)));
            let retried = prepare_conn(session, database, None).await;
            session.finish_retry(retried).map(|conn| (conn, true))
        }
        Err(err) => Err(err.into_app_error()),
    }
}

fn statement_error(err: AppError, index: usize, total: usize) -> AppError {
    if total <= 1 {
        return err;
    }
    let suffix = format!(" (statement {} of {total})", index + 1);
    match err {
        AppError::Query(m) => AppError::Query(format!("{m}{suffix}")),
        AppError::Connection(m) => AppError::Connection(format!("{m}{suffix}")),
        other => other,
    }
}

struct Plan<'a> {
    database: Option<&'a str>,
    max_rows: usize,
    total: usize,
}

/// A connection-level failure while a statement that may change data was running: never
/// re-run it, because the first attempt may have been applied. The next result reports
/// `reconnected: true`.
fn unknown_outcome(session: &MysqlSession, err: &sqlx::Error) -> AppError {
    session.mark_lost();
    AppError::Connection(format!("{UNKNOWN_OUTCOME} ({})", describe_sqlx_error(err)))
}

/// Re-runs a read statement that failed with a connection-level error on a new connection.
async fn retry_statement(
    session: &MysqlSession,
    plan: &Plan<'_>,
    replay: Option<&str>,
    statement: &str,
    first: &sqlx::Error,
) -> AppResult<(MysqlConn, QueryResult)> {
    session.set_state(SessionState::Reconnecting, Some(describe_sqlx_error(first)));
    let outcome = async {
        let mut conn = prepare_conn(session, plan.database, replay).await?;
        let result = execute_statement(&mut conn, statement, plan.max_rows).await?;
        Ok::<_, OpError>((conn, result.with_reconnected(true)))
    }
    .await;
    session.finish_retry(outcome)
}

/// Executes every statement of `sql`, stopping at the first failure.
///
/// Retry policy: failures before a statement is sent (acquiring the connection, `USE`) are
/// retried once on a new connection. A connection lost while a statement runs is retried only
/// for read statements ([`is_read_statement`]); anything else fails with `connection` and
/// [`UNKNOWN_OUTCOME`].
pub async fn run_query(
    session: &MysqlSession,
    sql: &str,
    options: &QueryOptions,
) -> AppResult<Vec<QueryResult>> {
    let statements = split_statements(sql);
    if statements.is_empty() {
        return Err(AppError::InvalidInput("the SQL text contains no statements".into()));
    }
    let requested_db = options.database.as_deref().filter(|d| !d.trim().is_empty());
    let plan = Plan {
        database: requested_db.or(session.default_database()),
        max_rows: resolve_max_rows(options.max_rows)?,
        total: statements.len(),
    };
    let pending = session.take_lost();
    let (mut conn, retried) = open_with_retry(session, plan.database).await?;
    let mut reconnected = pending || retried;
    let mut replay: Option<&str> = None;
    let mut results = Vec::with_capacity(statements.len());
    for (index, statement) in statements.iter().enumerate() {
        let result = match execute_statement(&mut conn, statement, plan.max_rows).await {
            Ok(result) => result.with_reconnected(reconnected),
            Err(err) if is_connection_error(&err) && !is_read_statement(statement) => {
                return Err(statement_error(unknown_outcome(session, &err), index, plan.total));
            }
            Err(err) if is_connection_error(&err) => {
                let retried = retry_statement(session, &plan, replay, statement, &err).await;
                let (new_conn, result) =
                    retried.map_err(|e| statement_error(e, index, plan.total))?;
                conn = new_conn;
                result
            }
            Err(err) => {
                if reconnected {
                    session.mark_lost();
                }
                session.note_if_dead(&mut conn).await;
                let app = OpError::Sql(err).into_app_error();
                return Err(statement_error(app, index, plan.total));
            }
        };
        reconnected = false;
        if is_use_statement(statement) {
            replay = Some(statement);
        }
        results.push(result);
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_rows_defaults_and_validates() {
        assert_eq!(resolve_max_rows(None).unwrap(), DEFAULT_MAX_ROWS);
        assert_eq!(resolve_max_rows(Some(5)).unwrap(), 5);
        assert_eq!(resolve_max_rows(Some(0)).unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn statement_error_adds_position_for_scripts() {
        let err = statement_error(AppError::Query("boom".into()), 1, 3);
        assert_eq!(err.to_string(), "boom (statement 2 of 3)");
        assert_eq!(statement_error(AppError::Query("boom".into()), 0, 1).to_string(), "boom");
    }
}
