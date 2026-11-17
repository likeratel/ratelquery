//! Reads the rows a grid apply deletes, inside its transaction, and saves them to the trash.
//!
//! The rows are read with `SELECT * ... FOR UPDATE` over the text protocol (`sqlx::raw_sql`,
//! keys written as literals), so they decode exactly like a query result: the same
//! `decode_row`, binary column hint and `settle_columns` as `mysql_query`.

use sqlx::mysql::{MySqlConnection, MySqlRow};
use sqlx::{Executor, MySql, Row, Transaction};

use super::binary_hint::{self, has_maybe_text};
use super::cell::Cell;
use super::changes::{BuiltStatement, TrashTarget, build_backup_select, mismatch_error};
use super::decode::{column_metas, column_names, decode_row, settle_columns};
use super::errors::OpError;
use super::literal::{backslash_escapes, is_literal_safe_charset};
use super::model::{RowChange, SchemaColumn, SchemaTable};
use super::options::quote_ident;
use super::type_meta::TypeMeta;
use crate::error::{AppError, AppResult};
use crate::trash::{
    MAX_BACKUP_BYTES, MAX_BACKUP_ROWS, TrashColumn, TrashEntry, TrashSource, TrashStatus,
    backup_failed, new_id, now_rfc3339, too_large_reason,
};
use crate::util::run_blocking;
use std::sync::Arc;

const SESSION_SQL: &str = "SELECT @@SESSION.sql_mode, @@SESSION.character_set_client, \
     @@SESSION.character_set_connection";

/// Rough JSON overhead of one cell (tags and punctuation) for the early size check.
const CELL_OVERHEAD: usize = 16;

/// The backup of one apply: the `SELECT` for each delete, with the change's index.
pub struct BackupPlan {
    pub target: TrashTarget,
    database: String,
    table: SchemaTable,
    selects: Vec<(usize, BuiltStatement)>,
}

impl BackupPlan {
    /// `None` when `changes` delete nothing.
    pub fn new(
        target: TrashTarget,
        database: &str,
        table: &SchemaTable,
        changes: &[RowChange],
    ) -> AppResult<Option<Self>> {
        let selects = changes
            .iter()
            .enumerate()
            .filter_map(|(index, change)| match change {
                RowChange::Delete { key } => Some((index, key)),
                _ => None,
            })
            .map(|(index, key)| Ok((index, build_backup_select(database, table, key)?)))
            .collect::<AppResult<Vec<_>>>()?;
        if selects.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self { target, database: database.to_string(), table: table.clone(), selects }))
    }
}

/// Refuses, before connecting, a batch that deletes more rows than one backup holds.
pub fn check_delete_count(changes: &[RowChange]) -> AppResult<()> {
    let deletes = changes.iter().filter(|c| matches!(c, RowChange::Delete { .. })).count();
    if deletes > MAX_BACKUP_ROWS {
        return Err(backup_failed(format!(
            "{deletes} rows are more than the {MAX_BACKUP_ROWS} one backup can hold"
        )));
    }
    Ok(())
}

/// How this session reads string literals.
pub struct SessionSyntax {
    /// `sql_mode` without `NO_BACKSLASH_ESCAPES`.
    pub backslash_escapes: bool,
    /// The first of `character_set_client` / `character_set_connection` in which literals are
    /// not safe (see [`is_literal_safe_charset`]), if any.
    pub unsafe_charset: Option<String>,
}

pub fn text_at(row: &MySqlRow, index: usize) -> Result<String, sqlx::Error> {
    match row.try_get_unchecked::<Option<String>, _>(index) {
        Ok(text) => Ok(text.unwrap_or_default()),
        Err(_) => {
            let bytes = row.try_get_unchecked::<Option<Vec<u8>>, _>(index)?;
            Ok(String::from_utf8_lossy(&bytes.unwrap_or_default()).into_owned())
        }
    }
}

/// Reads `sql_mode` and the character sets of this session in one query.
pub async fn session_syntax(conn: &mut MySqlConnection) -> Result<SessionSyntax, OpError> {
    let row = conn.fetch_one(sqlx::raw_sql(SESSION_SQL)).await?;
    let mode = text_at(&row, 0)?;
    let charsets = [text_at(&row, 1)?, text_at(&row, 2)?];
    Ok(SessionSyntax {
        backslash_escapes: backslash_escapes(&mode),
        unsafe_charset: charsets.into_iter().find(|c| !is_literal_safe_charset(c)),
    })
}

/// Whether a schema column is single-precision FLOAT (`COLUMN_TYPE` `float`, `float(7,4)`,
/// `float unsigned`). FLOAT(p) above 24 is reported as `double`.
fn is_float(column: &SchemaColumn) -> bool {
    column.type_name.trim().to_ascii_lowercase().starts_with("float")
}

/// The column list of a backup query: every column by name (`*` would leave out INVISIBLE
/// ones), FLOAT ones as `col + 0e0` so the text protocol sends the stored value as a double
/// rather than rounded to 6 digits. The result columns keep the column names.
pub fn backup_column_list(table: &SchemaTable) -> String {
    let columns: Vec<String> = table
        .columns
        .iter()
        .map(|c| {
            let name = quote_ident(&c.name);
            if is_float(c) { format!("{name} + 0e0 AS {name}") } else { name }
        })
        .collect();
    columns.join(", ")
}

/// Storage engines that roll back: a failed delete on them leaves no rows changed.
const TRANSACTIONAL_ENGINES: [&str; 2] = ["InnoDB", "ndbcluster"];

const ENGINE_SQL: &str =
    "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";

/// `information_schema.TABLES.ENGINE` of a table (empty when unknown).
pub async fn table_engine(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<String, OpError> {
    let row = sqlx::query(ENGINE_SQL).bind(database).bind(table).fetch_optional(&mut *conn).await?;
    Ok(match row {
        Some(row) => row
            .try_get_unchecked::<Option<String>, _>(0)
            .ok()
            .flatten()
            .or_else(|| {
                row.try_get_unchecked::<Option<Vec<u8>>, _>(0)
                    .ok()
                    .flatten()
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
            })
            .unwrap_or_default(),
        None => String::new(),
    })
}

/// Whether `engine` rolls back (InnoDB, NDB).
pub fn is_transactional(engine: &str) -> bool {
    TRANSACTIONAL_ENGINES.iter().any(|e| e.eq_ignore_ascii_case(engine))
}

/// Approximate encoded size of a cell, for stopping early on a huge delete.
pub fn approx_size(cell: &Cell) -> usize {
    CELL_OVERHEAD
        + match cell {
            Cell::Null => 0,
            Cell::Float(_) => 24,
            Cell::Bool(_) => 5,
            Cell::Str(v)
            | Cell::Int(v)
            | Cell::Decimal(v)
            | Cell::Date(v)
            | Cell::Time(v)
            | Cell::Datetime(v)
            | Cell::Json(v)
            | Cell::Bytes(v) => v.len(),
        }
}

/// Reads and locks each row; a key matching anything but one row fails like the delete would.
async fn fetch_rows(
    tx: &mut Transaction<'_, MySql>,
    selects: &[(usize, BuiltStatement)],
    escapes: bool,
) -> Result<Fetched, OpError> {
    let mut shape: Option<(Vec<String>, Vec<TypeMeta>)> = None;
    let mut rows = Vec::with_capacity(selects.len());
    let mut size = 0usize;
    for (index, select) in selects {
        let sql = select.inline(escapes)?;
        let found = (&mut **tx).fetch_all(sqlx::raw_sql(&sql)).await?;
        let [row] = found.as_slice() else {
            return Err(mismatch_error(*index, u64::try_from(found.len()).unwrap_or(u64::MAX)));
        };
        let (_, metas) =
            shape.get_or_insert_with(|| (column_names(row.columns()), column_metas(row.columns())));
        let decoded = decode_row(row, metas)?;
        size = size.saturating_add(decoded.iter().map(approx_size).sum());
        if size > MAX_BACKUP_BYTES {
            return Err(backup_failed(too_large_reason(size)).into());
        }
        rows.push(decoded);
    }
    let (names, metas) = shape.unwrap_or_default();
    Ok(Fetched { names, metas, rows })
}

/// Reads the rows `plan` deletes and saves them as a `pending` entry. Returns the entry id.
/// A row that is not there fails like its delete (`query`); an entry that cannot be saved is
/// `backup_failed`, and so is a session character set in which the key literals could be
/// misread (nothing is selected then). Either way the caller rolls back.
/// A saved grid backup: its entry id, and the table's engine when that engine can't roll back.
pub struct Saved {
    pub id: String,
    /// `Some(engine)` for MyISAM and other engines without transactions.
    pub non_transactional: Option<String>,
}

pub async fn save(tx: &mut Transaction<'_, MySql>, plan: BackupPlan) -> Result<Saved, OpError> {
    let syntax = session_syntax(tx).await?;
    if let Some(charset) = syntax.unsafe_charset {
        return Err(backup_failed(format!(
            "the connection character set is {charset}, in which the backup query can't be \
             written safely (it works with utf8mb4, the default)"
        ))
        .into());
    }
    let fetched = fetch_rows(tx, &plan.selects, syntax.backslash_escapes).await?;
    let engine = table_engine(tx, &plan.database, &plan.table.name).await?;
    let origin = Origin {
        target: &plan.target,
        database: &plan.database,
        table: &plan.table,
        source: TrashSource::Grid,
        statement: None,
    };
    let id = save_rows(tx, origin, fetched).await?;
    Ok(Saved { id, non_transactional: (!is_transactional(&engine)).then_some(engine) })
}

/// Where backed-up rows came from.
pub struct Origin<'a> {
    pub target: &'a TrashTarget,
    pub database: &'a str,
    pub table: &'a SchemaTable,
    pub source: TrashSource,
    pub statement: Option<&'a str>,
}

/// Rows read for a backup, decoded like a query result but not settled yet.
pub struct Fetched {
    pub names: Vec<String>,
    pub metas: Vec<TypeMeta>,
    pub rows: Vec<Vec<Cell>>,
}

/// Settles `fetched` like a query result (binary hint from the table) and writes it as a
/// `pending` entry. Returns the entry id; `backup_failed` when it can't be written.
pub async fn save_rows(
    conn: &mut MySqlConnection,
    origin: Origin<'_>,
    fetched: Fetched,
) -> AppResult<String> {
    let metas = if has_maybe_text(&fetched.metas) {
        let hint = binary_hint::lookup_table(conn, origin.database, &origin.table.name).await;
        binary_hint::apply(&fetched.names, &fetched.metas, &hint)
    } else {
        fetched.metas
    };
    let (columns, rows) = settle_columns(&fetched.names, &metas, fetched.rows);
    let entry = TrashEntry {
        id: new_id(),
        status: TrashStatus::Pending,
        deleted_at: now_rfc3339(),
        connection_id: origin.target.connection_id.clone(),
        connection_name: origin.target.connection_name.clone(),
        database: origin.database.to_string(),
        table: origin.table.name.clone(),
        source: origin.source,
        statement: origin.statement.map(str::to_string),
        columns: columns
            .into_iter()
            .map(|c| {
                // FLOAT columns were read as doubles (see `backup_column_list`).
                let float = origin.table.columns.iter().any(|s| s.name == c.name && is_float(s));
                let type_name = if float { "FLOAT".to_string() } else { c.type_name };
                TrashColumn { name: c.name, type_name }
            })
            .collect(),
        primary_key: origin
            .table
            .columns
            .iter()
            .filter(|c| c.is_primary)
            .map(|c| c.name.clone())
            .collect(),
        rows,
    };
    let id = entry.id.clone();
    let store = Arc::clone(&origin.target.store);
    run_blocking(move || store.begin(entry)).await.map_err(|err| match err {
        AppError::BackupFailed(_) => err,
        other => backup_failed(other),
    })?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_columns_are_read_as_doubles_under_their_own_names() {
        let column = |name: &str, type_name: &str| SchemaColumn {
            name: name.into(),
            type_name: type_name.into(),
            nullable: true,
            is_primary: false,
            is_auto_increment: false,
            default_value: None,
            comment: String::new(),
        };
        let table = SchemaTable {
            name: "t".into(),
            kind: super::super::model::TableKind::Table,
            columns: vec![
                column("id", "int"),
                column("f", "float"),
                column("g`", "FLOAT(7,4) unsigned"),
                column("d", "double"),
            ],
        };
        assert_eq!(backup_column_list(&table), "`id`, `f` + 0e0 AS `f`, `g``` + 0e0 AS `g```, `d`");
    }

    #[test]
    fn approximate_size_grows_with_the_value() {
        assert_eq!(approx_size(&Cell::Null), CELL_OVERHEAD);
        assert_eq!(approx_size(&Cell::Str("abc".into())), CELL_OVERHEAD + 3);
        assert_eq!(approx_size(&Cell::Bytes("AAAA".into())), CELL_OVERHEAD + 4);
        assert!(approx_size(&Cell::Float(1.0)) > CELL_OVERHEAD);
    }
}
