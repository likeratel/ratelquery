//! `mysql_export`: re-runs one statement and streams every row to a file (no row cap).

use std::time::Instant;

use futures_util::TryStreamExt;
use sqlx::mysql::MySqlConnection;
use sqlx::{Either, Executor, Row, Statement};

use super::binary_hint::{self, BinaryHint};
use super::cell::Cell;
use super::classify::is_read_statement;
use super::decode::{column_metas, column_names, decode_row};
use super::errors::{OpError, UNKNOWN_OUTCOME, describe_sqlx_error, is_connection_error};
use super::query::{elapsed_ms, use_database};
use super::session::{MysqlSession, boxed};
use super::splitter::split_statements;
use crate::error::{AppError, AppResult};
use crate::export::{
    ExportOptions, ExportResult, FileRowWriter, open_file_writer, run_blocking, validate_target,
};

async fn columns_without_rows(conn: &mut MySqlConnection, statement: &str) -> Vec<String> {
    match conn.prepare(statement).await {
        Ok(prepared) => column_names(prepared.columns()),
        Err(_) => Vec::new(),
    }
}

/// Rows decoded before they are handed to the blocking pool in one write.
const WRITE_BATCH_ROWS: usize = 1024;

/// Writes a batch of rows on the blocking pool and hands the writer back. On failure the writer
/// is dropped there, which removes its temp file.
async fn write_batch(mut writer: FileRowWriter, rows: Vec<Vec<Cell>>) -> AppResult<FileRowWriter> {
    run_blocking(move || {
        for row in &rows {
            writer.write_row(row)?;
        }
        Ok(writer)
    })
    .await
}

async fn open_writer(names: Vec<String>, options: &ExportOptions) -> AppResult<FileRowWriter> {
    let options = options.clone();
    run_blocking(move || open_file_writer(&names, &options)).await
}

/// Streams the first result set to the file. Rows are decoded on the async side and written
/// in batches of [`WRITE_BATCH_ROWS`] on the blocking pool (file open, writes and the final
/// fsync/rename included), so file I/O never runs on an async worker; the stream stays open
/// and idle while a batch is written.
async fn stream_to_file(
    conn: &mut MySqlConnection,
    statement: &str,
    options: &ExportOptions,
    hint: &BinaryHint,
) -> Result<(u64, u64), OpError> {
    // Declared before the stream so an error drops the writer (then its temp file) cleanly.
    let mut output: Option<FileRowWriter> = None;
    let mut pending: Vec<Vec<Cell>> = Vec::new();
    let mut metas = Vec::new();
    let mut first_set_done = false;
    {
        let mut stream = conn.fetch_many(sqlx::raw_sql(statement));
        while let Some(item) = stream.try_next().await? {
            match item {
                Either::Left(_) => first_set_done = output.is_some(),
                Either::Right(_) if first_set_done => {}
                Either::Right(row) => {
                    if output.is_none() {
                        let names = column_names(row.columns());
                        metas = binary_hint::apply(&names, &column_metas(row.columns()), hint);
                        output = Some(open_writer(names, options).await?);
                    }
                    pending.push(decode_row(&row, &metas)?);
                    if pending.len() >= WRITE_BATCH_ROWS
                        && let Some(writer) = output.take()
                    {
                        output = Some(write_batch(writer, std::mem::take(&mut pending)).await?);
                    }
                }
            }
        }
    }
    let writer = match output {
        Some(opened) => write_batch(opened, pending).await?,
        None => open_writer(columns_without_rows(conn, statement).await, options).await?,
    };
    Ok(run_blocking(move || writer.commit()).await?)
}

/// A non-read statement whose connection dropped mid-run is not retried (see `run_query`).
fn guard_retry(err: OpError, statement: &str) -> OpError {
    match err {
        OpError::Sql(e) if is_connection_error(&e) && !is_read_statement(statement) => {
            OpError::App(AppError::Connection(format!(
                "{UNKNOWN_OUTCOME} ({})",
                describe_sqlx_error(&e)
            )))
        }
        other => other,
    }
}

async fn export_on(
    conn: &mut MySqlConnection,
    statement: &str,
    options: &ExportOptions,
    database: Option<&str>,
) -> Result<(u64, u64), OpError> {
    if let Some(database) = database {
        use_database(conn, database).await?;
    }
    let hint = binary_hint::lookup(conn, statement).await;
    stream_to_file(conn, statement, options, &hint).await.map_err(|e| guard_retry(e, statement))
}

/// Streams the single statement of `sql` to `options.path`. The caller authorizes the path.
pub async fn run_export(
    session: &MysqlSession,
    sql: &str,
    options: &ExportOptions,
) -> AppResult<ExportResult> {
    let start = Instant::now();
    let statements = split_statements(sql);
    let [statement] = statements.as_slice() else {
        return Err(AppError::InvalidInput(format!(
            "export needs exactly one statement, got {}",
            statements.len()
        )));
    };
    validate_target(&options.path)?;
    let database = options.database().or(session.default_database()).map(str::to_string);
    let ((rows, bytes), _) =
        session
            .run(|mut conn| {
                let (statement, options, database) =
                    (statement.clone(), options.clone(), database.clone());
                boxed(async move {
                    export_on(&mut conn, &statement, &options, database.as_deref()).await
                })
            })
            .await?;
    Ok(ExportResult { rows, bytes, elapsed_ms: elapsed_ms(start) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_statements_lost_mid_run_are_not_retried() {
        let lost = || OpError::Sql(sqlx::Error::PoolClosed);
        let guarded = guard_retry(lost(), "DELETE FROM t");
        assert!(!guarded.is_connection_level());
        assert_eq!(guarded.into_app_error().kind(), "connection");
        assert!(guard_retry(lost(), "SELECT * FROM t").is_connection_level());
    }
}
