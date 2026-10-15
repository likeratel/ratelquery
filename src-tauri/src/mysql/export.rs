//! `mysql_export`: re-runs one statement and streams every row to a file (no row cap).

use std::fs::File;
use std::io::BufWriter;
use std::time::Instant;

use futures_util::TryStreamExt;
use sqlx::mysql::MySqlConnection;
use sqlx::{Either, Executor, Row, Statement};

use super::decode::{decode_row, row_metas};
use super::errors::OpError;
use super::options::quote_ident;
use super::query::elapsed_ms;
use super::session::{MysqlSession, boxed};
use super::splitter::split_statements;
use crate::error::{AppError, AppResult};
use crate::export::{
    AtomicFile, ExportOptions, ExportResult, RowWriter, commit_file_writer, open_file_writer,
    validate_target,
};

type FileWriter = (AtomicFile, RowWriter<BufWriter<File>>);

fn column_names<C: sqlx::Column>(columns: &[C]) -> Vec<String> {
    columns.iter().map(|c| c.name().to_string()).collect()
}

async fn columns_without_rows(conn: &mut MySqlConnection, statement: &str) -> Vec<String> {
    match conn.prepare(statement).await {
        Ok(prepared) => column_names(prepared.columns()),
        Err(_) => Vec::new(),
    }
}

async fn stream_to_file(
    conn: &mut MySqlConnection,
    statement: &str,
    options: &ExportOptions,
) -> Result<(u64, u64), OpError> {
    let mut output: Option<FileWriter> = None;
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
                        metas = row_metas(&row);
                        output = Some(open_file_writer(&column_names(row.columns()), options)?);
                    }
                    let cells = decode_row(&row, &metas)?;
                    if let Some((_, writer)) = output.as_mut() {
                        writer.write_row(&cells)?;
                    }
                }
            }
        }
    }
    let (atomic, writer) = match output {
        Some(opened) => opened,
        None => open_file_writer(&columns_without_rows(conn, statement).await, options)?,
    };
    Ok(commit_file_writer(atomic, writer)?)
}

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
    let ((rows, bytes), _) = session
        .run(|mut conn| {
            let (statement, options, database) =
                (statement.clone(), options.clone(), database.clone());
            boxed(async move {
                if let Some(database) = database {
                    conn.execute(sqlx::raw_sql(&format!("USE {}", quote_ident(&database)))).await?;
                }
                stream_to_file(&mut conn, &statement, &options).await
            })
        })
        .await?;
    Ok(ExportResult { rows, bytes, elapsed_ms: elapsed_ms(start) })
}
