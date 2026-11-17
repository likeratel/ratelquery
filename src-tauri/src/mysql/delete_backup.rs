//! Runs one DELETE typed in the editor with its rows saved to the trash first, in a transaction
//! of its own: `BEGIN`, read the rows `FOR UPDATE` (see `delete_plan`), write the entry
//! `pending`, run the user's DELETE as written, check it removed exactly those rows (same count
//! and, with a primary key, none of their keys left), `COMMIT`, mark the entry `committed`.
//!
//! Anything that keeps the backup from matching the delete stops the statement instead
//! ([`BackedDelete::Stopped`]); nothing is deleted then and the user may run it without a backup.

use std::collections::HashMap;
use std::time::Instant;

use futures_util::TryStreamExt;
use sqlx::mysql::MySqlConnection;
use sqlx::{Connection, Either, Executor, MySql, Row, Transaction};

use super::backup::{
    Fetched, Origin, approx_size, is_transactional, save_rows, session_syntax, table_engine,
    text_at,
};
use super::cell::Cell;
use super::changes::{Outcome, TrashTarget, resolve_table, settle_entry};
use super::decode::{column_metas, column_names, decode_row};
use super::delete_plan::DeleteTarget;
use super::errors::{OpError, describe_sqlx_error, is_connection_error, mysql_error_number};
use super::literal::cell_literal;
use super::model::{ExecResult, SchemaTable, TableKind};
use super::options::quote_ident;
use super::type_meta::TypeMeta;
use crate::error::{AppError, AppResult};
use crate::trash::{MAX_BACKUP_BYTES, MAX_BACKUP_ROWS, TrashSource, too_large_reason};
use crate::util::elapsed_ms;

/// `ER_CANT_CHANGE_TX_CHARACTERISTICS`: `SET TRANSACTION` while a transaction is open.
const IN_TRANSACTION_ERROR: u16 = 1568;
/// `ER_UNKNOWN_SYSTEM_VARIABLE`, for servers without `transaction_isolation`.
const UNKNOWN_VARIABLE_ERROR: u16 = 1193;
const ISOLATION_LEVELS: [&str; 4] =
    ["READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"];
/// Keys checked per query after the delete.
const KEY_CHECK_BATCH: usize = 500;
/// Longest statement text kept with a trash entry.
pub const MAX_STORED_STATEMENT: usize = 16 * 1024;
const TRUNCATED_MARK: &str = "\n-- … (truncated)";

/// How a backed-up DELETE ended when it did not fail.
pub enum BackedDelete {
    Done(ExecResult),
    /// Nothing was deleted: the rows can't be backed up, for the reason given.
    Stopped(String),
}

/// Table definitions resolved during one run, so a script of many DELETEs on the same table
/// reads the schema once.
#[derive(Default)]
pub struct TableCache(HashMap<(String, String), (String, SchemaTable)>);

impl TableCache {
    /// Forgets every definition (a statement may have changed a table).
    pub fn clear(&mut self) {
        self.0.clear();
    }
}

enum Resolved {
    Found(String, SchemaTable),
    Missing(String),
}

impl TableCache {
    async fn resolve(
        &mut self,
        conn: &mut MySqlConnection,
        database: &str,
        table: &str,
    ) -> Result<Resolved, OpError> {
        let key = (database.to_string(), table.to_string());
        if let Some((database, found)) = self.0.get(&key) {
            return Ok(Resolved::Found(database.clone(), found.clone()));
        }
        match resolve_table(conn, database, table).await {
            Ok((database, found)) => {
                self.0.insert(key, (database.clone(), found.clone()));
                Ok(Resolved::Found(database, found))
            }
            Err(OpError::App(AppError::InvalidInput(message))) => Ok(Resolved::Missing(message)),
            Err(err) => Err(err),
        }
    }
}

/// The session's isolation level as SQL (`REPEATABLE READ`), from `transaction_isolation` or,
/// on older servers, `tx_isolation`.
async fn isolation_level(conn: &mut MySqlConnection) -> Result<Option<String>, OpError> {
    let mut value = None;
    for variable in ["transaction_isolation", "tx_isolation"] {
        let sql = format!("SELECT @@SESSION.{variable}");
        match conn.fetch_one(sqlx::raw_sql(&sql)).await {
            Ok(row) => {
                value = Some(text_at(&row, 0)?);
                break;
            }
            Err(err) if mysql_error_number(&err) == Some(UNKNOWN_VARIABLE_ERROR) => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(value
        .map(|v| v.replace('-', " ").to_ascii_uppercase())
        .filter(|v| ISOLATION_LEVELS.contains(&v.as_str())))
}

/// Why our `BEGIN` can't be used on this connection, if it can't: with autocommit off, or with
/// a transaction open, `BEGIN` would commit the user's own work. An open transaction is found by
/// re-setting the next transaction's isolation level to the current one, which the server
/// refuses while one is open; that changes nothing otherwise.
async fn transaction_blocker(conn: &mut MySqlConnection) -> Result<Option<String>, OpError> {
    let row = conn.fetch_one(sqlx::raw_sql("SELECT @@SESSION.autocommit")).await?;
    if text_at(&row, 0)? != "1" {
        return Ok(Some(
            "autocommit is off on this connection, so the delete can't run in a transaction \
             of its own"
                .into(),
        ));
    }
    let Some(isolation) = isolation_level(conn).await? else {
        return Ok(Some("the session's transaction isolation level could not be read".into()));
    };
    let set = format!("SET TRANSACTION ISOLATION LEVEL {isolation}");
    match conn.execute(sqlx::raw_sql(&set)).await {
        Ok(_) => Ok(None),
        Err(err) if mysql_error_number(&err) == Some(IN_TRANSACTION_ERROR) => Ok(Some(
            "a transaction is open on this connection, and backing up would commit it".into(),
        )),
        Err(err) => Err(err.into()),
    }
}

async fn current_database(conn: &mut MySqlConnection) -> Result<Option<String>, OpError> {
    let row = conn.fetch_one(sqlx::raw_sql("SELECT DATABASE()")).await?;
    let name = text_at(&row, 0)?;
    Ok((!name.is_empty()).then_some(name))
}

/// A temporary table of the same name hides the base table from this session.
pub(super) async fn is_temporary(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<bool, OpError> {
    let sql = format!("SHOW CREATE TABLE {}.{}", quote_ident(database), quote_ident(table));
    let row = conn.fetch_one(sqlx::raw_sql(&sql)).await?;
    let ddl = text_at(&row, 1)?;
    Ok(ddl.trim_start().to_ascii_uppercase().starts_with("CREATE TEMPORARY TABLE"))
}

/// `SELECT <every column> FROM ... FOR UPDATE`, capped one row past the backup limit when the
/// DELETE has no LIMIT of its own, so a too-large delete stops without reading the rest.
fn backup_select(target: &DeleteTarget, table: &SchemaTable) -> String {
    let columns = super::backup::backup_column_list(table);
    let cap = if target.limit.is_none() {
        format!("\nLIMIT {}", MAX_BACKUP_ROWS + 1)
    } else {
        String::new()
    };
    // Each on its own line, so a trailing `-- comment` in the user's text can't hide them.
    format!("SELECT {columns} {}{cap}\nFOR UPDATE", target.from_sql)
}

/// Streams the rows the delete would remove; `Err(reason)` once they pass a backup limit or
/// the query returns more than one result set.
async fn read_rows(
    conn: &mut MySqlConnection,
    select_sql: &str,
) -> Result<Result<Fetched, String>, OpError> {
    let mut shape: Option<(Vec<String>, Vec<TypeMeta>)> = None;
    let mut rows = Vec::new();
    let mut size = 0usize;
    let mut sets = 0;
    let mut stream = conn.fetch_many(sqlx::raw_sql(select_sql));
    while let Some(item) = stream.try_next().await? {
        let row = match item {
            Either::Left(_) => {
                sets += 1;
                if sets > 1 {
                    return Ok(Err("the backup query returned more than one result".into()));
                }
                continue;
            }
            Either::Right(row) => row,
        };
        let (_, metas) =
            shape.get_or_insert_with(|| (column_names(row.columns()), column_metas(row.columns())));
        let decoded = decode_row(&row, metas)?;
        size = size.saturating_add(decoded.iter().map(approx_size).sum());
        if rows.len() >= MAX_BACKUP_ROWS {
            return Ok(Err(format!(
                "it deletes more than the {MAX_BACKUP_ROWS} rows one backup can hold"
            )));
        }
        if size > MAX_BACKUP_BYTES {
            return Ok(Err(too_large_reason(size)));
        }
        rows.push(decoded);
    }
    let (names, metas) = shape.unwrap_or_default();
    Ok(Ok(Fetched { names, metas, rows }))
}

/// The key of each row, as literals, for the primary key columns at `positions`; none without
/// a primary key.
fn key_literals(rows: &[Vec<Cell>], positions: &[usize], escapes: bool) -> AppResult<Vec<String>> {
    if positions.is_empty() {
        return Ok(Vec::new());
    }
    rows.iter()
        .map(|row| {
            let parts = positions
                .iter()
                .map(|&i| row.get(i).map_or(Ok("NULL".to_string()), |c| cell_literal(c, escapes)))
                .collect::<AppResult<Vec<_>>>()?;
            Ok(if parts.len() == 1 { parts.join("") } else { format!("({})", parts.join(", ")) })
        })
        .collect()
}

/// Whether any of `keys` is still in the table after the delete (same transaction).
/// How many rows of the table hold one of `keys` (same transaction), counted in batches.
/// Before the delete this must be every backed-up row, or the key literals don't match the
/// stored values (a FLOAT key, a character set mismatch) and the check after would prove
/// nothing; after it, none.
async fn rows_with_keys(
    conn: &mut MySqlConnection,
    checked: &Checked,
    keys: &[String],
) -> Result<u64, OpError> {
    let target = format!("{}.{}", quote_ident(&checked.database), quote_ident(&checked.table.name));
    let columns: Vec<String> = checked.key_columns.iter().map(|c| quote_ident(c)).collect();
    let lhs =
        if columns.len() == 1 { columns.join("") } else { format!("({})", columns.join(", ")) };
    let mut total = 0u64;
    for batch in keys.chunks(KEY_CHECK_BATCH) {
        let sql = format!("SELECT COUNT(*) FROM {target} WHERE {lhs} IN ({})", batch.join(", "));
        let row = conn.fetch_one(sqlx::raw_sql(&sql)).await?;
        total = total.saturating_add(text_at(&row, 0)?.parse::<u64>().unwrap_or(u64::MAX));
    }
    Ok(total)
}

/// MySQL syntax error: the backup query built from the DELETE didn't parse.
const SYNTAX_ERROR: u16 = 1064;

/// The statement as kept with the entry: from its first token (leading comments dropped), at
/// most [`MAX_STORED_STATEMENT`] bytes.
pub fn stored_statement(statement: &str) -> String {
    let start = super::classify::first_token_start(statement);
    let text = statement[start..].trim();
    if text.len() <= MAX_STORED_STATEMENT {
        return text.to_string();
    }
    let mut cut = MAX_STORED_STATEMENT;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{TRUNCATED_MARK}", &text[..cut])
}

/// Everything checked before `BEGIN`: why this DELETE can't be backed up on this connection,
/// or the resolved database, table and literal escaping for its key check.
struct Checked {
    database: String,
    table: SchemaTable,
    key_columns: Vec<String>,
    escapes: bool,
}

async fn check_before(
    conn: &mut MySqlConnection,
    statement: &str,
    target: &DeleteTarget,
    cache: &mut TableCache,
) -> Result<Result<Checked, String>, OpError> {
    let syntax = session_syntax(conn).await?;
    if let Some(charset) = syntax.unsafe_charset {
        return Ok(Err(format!(
            "the connection character set is {charset}; backups need utf8mb4 (the default)"
        )));
    }
    if !syntax.backslash_escapes && statement.contains('\\') {
        return Ok(Err("sql_mode has NO_BACKSLASH_ESCAPES and the statement has a backslash, \
             so the app can't be sure how the server splits it"
            .into()));
    }
    if let Some(reason) = transaction_blocker(conn).await? {
        return Ok(Err(reason));
    }
    if target.limit.is_some_and(|n| n > u64::try_from(MAX_BACKUP_ROWS).unwrap_or(u64::MAX)) {
        return Ok(Err(format!(
            "its LIMIT is over the {MAX_BACKUP_ROWS} rows one backup can hold"
        )));
    }
    let database = match &target.database {
        Some(database) => database.clone(),
        None => match current_database(conn).await? {
            Some(database) => database,
            None => return Ok(Err("no database is selected".into())),
        },
    };
    let (database, table) = match cache.resolve(conn, &database, &target.table).await? {
        Resolved::Found(database, table) => (database, table),
        Resolved::Missing(message) => {
            return Ok(Err(format!(
                "{message} (it may be a temporary table, which can't be backed up)"
            )));
        }
    };
    if table.kind != TableKind::Table {
        return Ok(Err(format!("{} is a view; only rows of tables can be backed up", table.name)));
    }
    if is_temporary(conn, &database, &table.name).await? {
        return Ok(Err(format!(
            "a temporary table named {} hides the table in this session",
            table.name
        )));
    }
    let engine = table_engine(conn, &database, &table.name).await?;
    if !is_transactional(&engine) {
        return Ok(Err(format!(
            "{} uses the {engine} engine, which can't roll back a failed delete",
            table.name
        )));
    }
    let key_columns: Vec<String> =
        table.columns.iter().filter(|c| c.is_primary).map(|c| c.name.clone()).collect();
    if key_columns.is_empty()
        && let Some(reason) = &target.needs_key
    {
        return Ok(Err(format!(
            "{} has no primary key to check the deleted rows against, and {reason}",
            table.name
        )));
    }
    Ok(Ok(Checked { database, table, key_columns, escapes: syntax.backslash_escapes }))
}

async fn roll_back(tx: Transaction<'_, MySql>) {
    if let Err(err) = tx.rollback().await {
        eprintln!("rollback of a backed-up delete did not complete: {}", describe_sqlx_error(&err));
    }
}

/// Runs `statement` (a DELETE `classify_delete` accepted as `target`) with its rows backed up
/// to `trash`. `Stopped` means nothing was deleted. Errors are the statement's own (the backup
/// is discarded) or a lost COMMIT (the entry is marked uncertain).
pub async fn run_backed_delete(
    conn: &mut MySqlConnection,
    statement: &str,
    target: &DeleteTarget,
    trash: &TrashTarget,
    cache: &mut TableCache,
) -> Result<BackedDelete, OpError> {
    let start = Instant::now();
    let checked = match check_before(conn, statement, target, cache).await? {
        Ok(checked) => checked,
        Err(reason) => return Ok(BackedDelete::Stopped(reason)),
    };
    let positions: Vec<usize> = checked
        .table
        .columns
        .iter()
        .enumerate()
        .filter(|(_, c)| c.is_primary)
        .map(|(i, _)| i)
        .collect();
    let mut tx = conn.begin().await?;
    let fetched = match read_rows(&mut tx, &backup_select(target, &checked.table)).await {
        Ok(Ok(fetched)) => fetched,
        Ok(Err(reason)) => {
            roll_back(tx).await;
            return Ok(BackedDelete::Stopped(reason));
        }
        Err(OpError::Sql(ref err)) if mysql_error_number(err) == Some(SYNTAX_ERROR) => {
            // Without a backup the user's DELETE runs and reports its own error.
            roll_back(tx).await;
            return Ok(BackedDelete::Stopped(
                "this DELETE's syntax couldn't be checked for a backup (the server rejected \
                 the backup query)"
                    .into(),
            ));
        }
        Err(err) => {
            roll_back(tx).await;
            return Err(err);
        }
    };
    let keys = match key_literals(&fetched.rows, &positions, checked.escapes) {
        Ok(keys) => keys,
        Err(err) => {
            roll_back(tx).await;
            return Ok(BackedDelete::Stopped(format!("its keys can't be checked: {err}")));
        }
    };
    let backed_up = u64::try_from(fetched.rows.len()).unwrap_or(u64::MAX);
    if !keys.is_empty() {
        match rows_with_keys(&mut tx, &checked, &keys).await {
            Ok(found) if found == backed_up => {}
            Ok(_) => {
                roll_back(tx).await;
                return Ok(BackedDelete::Stopped(
                    "the primary key values can't be matched exactly (for example a FLOAT key), \
                     so the deleted rows couldn't be checked"
                        .into(),
                ));
            }
            Err(err) => {
                roll_back(tx).await;
                return Err(err);
            }
        }
    }
    let kept = stored_statement(statement);
    let id = if fetched.rows.is_empty() {
        None
    } else {
        let origin = Origin {
            target: trash,
            database: &checked.database,
            table: &checked.table,
            source: TrashSource::Sql,
            statement: Some(&kept),
        };
        match save_rows(&mut tx, origin, fetched).await {
            Ok(id) => Some(id),
            Err(err) => {
                roll_back(tx).await;
                return Ok(BackedDelete::Stopped(err.to_string()));
            }
        }
    };
    let store = Some(&trash.store);
    let deleted = match (&mut *tx).execute(sqlx::raw_sql(statement)).await {
        Ok(done) => done.rows_affected(),
        Err(err) => {
            roll_back(tx).await;
            settle_entry(store, id, Outcome::RolledBack).await;
            return Err(err.into());
        }
    };
    let left = if keys.is_empty() || deleted != backed_up {
        0
    } else {
        match rows_with_keys(&mut tx, &checked, &keys).await {
            Ok(left) => left,
            Err(err) => {
                roll_back(tx).await;
                settle_entry(store, id, Outcome::RolledBack).await;
                return Err(err);
            }
        }
    };
    let mismatch = if deleted != backed_up {
        Some(format!(
            "the DELETE removed {deleted} rows but the backup read {backed_up}, so it was undone"
        ))
    } else if left > 0 {
        Some("the DELETE removed other rows than the backup read, so it was undone".into())
    } else {
        None
    };
    if let Some(reason) = mismatch {
        roll_back(tx).await;
        settle_entry(store, id, Outcome::RolledBack).await;
        return Ok(BackedDelete::Stopped(reason));
    }
    match tx.commit().await {
        Ok(()) => settle_entry(store, id.clone(), Outcome::Committed).await,
        Err(err) if is_connection_error(&err) => {
            settle_entry(store, id, Outcome::Unknown).await;
            return Err(AppError::Connection(format!(
                "the connection was lost during COMMIT; the delete may or may not be applied \
                 (its rows are in the trash, marked uncertain): {}",
                describe_sqlx_error(&err)
            ))
            .into());
        }
        Err(err) => {
            settle_entry(store, id, Outcome::RolledBack).await;
            return Err(err.into());
        }
    }
    Ok(BackedDelete::Done(ExecResult {
        affected_rows: deleted,
        last_insert_id: None,
        elapsed_ms: elapsed_ms(start),
        reconnected: false,
        statement: statement.to_string(),
        trashed_rows: Some(backed_up),
        trash_id: id,
    }))
}

/// [`run_backed_delete`] for one statement on one given connection, for callers (and tests)
/// that need that connection's session state. `Ok(Err(reason))` when it is not a DELETE that
/// can be backed up, or the backup stopped; nothing was deleted then.
pub async fn backed_delete_on_connection(
    conn: &mut MySqlConnection,
    statement: &str,
    trash: &TrashTarget,
) -> AppResult<Result<ExecResult, String>> {
    let target = match super::delete_plan::classify_delete(statement) {
        super::delete_plan::DeleteKind::Backup(target) => target,
        super::delete_plan::DeleteKind::Unsupported(reason) => return Ok(Err(reason)),
        super::delete_plan::DeleteKind::NotDelete => return Ok(Err("not a DELETE".into())),
    };
    let mut cache = TableCache::default();
    match run_backed_delete(conn, statement, &target, trash, &mut cache).await {
        Ok(BackedDelete::Done(exec)) => Ok(Ok(exec)),
        Ok(BackedDelete::Stopped(reason)) => Ok(Err(reason)),
        Err(err) => Err(err.into_app_error()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_statements_drop_leading_comments_and_are_capped() {
        assert_eq!(stored_statement("/* why */ -- note\n DELETE FROM t"), "DELETE FROM t");
        assert_eq!(stored_statement("DELETE FROM t WHERE id = 1"), "DELETE FROM t WHERE id = 1");
        let long = format!("DELETE FROM t WHERE name = '{}'", "한".repeat(10_000));
        let kept = stored_statement(&long);
        assert!(kept.ends_with(TRUNCATED_MARK));
        assert!(kept.len() <= MAX_STORED_STATEMENT + TRUNCATED_MARK.len());
    }

    #[test]
    fn key_literals_cover_single_and_composite_keys() {
        let rows = vec![
            vec![Cell::Int("1".into()), Cell::Str("a'b".into())],
            vec![Cell::Int("2".into()), Cell::Bytes("AP8=".into())],
        ];
        assert_eq!(key_literals(&rows, &[0], true).unwrap(), ["1", "2"]);
        assert_eq!(key_literals(&rows, &[0, 1], true).unwrap(), ["(1, 'a''b')", "(2, X'00ff')"]);
        assert!(key_literals(&rows, &[], true).unwrap().is_empty(), "no key, nothing to check");
    }
}
