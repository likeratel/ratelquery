//! `mysql_databases` and `mysql_schema` from `information_schema`.

use std::collections::{HashMap, HashSet};

use sqlx::Row;
use sqlx::mysql::{MySqlConnection, MySqlRow};

use super::errors::OpError;
use super::model::{SchemaColumn, SchemaSnapshot, SchemaTable, TableKind};
use crate::error::AppError;

const SYSTEM_DATABASES: [&str; 4] = ["information_schema", "performance_schema", "mysql", "sys"];

const DATABASES_SQL: &str =
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME";
const SCHEMA_EXISTS_SQL: &str =
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?";
const TABLES_SQL: &str = "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME";
const COLUMNS_SQL: &str = "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA, \
     COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? \
     ORDER BY TABLE_NAME, ORDINAL_POSITION";
const PRIMARY_SQL: &str = "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS \
     WHERE TABLE_SCHEMA = ? AND INDEX_NAME = 'PRIMARY'";

pub struct TableRow {
    pub name: String,
    pub table_type: String,
}

pub struct ColumnRow {
    pub table: String,
    pub name: String,
    pub column_type: String,
    pub is_nullable: String,
    pub extra: String,
    pub default_value: Option<String>,
}

fn text(row: &MySqlRow, index: usize) -> Result<String, sqlx::Error> {
    Ok(opt_text(row, index)?.unwrap_or_default())
}

fn opt_text(row: &MySqlRow, index: usize) -> Result<Option<String>, sqlx::Error> {
    // information_schema mixes VARCHAR, TEXT and binary-collated columns; read raw text.
    row.try_get_unchecked::<Option<String>, _>(index)
}

pub fn is_system_database(name: &str) -> bool {
    SYSTEM_DATABASES.iter().any(|s| s.eq_ignore_ascii_case(name))
}

pub async fn list_databases(conn: &mut MySqlConnection) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query(DATABASES_SQL).fetch_all(&mut *conn).await?;
    let names: Result<Vec<String>, sqlx::Error> = rows.iter().map(|r| text(r, 0)).collect();
    Ok(names?.into_iter().filter(|n| !is_system_database(n)).collect())
}

fn table_kind(table_type: &str) -> TableKind {
    if table_type.to_ascii_uppercase().contains("VIEW") {
        TableKind::View
    } else {
        TableKind::Table
    }
}

/// Groups raw information_schema rows into a snapshot. Pure so it can be unit tested.
pub fn assemble_snapshot(
    database: &str,
    tables: Vec<TableRow>,
    columns: Vec<ColumnRow>,
    primary: &HashSet<(String, String)>,
    fetched_at: String,
) -> SchemaSnapshot {
    let mut by_table: HashMap<String, Vec<SchemaColumn>> = HashMap::new();
    for c in columns {
        let column = SchemaColumn {
            is_primary: primary.contains(&(c.table.clone(), c.name.clone())),
            is_auto_increment: c.extra.to_ascii_lowercase().contains("auto_increment"),
            nullable: c.is_nullable.eq_ignore_ascii_case("YES"),
            name: c.name,
            type_name: c.column_type,
            default_value: c.default_value,
        };
        by_table.entry(c.table).or_default().push(column);
    }
    let tables = tables
        .into_iter()
        .map(|t| SchemaTable {
            kind: table_kind(&t.table_type),
            columns: by_table.remove(&t.name).unwrap_or_default(),
            name: t.name,
        })
        .collect();
    SchemaSnapshot { database: database.to_string(), tables, fetched_at }
}

async fn fetch_rows(
    conn: &mut MySqlConnection,
    sql: &str,
    database: &str,
) -> Result<Vec<MySqlRow>, sqlx::Error> {
    sqlx::query(sql).bind(database).fetch_all(&mut *conn).await
}

fn parse_columns(rows: &[MySqlRow]) -> Result<Vec<ColumnRow>, sqlx::Error> {
    rows.iter()
        .map(|r| {
            Ok(ColumnRow {
                table: text(r, 0)?,
                name: text(r, 1)?,
                column_type: text(r, 2)?,
                is_nullable: text(r, 3)?,
                extra: text(r, 4)?,
                default_value: opt_text(r, 5)?,
            })
        })
        .collect()
}

/// Reads the live schema of `database`; an unknown database is `not_found`.
pub async fn fetch_schema(
    conn: &mut MySqlConnection,
    database: &str,
) -> Result<SchemaSnapshot, OpError> {
    if fetch_rows(conn, SCHEMA_EXISTS_SQL, database).await?.is_empty() {
        return Err(AppError::NotFound(format!("database {database} does not exist")).into());
    }
    let tables = fetch_rows(conn, TABLES_SQL, database)
        .await?
        .iter()
        .map(|r| Ok(TableRow { name: text(r, 0)?, table_type: text(r, 1)? }))
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let columns = parse_columns(&fetch_rows(conn, COLUMNS_SQL, database).await?)?;
    let primary = fetch_rows(conn, PRIMARY_SQL, database)
        .await?
        .iter()
        .map(|r| Ok((text(r, 0)?, text(r, 1)?)))
        .collect::<Result<HashSet<_>, sqlx::Error>>()?;
    let fetched_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok(assemble_snapshot(database, tables, columns, &primary, fetched_at))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(table: &str, name: &str, extra: &str) -> ColumnRow {
        ColumnRow {
            table: table.into(),
            name: name.into(),
            column_type: "int unsigned".into(),
            is_nullable: "NO".into(),
            extra: extra.into(),
            default_value: None,
        }
    }

    #[test]
    fn assembles_tables_with_primary_and_auto_increment() {
        let tables = vec![
            TableRow { name: "customers".into(), table_type: "BASE TABLE".into() },
            TableRow { name: "v".into(), table_type: "VIEW".into() },
        ];
        let columns =
            vec![column("customers", "id", "auto_increment"), column("customers", "email", "")];
        let primary = HashSet::from([("customers".to_string(), "id".to_string())]);
        let snap = assemble_snapshot("sample", tables, columns, &primary, "t".into());
        assert_eq!(snap.tables.len(), 2);
        let customers = &snap.tables[0];
        assert_eq!(customers.kind, TableKind::Table);
        assert!(customers.columns[0].is_primary && customers.columns[0].is_auto_increment);
        assert!(!customers.columns[1].is_primary);
        assert_eq!(snap.tables[1].kind, TableKind::View);
        assert!(snap.tables[1].columns.is_empty());
    }

    #[test]
    fn filters_system_databases() {
        assert!(is_system_database("mysql"));
        assert!(is_system_database("INFORMATION_SCHEMA"));
        assert!(!is_system_database("sample"));
    }
}
