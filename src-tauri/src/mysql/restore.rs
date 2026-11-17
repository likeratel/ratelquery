//! Restoring trash rows: one INSERT per row, built like a grid insert against the live table
//! definition and run in one transaction.

use std::collections::{BTreeMap, HashSet};

use sqlx::mysql::MySqlConnection;
use sqlx::{Connection, MySql, Row, Transaction};

use serde::Serialize;

use super::backup::{is_transactional, session_syntax, table_engine};
use super::bind::bind_value;
use super::cell::Cell;
use super::changes::{BuiltStatement, build_statement, load_table, resolve_name};
use super::delete_backup::is_temporary;
use super::errors::{OpError, describe_sqlx_error, is_connection_error};
use super::model::{RowChange, SchemaTable};
use super::session::{MysqlSession, boxed};
use crate::error::{AppError, AppResult};

const GENERATED_SQL: &str = "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
     AND (EXTRA LIKE '%VIRTUAL GENERATED%' OR EXTRA LIKE '%STORED GENERATED%')";

/// The rows to put back and where they came from.
#[derive(Debug, Clone)]
pub struct RestoreRequest {
    pub database: String,
    pub table: String,
    /// Column names of the trash entry, in row order.
    pub columns: Vec<String>,
    /// The rows to restore, with their index in the entry (for messages).
    pub rows: Vec<(usize, Vec<Cell>)>,
}

/// Lower-cased names of the table's generated columns, which can't be inserted into.
async fn generated_columns(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<HashSet<String>, OpError> {
    let rows = sqlx::query(GENERATED_SQL).bind(database).bind(table).fetch_all(&mut *conn).await?;
    rows.iter()
        .map(|row| {
            let name = row.try_get_unchecked::<String, _>(0)?;
            Ok(name.to_lowercase())
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(OpError::from)
}

/// For each entry column, the live column it goes to; `None` for a generated column (left to
/// the server). A column the table no longer has is `invalid_input`.
fn map_columns(
    request: &RestoreRequest,
    definition: &SchemaTable,
    generated: &HashSet<String>,
) -> AppResult<Vec<Option<String>>> {
    request
        .columns
        .iter()
        .map(|name| {
            let live =
                resolve_name(definition.columns.iter().map(|c| c.name.as_str()), name, || {
                    format!(
                        "column {name} no longer exists in {}.{}, so the rows can't be restored",
                        request.database, request.table
                    )
                })?;
            Ok((!generated.contains(&live.to_lowercase())).then(|| live.to_string()))
        })
        .collect()
}

/// Statements shown by a restore preview; the total is reported too.
pub const PREVIEW_STATEMENTS: usize = 200;

/// `trash_restore_preview`: the first [`PREVIEW_STATEMENTS`] INSERTs as text and how many there
/// are, and the engine when it can't roll back a failed restore.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub statements: Vec<String>,
    pub total: usize,
    /// Set (and `statements` empty) when the character set makes the text unsafe to show.
    pub warning: Option<String>,
    /// MyISAM and other engines without transactions: a failure leaves earlier rows inserted.
    pub non_transactional_engine: Option<String>,
}

/// The table's INSERTs and its engine when that engine can't roll back.
struct Planned {
    statements: Vec<BuiltStatement>,
    non_transactional: Option<String>,
}

/// The INSERT of each row, against the live definition. Columns added since the delete get
/// their defaults. A temporary table of the same name hiding the table is refused.
async fn restore_statements(
    conn: &mut MySqlConnection,
    request: &RestoreRequest,
) -> Result<Planned, OpError> {
    let (database, definition) = load_table(conn, &request.database, &request.table).await?;
    if is_temporary(conn, &database, &definition.name).await? {
        return Err(AppError::InvalidInput(format!(
            "a temporary table named {} hides the table on this connection; restore it from \
             another connection or once the temporary table is gone",
            definition.name
        ))
        .into());
    }
    let engine = table_engine(conn, &database, &definition.name).await?;
    let generated = generated_columns(conn, &database, &definition.name).await?;
    let targets = map_columns(request, &definition, &generated)?;
    let statements = request
        .rows
        .iter()
        .map(|(index, row)| {
            if row.len() != targets.len() {
                return Err(AppError::InvalidInput(format!(
                    "row {} has {} values for {} columns",
                    index + 1,
                    row.len(),
                    targets.len()
                )));
            }
            let values: BTreeMap<String, Cell> = targets
                .iter()
                .zip(row)
                .filter_map(|(target, cell)| target.clone().map(|name| (name, cell.clone())))
                .collect();
            build_statement(&database, &definition, &RowChange::Insert { values })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let non_transactional = (!is_transactional(&engine)).then_some(engine);
    Ok(Planned { statements, non_transactional })
}

async fn roll_back(tx: Transaction<'_, MySql>) {
    if let Err(err) = tx.rollback().await {
        eprintln!("rollback of a restore did not complete: {}", describe_sqlx_error(&err));
    }
}

/// The error of a failed INSERT for row `index`. On a transactional table a lost connection
/// stays a retryable SQL error (nothing was committed, the session tries again); on a table that
/// can't roll back it is final, since a retry would insert the earlier rows a second time.
fn insert_failure(index: usize, err: sqlx::Error, non_transactional: Option<&str>) -> OpError {
    let kept = |engine: &str| {
        format!(
            "The table uses the {engine} engine, which can't roll back, so earlier rows may \
             already be restored; the trash entry is kept."
        )
    };
    match (is_connection_error(&err), non_transactional) {
        (true, None) => err.into(),
        (true, Some(engine)) => AppError::Connection(format!(
            "the connection was lost while restoring row {}. {}",
            index + 1,
            kept(engine)
        ))
        .into(),
        (false, engine) => {
            let outcome = engine.map_or_else(|| "Nothing was restored.".to_string(), kept);
            AppError::Query(format!(
                "row {} could not be restored: {}. {outcome}",
                index + 1,
                describe_sqlx_error(&err)
            ))
            .into()
        }
    }
}

async fn insert_all(
    conn: &mut MySqlConnection,
    request: &RestoreRequest,
    planned: &Planned,
) -> Result<u64, OpError> {
    let statements = &planned.statements;
    let mut tx = conn.begin().await?;
    for ((index, _), statement) in request.rows.iter().zip(statements) {
        let query = statement.binds.iter().cloned().fold(sqlx::query(&statement.sql), bind_value);
        if let Err(err) = query.execute(&mut *tx).await {
            roll_back(tx).await;
            return Err(insert_failure(*index, err, planned.non_transactional.as_deref()));
        }
    }
    tx.commit().await.map_err(|err| {
        if is_connection_error(&err) {
            OpError::App(AppError::Connection(format!(
                "the connection was lost during COMMIT; the rows may or may not have been \
                 restored, and the trash entry is kept. Check the table before restoring again \
                 ({})",
                describe_sqlx_error(&err)
            )))
        } else {
            OpError::Sql(err)
        }
    })?;
    Ok(u64::try_from(statements.len()).unwrap_or(u64::MAX))
}

/// Inserts `request.rows` into the table in one transaction; any failure restores nothing.
pub async fn restore_rows(session: &MysqlSession, request: &RestoreRequest) -> AppResult<u64> {
    if request.rows.is_empty() {
        return Err(AppError::InvalidInput("no rows to restore".into()));
    }
    let (restored, _) = session
        .run(|mut conn| {
            let request = request.clone();
            boxed(async move {
                let planned = restore_statements(&mut conn, &request).await?;
                insert_all(&mut conn, &request, &planned).await
            })
        })
        .await?;
    Ok(restored)
}

/// The INSERTs [`restore_rows`] would run, as text (see `changes::preview_changes` for the
/// literal and character set rules). Nothing is inserted.
pub async fn preview_restore(
    session: &MysqlSession,
    request: &RestoreRequest,
) -> AppResult<RestorePreview> {
    let (preview, _) = session
        .run(|mut conn| {
            let request = request.clone();
            boxed(async move {
                let planned = restore_statements(&mut conn, &request).await?;
                let total = planned.statements.len();
                let non_transactional_engine = planned.non_transactional.clone();
                let syntax = session_syntax(&mut conn).await?;
                if let Some(charset) = syntax.unsafe_charset {
                    return Ok(RestorePreview {
                        statements: Vec::new(),
                        total,
                        non_transactional_engine,
                        warning: Some(format!(
                            "The connection character set is {charset}, in which the statements \
                             can't be shown safely as SQL text. The rows themselves are sent as \
                             bound values."
                        )),
                    });
                }
                let statements = planned
                    .statements
                    .iter()
                    .take(PREVIEW_STATEMENTS)
                    .map(|s| s.inline(syntax.backslash_escapes))
                    .collect::<AppResult<Vec<_>>>()?;
                Ok(RestorePreview { statements, total, warning: None, non_transactional_engine })
            })
        })
        .await?;
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lost() -> sqlx::Error {
        sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pipe"))
    }

    #[test]
    fn a_lost_connection_is_retried_only_where_it_rolls_back() {
        assert!(insert_failure(0, lost(), None).is_connection_level(), "InnoDB: retried");
        let myisam = insert_failure(1, lost(), Some("MyISAM"));
        assert!(!myisam.is_connection_level(), "MyISAM: never retried");
        let err = myisam.into_app_error();
        assert_eq!(err.kind(), "connection");
        assert!(err.to_string().contains("row 2") && err.to_string().contains("MyISAM"), "{err}");
    }

    #[test]
    fn other_failures_say_what_was_restored() {
        let failed = insert_failure(0, sqlx::Error::RowNotFound, None).into_app_error();
        assert_eq!(failed.kind(), "query");
        assert!(failed.to_string().ends_with("Nothing was restored."), "{failed}");
        let kept = insert_failure(0, sqlx::Error::RowNotFound, Some("MyISAM")).into_app_error();
        assert!(kept.to_string().contains("earlier rows may already be restored"), "{kept}");
    }
}
