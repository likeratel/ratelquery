//! `mysql_apply_changes`: grid edits applied in one transaction.

use std::collections::BTreeMap;
use std::time::Instant;

use sqlx::Connection;
use sqlx::mysql::MySqlConnection;

use super::bind::{BindValue, bind_value, to_bind_value};
use super::cell::Cell;
use super::errors::{OpError, describe_sqlx_error, is_connection_error};
use super::model::{ApplyChangesResult, RowChange, SchemaTable, TableKind};
use super::options::quote_ident;
use super::schema::{all_databases, fetch_schema};
use super::session::{MysqlSession, boxed};
use crate::error::{AppError, AppResult};
use crate::util::elapsed_ms;

/// Guards against runaway updates: two rows are enough to detect a non-unique key.
const MATCH_LIMIT: u32 = 2;

#[derive(Debug, Clone, PartialEq)]
pub struct BuiltStatement {
    pub sql: String,
    pub binds: Vec<BindValue>,
    pub expect_one: bool,
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

fn where_clause(key: &BTreeMap<String, Cell>) -> AppResult<String> {
    if key.is_empty() {
        return Err(AppError::InvalidInput("a row key must not be empty".into()));
    }
    let parts: Vec<String> = key.keys().map(|k| format!("{} <=> ?", quote_ident(k))).collect();
    Ok(parts.join(" AND "))
}

/// Builds one statement after checking every column against the live table definition.
pub fn build_statement(
    database: &str,
    table: &SchemaTable,
    change: &RowChange,
) -> AppResult<BuiltStatement> {
    let target = format!("{}.{}", quote_ident(database), quote_ident(&table.name));
    match change {
        RowChange::Update { key, set } => {
            if set.is_empty() {
                return Err(AppError::InvalidInput(
                    "an update must set at least one column".into(),
                ));
            }
            let (key, set) = (&live_columns(table, key)?, &live_columns(table, set)?);
            let assignments: Vec<String> =
                set.keys().map(|c| format!("{} = ?", quote_ident(c))).collect();
            let sql = format!(
                "UPDATE {target} SET {} WHERE {} LIMIT {MATCH_LIMIT}",
                assignments.join(", "),
                where_clause(key)?
            );
            let all = binds(set)?.into_iter().chain(binds(key)?).collect();
            Ok(BuiltStatement { sql, binds: all, expect_one: true })
        }
        RowChange::Delete { key } => {
            let key = &live_columns(table, key)?;
            let sql =
                format!("DELETE FROM {target} WHERE {} LIMIT {MATCH_LIMIT}", where_clause(key)?);
            Ok(BuiltStatement { sql, binds: binds(key)?, expect_one: true })
        }
        RowChange::Insert { values } => {
            let values = &live_columns(table, values)?;
            let columns: Vec<String> = values.keys().map(|c| quote_ident(c)).collect();
            let marks = vec!["?"; values.len()].join(", ");
            let sql = format!("INSERT INTO {target} ({}) VALUES ({marks})", columns.join(", "));
            Ok(BuiltStatement { sql, binds: binds(values)?, expect_one: false })
        }
    }
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
/// table definition as the server spells them.
async fn load_table(
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
    if found.kind != TableKind::Table {
        return Err(
            AppError::InvalidInput(format!("{name} is a view; only tables can be edited")).into()
        );
    }
    Ok((database, found))
}

async fn execute_all(
    conn: &mut MySqlConnection,
    statements: &[BuiltStatement],
) -> Result<u64, OpError> {
    let mut tx = conn.begin().await?;
    let mut affected = 0;
    for (index, statement) in statements.iter().enumerate() {
        let query = statement.binds.iter().cloned().fold(sqlx::query(&statement.sql), bind_value);
        let rows = query.execute(&mut *tx).await?.rows_affected();
        if statement.expect_one && rows != 1 {
            tx.rollback().await?;
            return Err(AppError::Query(format!(
                "change {} matched {} rows instead of exactly 1; all changes were rolled back",
                index + 1,
                if rows >= u64::from(MATCH_LIMIT) {
                    "more than 1".to_string()
                } else {
                    rows.to_string()
                }
            ))
            .into());
        }
        affected += rows;
    }
    tx.commit().await.map_err(|err| {
        if is_connection_error(&err) {
            // Never retry a commit whose outcome is unknown.
            OpError::App(AppError::Connection(format!(
                "the connection was lost during COMMIT; the changes may or may not be applied: {}",
                describe_sqlx_error(&err)
            )))
        } else {
            OpError::Sql(err)
        }
    })?;
    Ok(affected)
}

pub async fn apply_changes(
    session: &MysqlSession,
    database: &str,
    table: &str,
    changes: &[RowChange],
) -> AppResult<ApplyChangesResult> {
    let start = Instant::now();
    if changes.is_empty() {
        return Ok(ApplyChangesResult { affected_rows: 0, elapsed_ms: elapsed_ms(start) });
    }
    let (affected, _) = session
        .run(|mut conn| {
            let (database, table, changes) =
                (database.to_string(), table.to_string(), changes.to_vec());
            boxed(async move {
                let (database, definition) = load_table(&mut conn, &database, &table).await?;
                let statements = changes
                    .iter()
                    .map(|c| build_statement(&database, &definition, c))
                    .collect::<AppResult<Vec<_>>>()?;
                execute_all(&mut conn, &statements).await
            })
        })
        .await?;
    Ok(ApplyChangesResult { affected_rows: affected, elapsed_ms: elapsed_ms(start) })
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
