//! `mysql_query`: runs each statement of a script on one pooled connection.

use std::collections::HashSet;
use std::time::Instant;

use futures_util::TryStreamExt;
use sqlx::Either;
use sqlx::mysql::MySqlConnection;
use sqlx::{Connection, Executor, Row, Statement};

use super::binary_hint::{self, has_maybe_text};
use super::cell::Cell;
use super::changes::TrashTarget;
use super::classify::{is_read_statement, is_use_statement};
use super::decode::{column_metas, column_names, decode_row, settle_columns};
use super::delete_backup::{BackedDelete, TableCache, run_backed_delete};
use super::delete_plan::{DeleteKind, classify_script};
use super::errors::{
    OpError, UNKNOWN_OUTCOME, describe_sqlx_error, is_connection_error, is_unusable_database,
};
use super::model::{
    BackupStoppedResult, ColumnInfo, DEFAULT_MAX_ROWS, ExecResult, QueryOptions, QueryResult,
    RowsResult, SessionState,
};
use super::options::quote_ident;
use super::session::{MysqlConn, MysqlSession, ResumePoint, ResumeRefused};
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
            trashed_rows: None,
            trash_id: None,
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
    replay: Option<&str>,
) -> AppResult<(MysqlConn, bool)> {
    match prepare_conn(session, database, replay).await {
        Ok(conn) => {
            session.mark_healthy();
            Ok((conn, false))
        }
        Err(err) if err.is_connection_level() => {
            session.set_state(SessionState::Reconnecting, Some(super::session::op_message(&err)));
            let retried = prepare_conn(session, database, replay).await;
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

/// Executes every statement of `sql`, stopping at the first failure. No DELETE is backed up;
/// see [`run_query_with_trash`].
pub async fn run_query(
    session: &MysqlSession,
    sql: &str,
    options: &QueryOptions,
) -> AppResult<Vec<QueryResult>> {
    run_query_with_trash(session, sql, options, None).await
}

/// How each statement of the script is treated for the trash.
struct TrashPlan<'a> {
    target: &'a TrashTarget,
    kinds: Vec<DeleteKind>,
    skip: HashSet<usize>,
}

impl TrashPlan<'_> {
    /// The DELETE handling of statement `index`, or `None` when it runs as usual.
    fn kind(&self, index: usize) -> Option<&DeleteKind> {
        match self.kinds.get(index) {
            Some(DeleteKind::NotDelete) | None => None,
            Some(_) if self.skip.contains(&index) => None,
            Some(kind) => Some(kind),
        }
    }
}

fn stopped(index: usize, statement: &str, reason: String, token: Option<String>) -> QueryResult {
    QueryResult::BackupStopped(BackupStoppedResult {
        statement_index: index,
        reason,
        statement: statement.to_string(),
        elapsed_ms: 0,
        resume_token: token,
    })
}

/// Message for a continue whose kept connection is gone.
pub const RESUME_EXPIRED: &str = "The connection kept for continuing this script is gone (it \
     timed out, was lost or the session closed), so its session state is lost. Run the script \
     again from the start.";
const RESUME_MISMATCH: &str = "This resumeToken is for another script text or statement; \
     continue the stopped run with the same text from the statement it stopped at.";
const RESUME_REQUIRED: &str =
    "startAt above 0 needs the resumeToken of the stopped run, so it runs on the same connection";
const RESUME_LOST: &str = "The connection kept for continuing this script was lost while it \
     ran; the statement may or may not have been applied. Check the data, then run the script \
     again from the start.";

/// A backed-up DELETE failed. Nothing of it was committed unless the COMMIT itself was lost,
/// which comes back as a final `connection` error already.
async fn backed_delete_error(
    session: &MysqlSession,
    conn: &mut MysqlConn,
    err: OpError,
    reconnected: bool,
) -> AppError {
    match err {
        OpError::Sql(e) if is_connection_error(&e) => {
            session.mark_lost();
            AppError::Connection(format!(
                "The server dropped the connection before the backed-up DELETE was committed; \
                 it was not applied ({})",
                describe_sqlx_error(&e)
            ))
        }
        other => {
            if reconnected {
                session.mark_lost();
            }
            session.note_if_dead(conn).await;
            other.into_app_error()
        }
    }
}

/// The connection a run starts on: the one kept by `resume_token` (which must be alive), or a
/// pooled one with the database selected. Also whether the result reports a reconnect.
async fn starting_connection(
    session: &MysqlSession,
    plan: &Plan<'_>,
    resume_token: Option<&str>,
    (sql, start_at): (&str, usize),
) -> AppResult<(MysqlConn, bool)> {
    let Some(token) = resume_token else {
        let pending = session.take_lost();
        let (conn, retried) = open_with_retry(session, plan.database, None).await?;
        return Ok((conn, pending || retried || session.take_reopened()));
    };
    let resume = ResumePoint::new(sql, start_at);
    let mut conn = session.take_parked(token, resume).map_err(|refused| match refused {
        ResumeRefused::Gone => AppError::InvalidInput(RESUME_EXPIRED.into()),
        ResumeRefused::Mismatch => AppError::InvalidInput(RESUME_MISMATCH.into()),
    })?;
    if conn.ping().await.is_err() {
        session.mark_lost();
        return Err(AppError::InvalidInput(RESUME_EXPIRED.into()));
    }
    Ok((conn, false))
}

/// Executes the statements of `sql` from `options.startAt`, stopping at the first failure.
///
/// Retry policy: failures before a statement is sent (acquiring the connection, `USE`) are
/// retried once on a new connection. A connection lost while a statement runs is retried only
/// for read statements ([`is_read_statement`]); anything else fails with `connection` and
/// [`UNKNOWN_OUTCOME`]. A continued run (`resumeToken`) is never moved to another connection.
///
/// With `trash`, a DELETE is backed up first (see `delete_backup`) unless its index is in
/// `options.deleteBackup.skip`. One that can't be backed up does not run: the results so far end
/// with a [`QueryResult::BackupStopped`] for it, later statements don't run either, and the
/// connection is kept (see [`MysqlSession::park`]) so `startAt` + `resumeToken` continue on it.
pub async fn run_query_with_trash(
    session: &MysqlSession,
    sql: &str,
    options: &QueryOptions,
    trash: Option<&TrashTarget>,
) -> AppResult<Vec<QueryResult>> {
    let statements = split_statements(sql);
    if statements.is_empty() {
        return Err(AppError::InvalidInput("the SQL text contains no statements".into()));
    }
    let start_at = options.start_at.unwrap_or(0);
    if start_at >= statements.len() {
        return Err(AppError::InvalidInput(format!(
            "startAt {start_at} is past the last of {} statements",
            statements.len()
        )));
    }
    let resume_token = options.resume_token.as_deref();
    if start_at > 0 && resume_token.is_none() {
        return Err(AppError::InvalidInput(RESUME_REQUIRED.into()));
    }
    let requested_db = options.database.as_deref().filter(|d| !d.trim().is_empty());
    let plan = Plan {
        database: requested_db.or(session.default_database()),
        max_rows: resolve_max_rows(options.max_rows)?,
        total: statements.len(),
    };
    let trash_plan = trash.map(|target| TrashPlan {
        target,
        kinds: classify_script(&statements),
        skip: options
            .delete_backup
            .as_ref()
            .map(|d| d.skip.iter().copied().collect())
            .unwrap_or_default(),
    });
    let resumed = resume_token.is_some();
    let (mut conn, mut reconnected) =
        starting_connection(session, &plan, resume_token, (sql, start_at)).await?;
    let mut cache = TableCache::default();
    let mut replay: Option<&str> = None;
    let mut results = Vec::with_capacity(statements.len() - start_at);
    for (index, statement) in statements.iter().enumerate().skip(start_at) {
        let delete = trash_plan.as_ref().and_then(|p| p.kind(index).map(|k| (p.target, k)));
        let backed = match delete {
            Some((_, DeleteKind::Unsupported(reason))) => {
                Some(Ok(BackedDelete::Stopped(reason.clone())))
            }
            Some((target, DeleteKind::Backup(delete))) => {
                Some(run_backed_delete(&mut conn, statement, delete, target, &mut cache).await)
            }
            _ => None,
        };
        let result = match backed {
            Some(Ok(BackedDelete::Done(exec))) => {
                QueryResult::Exec(exec).with_reconnected(reconnected)
            }
            Some(Ok(BackedDelete::Stopped(reason))) => {
                let token = session.park(conn, ResumePoint::new(sql, index));
                results.push(stopped(index, statement, reason, token));
                return Ok(results);
            }
            Some(Err(err)) => {
                let app = backed_delete_error(session, &mut conn, err, reconnected).await;
                return Err(statement_error(app, index, plan.total));
            }
            None => match execute_statement(&mut conn, statement, plan.max_rows).await {
                Ok(result) => result.with_reconnected(reconnected),
                Err(err) if is_connection_error(&err) && resumed => {
                    session.mark_lost();
                    return Err(statement_error(
                        AppError::Connection(RESUME_LOST.into()),
                        index,
                        plan.total,
                    ));
                }
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
            },
        };
        reconnected = false;
        // DDL or writes can change a table's columns; DELETEs and reads keep what was looked up.
        if delete.is_none() && !is_read_statement(statement) {
            cache.clear();
        }
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
