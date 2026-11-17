//! `mysql_apply_changes`: grid edits applied in one transaction, with the deleted rows saved
//! to the trash first; `mysql_preview_changes`: the statements an apply would run.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

use sqlx::mysql::MySqlConnection;
use sqlx::{Connection, MySql, Transaction};

use super::backup::{self, BackupPlan};
use super::bind::{BindValue, bind_value, to_bind_value};
use super::cell::Cell;
use super::errors::{OpError, describe_sqlx_error, is_connection_error};
use super::literal::inline_binds;
use super::model::{ApplyChangesResult, RowChange, SchemaTable, TableKind};
use super::options::quote_ident;
use super::schema::{all_databases, fetch_schema};
use super::session::{MysqlSession, boxed};
use crate::error::{AppError, AppResult};
use crate::trash::TrashStore;
use crate::util::{elapsed_ms, run_blocking};

/// Guards against runaway updates: two rows are enough to detect a non-unique key.
pub(super) const MATCH_LIMIT: u32 = 2;

#[derive(Debug, Clone, PartialEq)]
pub struct BuiltStatement {
    pub sql: String,
    pub binds: Vec<BindValue>,
    pub expect_one: bool,
    /// Byte offset in `sql` of the `?` for each bind, in bind order.
    pub placeholders: Vec<usize>,
}

impl BuiltStatement {
    /// The statement with every bind written as a literal, as MySQL will see it.
    pub fn inline(&self, backslash_escapes: bool) -> AppResult<String> {
        inline_binds(&self.sql, &self.placeholders, &self.binds, backslash_escapes)
    }
}

/// SQL text that records where each placeholder goes, so binds can be inlined without
/// scanning the text (a quoted identifier may contain `?`).
#[derive(Default)]
struct SqlText {
    sql: String,
    placeholders: Vec<usize>,
}

impl SqlText {
    fn push(&mut self, text: &str) -> &mut Self {
        self.sql.push_str(text);
        self
    }

    fn mark(&mut self) -> &mut Self {
        self.placeholders.push(self.sql.len());
        self.sql.push('?');
        self
    }

    /// `<quoted column><between>?` for each column, separated by `separator`.
    fn columns(&mut self, columns: &[&String], between: &str, separator: &str) -> &mut Self {
        for (index, column) in columns.iter().enumerate() {
            if index > 0 {
                self.push(separator);
            }
            self.push(&quote_ident(column)).push(between).mark();
        }
        self
    }

    fn finish(self, binds: Vec<BindValue>, expect_one: bool) -> BuiltStatement {
        BuiltStatement { sql: self.sql, binds, expect_one, placeholders: self.placeholders }
    }
}

/// Where a grid apply saves the rows it deletes.
#[derive(Clone)]
pub struct TrashTarget {
    pub store: Arc<TrashStore>,
    pub connection_id: String,
    /// The connection's name, kept with the entry.
    pub connection_name: String,
}

/// `values` keyed by the live column names. MySQL column names ignore letter case, so a stale
/// client snapshot that spells a column differently still maps to that one column; two keys
/// naming the same column are rejected.
fn live_columns(
    table: &SchemaTable,
    values: &BTreeMap<String, Cell>,
) -> AppResult<BTreeMap<String, Cell>> {
    let mut resolved = BTreeMap::new();
    for (name, value) in values {
        let live = resolve_name(table.columns.iter().map(|c| c.name.as_str()), name, || {
            format!("column {name} does not exist in table {}", table.name)
        })?;
        if resolved.insert(live.to_string(), value.clone()).is_some() {
            return Err(AppError::InvalidInput(format!("column {live} is given twice")));
        }
    }
    Ok(resolved)
}

fn binds(values: &BTreeMap<String, Cell>) -> AppResult<Vec<BindValue>> {
    values.values().map(to_bind_value).collect()
}

/// `<key> <=> ? AND ...`; the same matching for the statement and its trash backup.
fn push_where(out: &mut SqlText, key: &BTreeMap<String, Cell>) -> AppResult<()> {
    if key.is_empty() {
        return Err(AppError::InvalidInput("a row key must not be empty".into()));
    }
    out.push(" WHERE ").columns(&key.keys().collect::<Vec<_>>(), " <=> ", " AND ");
    Ok(())
}

fn target(database: &str, table: &SchemaTable) -> String {
    format!("{}.{}", quote_ident(database), quote_ident(&table.name))
}

/// Builds one statement after checking every column against the live table definition.
pub fn build_statement(
    database: &str,
    table: &SchemaTable,
    change: &RowChange,
) -> AppResult<BuiltStatement> {
    let target = target(database, table);
    let mut out = SqlText::default();
    match change {
        RowChange::Update { key, set } => {
            if set.is_empty() {
                return Err(AppError::InvalidInput(
                    "an update must set at least one column".into(),
                ));
            }
            let (key, set) = (&live_columns(table, key)?, &live_columns(table, set)?);
            out.push("UPDATE ").push(&target).push(" SET ");
            out.columns(&set.keys().collect::<Vec<_>>(), " = ", ", ");
            push_where(&mut out, key)?;
            out.push(&format!(" LIMIT {MATCH_LIMIT}"));
            let all = binds(set)?.into_iter().chain(binds(key)?).collect();
            Ok(out.finish(all, true))
        }
        RowChange::Delete { key } => {
            let key = &live_columns(table, key)?;
            out.push("DELETE FROM ").push(&target);
            push_where(&mut out, key)?;
            out.push(&format!(" LIMIT {MATCH_LIMIT}"));
            Ok(out.finish(binds(key)?, true))
        }
        RowChange::Insert { values } => {
            let values = &live_columns(table, values)?;
            let columns: Vec<String> = values.keys().map(|c| quote_ident(c)).collect();
            out.push("INSERT INTO ")
                .push(&target)
                .push(&format!(" ({}) VALUES (", columns.join(", ")));
            for index in 0..values.len() {
                if index > 0 {
                    out.push(", ");
                }
                out.mark();
            }
            out.push(")");
            Ok(out.finish(binds(values)?, false))
        }
    }
}

/// `SELECT * ... FOR UPDATE` of the row a delete removes, matched exactly like the delete.
/// Locking the row keeps it unchanged until the delete runs in the same transaction.
pub(super) fn build_backup_select(
    database: &str,
    table: &SchemaTable,
    key: &BTreeMap<String, Cell>,
) -> AppResult<BuiltStatement> {
    let key = &live_columns(table, key)?;
    let mut out = SqlText::default();
    let columns = super::backup::backup_column_list(table);
    out.push(&format!("SELECT {columns} FROM ")).push(&target(database, table));
    push_where(&mut out, key)?;
    out.push(&format!(" LIMIT {MATCH_LIMIT} FOR UPDATE"));
    Ok(out.finish(binds(key)?, true))
}

/// The live name `wanted` refers to: an exact match first, otherwise the only name that differs
/// from it just in letter case. The grid sends names spelled as the query wrote them, which is
/// what MySQL resolved, so a stale client snapshot never picks the table. Several case-folded
/// matches without an exact one could be any of them, so that is rejected.
pub fn resolve_name<'a>(
    names: impl IntoIterator<Item = &'a str>,
    wanted: &str,
    missing: impl FnOnce() -> String,
) -> AppResult<&'a str> {
    let lower = wanted.to_lowercase();
    let mut folded = Vec::new();
    for name in names {
        if name == wanted {
            return Ok(name);
        }
        if name.to_lowercase() == lower {
            folded.push(name);
        }
    }
    match folded.as_slice() {
        [only] => Ok(only),
        [] => Err(AppError::InvalidInput(missing())),
        several => Err(AppError::InvalidInput(format!(
            "{wanted} matches {} only by letter case; spell it exactly",
            several.join(", ")
        ))),
    }
}

/// Resolves the database and table against the live schema and returns the database name and
/// definition as the server spells them; views included.
pub(super) async fn resolve_table(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<(String, SchemaTable), OpError> {
    let databases = all_databases(conn).await?;
    let database = resolve_name(databases.iter().map(String::as_str), database, || {
        format!("database {database} does not exist")
    })?
    .to_string();
    let snapshot = fetch_schema(conn, &database).await.map_err(|err| match err {
        OpError::App(AppError::NotFound(m)) => OpError::App(AppError::InvalidInput(m)),
        other => other,
    })?;
    let name = resolve_name(snapshot.tables.iter().map(|t| t.name.as_str()), table, || {
        format!("table {table} does not exist in {database}")
    })?
    .to_string();
    let found = snapshot.tables.into_iter().find(|t| t.name == name).ok_or_else(|| {
        AppError::InvalidInput(format!("table {table} does not exist in {database}"))
    })?;
    Ok((database, found))
}

/// [`resolve_table`] for a base table; a view is `invalid_input`.
pub(super) async fn load_table(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<(String, SchemaTable), OpError> {
    let (database, found) = resolve_table(conn, database, table).await?;
    let name = found.name.clone();
    if found.kind != TableKind::Table {
        return Err(
            AppError::InvalidInput(format!("{name} is a view; only tables can be edited")).into()
        );
    }
    Ok((database, found))
}

/// The error for a change whose key matched `rows` rows instead of exactly one.
pub(super) fn mismatch_error(index: usize, rows: u64) -> OpError {
    AppError::Query(format!(
        "change {} matched {} rows instead of exactly 1; all changes were rolled back",
        index + 1,
        if rows >= u64::from(MATCH_LIMIT) { "more than 1".to_string() } else { rows.to_string() }
    ))
    .into()
}

async fn run_statements(
    tx: &mut Transaction<'_, MySql>,
    statements: &[BuiltStatement],
) -> Result<u64, OpError> {
    let mut affected = 0;
    for (index, statement) in statements.iter().enumerate() {
        let query = statement.binds.iter().cloned().fold(sqlx::query(&statement.sql), bind_value);
        let rows = query.execute(&mut **tx).await?.rows_affected();
        if statement.expect_one && rows != 1 {
            return Err(mismatch_error(index, rows));
        }
        affected += rows;
    }
    Ok(affected)
}

/// Rolls back after a failure. If that fails too the connection is gone and the server rolls
/// back on its own, so the original error is what the caller needs.
async fn roll_back(tx: Transaction<'_, MySql>) {
    if let Err(err) = tx.rollback().await {
        eprintln!("rollback after a failed apply did not complete: {}", describe_sqlx_error(&err));
    }
}

/// A failed apply on a table whose engine can't roll back: says so instead of "rolled back".
fn not_rolled_back(err: OpError, engine: &str) -> OpError {
    let message = err.into_app_error().to_string();
    let message = message.replace("; all changes were rolled back", "");
    AppError::Query(format!(
        "{message}. The table uses the {engine} engine, which can't roll back, so changes before \
         this one may already be applied; the deleted rows are kept in the trash, marked \
         uncertain."
    ))
    .into()
}

/// What happened to the transaction the trash entry `id` was written for.
pub(super) enum Outcome {
    Committed,
    RolledBack,
    Unknown,
}

/// Finishes the entry of a backed-up apply. Failures are only logged: the database outcome is
/// already final, and an entry left `pending` becomes `uncertain` on the next start.
pub(super) async fn settle_entry(
    store: Option<&Arc<TrashStore>>,
    id: Option<String>,
    outcome: Outcome,
) {
    let (Some(store), Some(id)) = (store, id) else { return };
    let store = Arc::clone(store);
    let action = match outcome {
        Outcome::Committed => "mark as committed",
        Outcome::RolledBack => "discard",
        Outcome::Unknown => "mark as uncertain",
    };
    let id_for_log = id.clone();
    let done = run_blocking(move || match outcome {
        Outcome::Committed => store.commit(&id),
        Outcome::RolledBack => store.discard(&id),
        Outcome::Unknown => store.mark_uncertain(&id),
    })
    .await;
    if let Err(err) = done {
        eprintln!("could not {action} trash entry {id_for_log}: {err}");
    }
}

/// Runs `statements` in one transaction. With a `backup`, the rows it deletes are read and
/// saved to the trash as `pending` inside the same transaction before anything changes; the
/// entry is then committed, discarded (rolled back) or marked uncertain (COMMIT outcome
/// unknown). A connection error before COMMIT is retried by the session, so the discarded
/// entry never leaves a duplicate.
async fn execute_all(
    conn: &mut MySqlConnection,
    statements: &[BuiltStatement],
    backup: Option<BackupPlan>,
) -> Result<u64, OpError> {
    let mut tx = conn.begin().await?;
    let store = backup.as_ref().map(|plan| Arc::clone(&plan.target.store));
    let (id, non_transactional) = match backup {
        None => (None, None),
        Some(plan) => match backup::save(&mut tx, plan).await {
            Ok(saved) => (Some(saved.id), saved.non_transactional),
            Err(err) => {
                roll_back(tx).await;
                return Err(err);
            }
        },
    };
    let affected = match run_statements(&mut tx, statements).await {
        Ok(affected) => affected,
        Err(err) => {
            roll_back(tx).await;
            if let Some(engine) = non_transactional {
                // Rows deleted before the failure stay deleted: keep their backup.
                settle_entry(store.as_ref(), id, Outcome::Unknown).await;
                return Err(not_rolled_back(err, &engine));
            }
            settle_entry(store.as_ref(), id, Outcome::RolledBack).await;
            return Err(err);
        }
    };
    match tx.commit().await {
        Ok(()) => {
            settle_entry(store.as_ref(), id, Outcome::Committed).await;
            Ok(affected)
        }
        Err(err) if is_connection_error(&err) => {
            settle_entry(store.as_ref(), id, Outcome::Unknown).await;
            // Never retry a commit whose outcome is unknown.
            Err(OpError::App(AppError::Connection(format!(
                "the connection was lost during COMMIT; the changes may or may not be applied: {}",
                describe_sqlx_error(&err)
            ))))
        }
        Err(err) => {
            settle_entry(store.as_ref(), id, Outcome::RolledBack).await;
            Err(OpError::Sql(err))
        }
    }
}

fn build_all(
    database: &str,
    definition: &SchemaTable,
    changes: &[RowChange],
) -> AppResult<Vec<BuiltStatement>> {
    changes.iter().map(|c| build_statement(database, definition, c)).collect()
}

/// The statements of an apply as text, and a warning when they may not show the values the
/// way the server will read them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePreview {
    pub statements: Vec<String>,
    pub warning: Option<String>,
}

/// One apply on `conn`: resolve the table, build the statements, then run them (with the
/// backup when `trash` is given) in one transaction.
///
/// The backup `SELECT`s run before every statement of the batch, so each delete is assumed to
/// target a row as it was before the batch. The grid guarantees that: `buildRowChanges` in
/// `src/lib/gridEdits.ts` puts deletes first and never updates a row it deletes.
async fn apply_on(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    changes: &[RowChange],
    trash: Option<TrashTarget>,
) -> Result<u64, OpError> {
    let (database, definition) = load_table(conn, database, table).await?;
    let statements = build_all(&database, &definition, changes)?;
    let plan = match trash {
        Some(target) => BackupPlan::new(target, &database, &definition, changes)?,
        None => None,
    };
    execute_all(conn, &statements, plan).await
}

/// [`apply_changes`] on one given connection, without the session's retry. For callers (and
/// tests) that need the session state of a specific connection. Returns the affected rows.
pub async fn apply_changes_on_connection(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    changes: &[RowChange],
    trash: Option<&TrashTarget>,
) -> AppResult<u64> {
    if changes.is_empty() {
        return Ok(0);
    }
    if trash.is_some() {
        backup::check_delete_count(changes)?;
    }
    apply_on(conn, database, table, changes, trash.cloned()).await.map_err(OpError::into_app_error)
}

/// Applies `changes` in one transaction. With `trash`, the rows deleted are saved there first
/// (`backup_failed` when that is not possible, and nothing changes); `None` skips the backup.
/// See [`apply_on`] for the order the backup assumes.
pub async fn apply_changes(
    session: &MysqlSession,
    database: &str,
    table: &str,
    changes: &[RowChange],
    trash: Option<&TrashTarget>,
) -> AppResult<ApplyChangesResult> {
    let start = Instant::now();
    if changes.is_empty() {
        return Ok(ApplyChangesResult { affected_rows: 0, elapsed_ms: elapsed_ms(start) });
    }
    if trash.is_some() {
        backup::check_delete_count(changes)?;
    }
    let (affected, _) = session
        .run(|mut conn| {
            let (database, table, changes) =
                (database.to_string(), table.to_string(), changes.to_vec());
            let trash = trash.cloned();
            boxed(async move { apply_on(&mut conn, &database, &table, &changes, trash).await })
        })
        .await?;
    Ok(ApplyChangesResult { affected_rows: affected, elapsed_ms: elapsed_ms(start) })
}

async fn preview_on(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    changes: &[RowChange],
) -> Result<ChangePreview, OpError> {
    let (database, definition) = load_table(conn, database, table).await?;
    let statements = build_all(&database, &definition, changes)?;
    let syntax = backup::session_syntax(conn).await?;
    if let Some(charset) = syntax.unsafe_charset {
        // Literals could be misread in this character set, so no runnable text is returned.
        return Ok(ChangePreview {
            statements: Vec::new(),
            warning: Some(format!(
                "The connection character set is {charset}, in which the statements can't be \
                 shown safely as SQL text. The changes themselves are sent as bound values."
            )),
        });
    }
    let statements = statements
        .iter()
        .map(|s| s.inline(syntax.backslash_escapes))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(ChangePreview { statements, warning: None })
}

/// [`preview_changes`] on one given connection, without the session's retry.
pub async fn preview_changes_on_connection(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    changes: &[RowChange],
) -> AppResult<ChangePreview> {
    preview_on(conn, database, table, changes).await.map_err(OpError::into_app_error)
}

/// The statements [`apply_changes`] would run for `changes`, with the values written as
/// literals for the session's `sql_mode`. Only the table definition, `sql_mode` and the
/// session character sets are read. In a character set where literals are not safe (see
/// `literal::is_literal_safe_charset`) the preview carries a warning.
pub async fn preview_changes(
    session: &MysqlSession,
    database: &str,
    table: &str,
    changes: &[RowChange],
) -> AppResult<ChangePreview> {
    if changes.is_empty() {
        return Ok(ChangePreview { statements: Vec::new(), warning: None });
    }
    let (preview, _) = session
        .run(|mut conn| {
            let (database, table, changes) =
                (database.to_string(), table.to_string(), changes.to_vec());
            boxed(async move { preview_on(&mut conn, &database, &table, &changes).await })
        })
        .await?;
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mysql::model::SchemaColumn;

    fn table() -> SchemaTable {
        let column = |name: &str| SchemaColumn {
            name: name.into(),
            type_name: "int".into(),
            nullable: false,
            is_primary: name == "id",
            is_auto_increment: false,
            default_value: None,
            comment: String::new(),
        };
        SchemaTable {
            name: "cus`t".into(),
            kind: TableKind::Table,
            columns: vec![column("id"), column("name")],
        }
    }

    fn cells(pairs: &[(&str, Cell)]) -> BTreeMap<String, Cell> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn builds_update_with_quoted_identifiers_and_bound_values() {
        let change = RowChange::Update {
            key: cells(&[("id", Cell::Int("1".into()))]),
            set: cells(&[("name", Cell::Str("x'y".into()))]),
        };
        let built = build_statement("sam`ple", &table(), &change).unwrap();
        assert_eq!(built.sql, "UPDATE `sam``ple`.`cus``t` SET `name` = ? WHERE `id` <=> ? LIMIT 2");
        assert_eq!(built.binds, vec![BindValue::Text("x'y".into()), BindValue::Signed(1)]);
        assert!(built.expect_one);
    }

    #[test]
    fn builds_delete_and_insert() {
        let delete = RowChange::Delete { key: cells(&[("id", Cell::Int("2".into()))]) };
        assert_eq!(
            build_statement("db", &table(), &delete).unwrap().sql,
            "DELETE FROM `db`.`cus``t` WHERE `id` <=> ? LIMIT 2"
        );
        let insert = RowChange::Insert {
            values: cells(&[("id", Cell::Null), ("name", Cell::Str("n".into()))]),
        };
        let built = build_statement("db", &table(), &insert).unwrap();
        assert_eq!(built.sql, "INSERT INTO `db`.`cus``t` (`id`, `name`) VALUES (?, ?)");
        assert!(!built.expect_one);
        let empty = RowChange::Insert { values: BTreeMap::new() };
        assert_eq!(
            build_statement("db", &table(), &empty).unwrap().sql,
            "INSERT INTO `db`.`cus``t` () VALUES ()"
        );
    }

    #[test]
    fn placeholders_point_at_each_bind_even_in_odd_identifiers() {
        let mut odd = table();
        odd.columns[1].name = "wh?at`'".into();
        let update = RowChange::Update {
            key: cells(&[("id", Cell::Int("1".into()))]),
            set: cells(&[("wh?at`'", Cell::Str("a?b'c\\".into()))]),
        };
        let built = build_statement("d?b", &odd, &update).unwrap();
        assert_eq!(built.placeholders.len(), built.binds.len());
        for &at in &built.placeholders {
            assert_eq!(&built.sql[at..at + 1], "?");
        }
        assert_eq!(
            built.inline(true).unwrap(),
            "UPDATE `d?b`.`cus``t` SET `wh?at``'` = 'a?b''c\\\\' WHERE `id` <=> 1 LIMIT 2"
        );
        assert_eq!(
            built.inline(false).unwrap(),
            "UPDATE `d?b`.`cus``t` SET `wh?at``'` = 'a?b''c\\' WHERE `id` <=> 1 LIMIT 2"
        );
        let insert = RowChange::Insert {
            values: cells(&[
                ("id", Cell::Int("7".into())),
                ("wh?at`'", Cell::Bytes("AP8=".into())),
            ]),
        };
        assert_eq!(
            build_statement("db", &odd, &insert).unwrap().inline(true).unwrap(),
            "INSERT INTO `db`.`cus``t` (`id`, `wh?at``'`) VALUES (7, X'00ff')"
        );
        let delete = RowChange::Delete {
            key: cells(&[("id", Cell::Null), ("wh?at`'", Cell::Decimal("1.50".into()))]),
        };
        assert_eq!(
            build_statement("db", &odd, &delete).unwrap().inline(true).unwrap(),
            "DELETE FROM `db`.`cus``t` WHERE `id` <=> NULL AND `wh?at``'` <=> '1.50' LIMIT 2"
        );
    }

    #[test]
    fn backup_select_matches_the_delete() {
        let key = cells(&[("ID", Cell::Int("2".into()))]);
        let select = build_backup_select("db", &table(), &key).unwrap();
        assert_eq!(
            select.sql,
            "SELECT `id`, `name` FROM `db`.`cus``t` WHERE `id` <=> ? LIMIT 2 FOR UPDATE"
        );
        let delete =
            build_statement("db", &table(), &RowChange::Delete { key: key.clone() }).unwrap();
        assert_eq!(select.binds, delete.binds);
        assert_eq!(
            select.inline(true).unwrap(),
            "SELECT `id`, `name` FROM `db`.`cus``t` WHERE `id` <=> 2 LIMIT 2 FOR UPDATE"
        );
        assert_eq!(
            build_backup_select("db", &table(), &BTreeMap::new()).unwrap_err().kind(),
            "invalid_input"
        );
    }

    #[test]
    fn mismatch_errors_name_the_change() {
        let message = |rows| match mismatch_error(2, rows) {
            OpError::App(err) => (err.kind(), err.to_string()),
            OpError::Sql(err) => panic!("unexpected {err}"),
        };
        assert_eq!(
            message(0),
            (
                "query",
                "change 3 matched 0 rows instead of exactly 1; all changes were rolled back".into()
            )
        );
        assert!(message(2).1.contains("more than 1"));
    }

    fn missing() -> String {
        "missing".into()
    }

    #[test]
    fn resolves_an_exact_name_before_a_case_folded_one() {
        let live = ["Users", "users"];
        assert_eq!(resolve_name(live.iter().copied(), "users", missing).unwrap(), "users");
        assert_eq!(resolve_name(live.iter().copied(), "Users", missing).unwrap(), "Users");
    }

    #[test]
    fn accepts_a_unique_case_folded_name() {
        let live = ["Users", "orders"];
        assert_eq!(resolve_name(live.iter().copied(), "users", missing).unwrap(), "Users");
        assert_eq!(resolve_name(live.iter().copied(), "ORDERS", missing).unwrap(), "orders");
    }

    #[test]
    fn rejects_ambiguous_and_unknown_names() {
        let live = ["Users", "USERS"];
        let ambiguous = resolve_name(live.iter().copied(), "users", missing).unwrap_err();
        assert_eq!(ambiguous.kind(), "invalid_input");
        let unknown = resolve_name(live.iter().copied(), "orders", missing).unwrap_err();
        assert_eq!(unknown.kind(), "invalid_input");
        assert!(unknown.to_string().contains("missing"));
    }

    #[test]
    fn columns_use_the_live_spelling_and_cannot_repeat() {
        let change = RowChange::Update {
            key: cells(&[("ID", Cell::Int("1".into()))]),
            set: cells(&[("Name", Cell::Str("x".into()))]),
        };
        let built = build_statement("db", &table(), &change).unwrap();
        assert_eq!(built.sql, "UPDATE `db`.`cus``t` SET `name` = ? WHERE `id` <=> ? LIMIT 2");
        let twice =
            RowChange::Insert { values: cells(&[("name", Cell::Null), ("NAME", Cell::Null)]) };
        assert_eq!(build_statement("db", &table(), &twice).unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn rejects_unknown_columns_and_empty_keys() {
        let unknown = RowChange::Delete { key: cells(&[("nope", Cell::Null)]) };
        assert_eq!(build_statement("db", &table(), &unknown).unwrap_err().kind(), "invalid_input");
        let no_key = RowChange::Delete { key: BTreeMap::new() };
        assert_eq!(build_statement("db", &table(), &no_key).unwrap_err().kind(), "invalid_input");
        let no_set = RowChange::Update { key: cells(&[("id", Cell::Null)]), set: BTreeMap::new() };
        assert_eq!(build_statement("db", &table(), &no_set).unwrap_err().kind(), "invalid_input");
    }
}
