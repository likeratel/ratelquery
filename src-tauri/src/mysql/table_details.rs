//! `mysql_table_details`: one table's metadata, indexes, foreign keys and DDL.

use sqlx::Row;
use sqlx::mysql::{MySqlConnection, MySqlRow};

use super::errors::OpError;
use super::model::{ForeignKeyInfo, IndexInfo, SchemaColumn, TableDetails, TableKind};
use super::options::quote_ident;
use super::schema::{opt_text, parse_columns, table_kind, text, to_schema_column};
use crate::error::AppError;

const PRIMARY_INDEX: &str = "PRIMARY";

const TABLE_SQL: &str = "SELECT TABLE_TYPE, ENGINE, CAST(TABLE_ROWS AS UNSIGNED), \
     CAST(DATA_LENGTH + INDEX_LENGTH AS UNSIGNED), TABLE_COLLATION, TABLE_COMMENT \
     FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";
const COLUMNS_SQL: &str = "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA, \
     COLUMN_DEFAULT, COLUMN_COMMENT FROM information_schema.COLUMNS \
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION";
const INDEXES_SQL: &str = "SELECT INDEX_NAME, CAST(NON_UNIQUE AS UNSIGNED), COLUMN_NAME, \
     INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
     ORDER BY INDEX_NAME <> 'PRIMARY', INDEX_NAME, SEQ_IN_INDEX";
const FOREIGN_KEYS_SQL: &str = "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, \
     k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE \
     FROM information_schema.KEY_COLUMN_USAGE k \
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
      AND r.TABLE_NAME = k.TABLE_NAME \
     WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
     ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION";

/// Raw `information_schema.STATISTICS` row (one per index column).
pub struct IndexRow {
    pub name: String,
    pub non_unique: bool,
    /// `None` for functional index parts, which have no column.
    pub column: Option<String>,
    pub index_type: String,
}

/// Raw `KEY_COLUMN_USAGE` + `REFERENTIAL_CONSTRAINTS` row (one per foreign key column).
pub struct ForeignKeyRow {
    pub name: String,
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: String,
    pub on_update: String,
    pub on_delete: String,
}

struct TableRow {
    kind: TableKind,
    engine: Option<String>,
    row_estimate: Option<u64>,
    data_length: Option<u64>,
    collation: Option<String>,
    comment: String,
}

/// Groups index rows (already ordered by index, then sequence) into indexes.
pub fn group_indexes(rows: Vec<IndexRow>) -> Vec<IndexInfo> {
    rows.into_iter().fold(Vec::new(), |mut acc: Vec<IndexInfo>, row| {
        let columns = row.column.into_iter().collect::<Vec<_>>();
        match acc.last_mut() {
            Some(last) if last.name == row.name => last.columns.extend(columns),
            _ => acc.push(IndexInfo {
                name: row.name,
                unique: !row.non_unique,
                columns,
                index_type: row.index_type,
            }),
        }
        acc
    })
}

/// Groups foreign key rows (already ordered by constraint, then position) into keys.
pub fn group_foreign_keys(rows: Vec<ForeignKeyRow>) -> Vec<ForeignKeyInfo> {
    rows.into_iter().fold(Vec::new(), |mut acc: Vec<ForeignKeyInfo>, row| {
        match acc.last_mut() {
            Some(last) if last.name == row.name => {
                last.columns.push(row.column);
                last.referenced_columns.push(row.referenced_column);
            }
            _ => acc.push(ForeignKeyInfo {
                name: row.name,
                columns: vec![row.column],
                referenced_table: row.referenced_table,
                referenced_columns: vec![row.referenced_column],
                on_update: row.on_update,
                on_delete: row.on_delete,
            }),
        }
        acc
    })
}

async fn fetch(
    conn: &mut MySqlConnection,
    sql: &str,
    database: &str,
    table: &str,
) -> Result<Vec<MySqlRow>, sqlx::Error> {
    sqlx::query(sql).bind(database).bind(table).fetch_all(&mut *conn).await
}

fn opt_u64(row: &MySqlRow, index: usize) -> Result<Option<u64>, sqlx::Error> {
    row.try_get_unchecked::<Option<u64>, _>(index)
}

fn parse_table(row: &MySqlRow) -> Result<TableRow, sqlx::Error> {
    let kind = table_kind(&text(row, 0)?);
    // Views report the literal comment "VIEW"; it is not a user comment.
    let comment = if kind == TableKind::View { String::new() } else { text(row, 5)? };
    Ok(TableRow {
        kind,
        engine: opt_text(row, 1)?,
        row_estimate: opt_u64(row, 2)?,
        data_length: opt_u64(row, 3)?,
        collation: opt_text(row, 4)?,
        comment,
    })
}

fn parse_indexes(rows: &[MySqlRow]) -> Result<Vec<IndexRow>, sqlx::Error> {
    rows.iter()
        .map(|r| {
            Ok(IndexRow {
                name: text(r, 0)?,
                non_unique: opt_u64(r, 1)?.unwrap_or(1) != 0,
                column: opt_text(r, 2)?,
                index_type: text(r, 3)?,
            })
        })
        .collect()
}

fn parse_foreign_keys(rows: &[MySqlRow]) -> Result<Vec<ForeignKeyRow>, sqlx::Error> {
    rows.iter()
        .map(|r| {
            Ok(ForeignKeyRow {
                name: text(r, 0)?,
                column: text(r, 1)?,
                referenced_table: text(r, 2)?,
                referenced_column: text(r, 3)?,
                on_update: text(r, 4)?,
                on_delete: text(r, 5)?,
            })
        })
        .collect()
}

async fn fetch_columns(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    indexes: &[IndexInfo],
) -> Result<Vec<SchemaColumn>, sqlx::Error> {
    let primary: Vec<&String> =
        indexes.iter().filter(|i| i.name == PRIMARY_INDEX).flat_map(|i| i.columns.iter()).collect();
    let rows = parse_columns(&fetch(conn, COLUMNS_SQL, database, table).await?)?;
    Ok(rows
        .into_iter()
        .map(|c| {
            let is_primary = primary.contains(&&c.name);
            to_schema_column(c, is_primary)
        })
        .collect())
}

/// `SHOW CREATE TABLE` / `SHOW CREATE VIEW`; the statement is the second result column.
async fn fetch_ddl(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    kind: TableKind,
) -> Result<String, OpError> {
    let keyword = if kind == TableKind::View { "VIEW" } else { "TABLE" };
    let sql = format!("SHOW CREATE {keyword} {}.{}", quote_ident(database), quote_ident(table));
    let row = sqlx::query(&sql)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("table {database}.{table} does not exist")))?;
    Ok(text(&row, 1)?)
}

/// Reads details of `database`.`table`; an unknown table is `not_found`.
pub async fn fetch_table_details(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<TableDetails, OpError> {
    let Some(row) = fetch(conn, TABLE_SQL, database, table).await?.into_iter().next() else {
        return Err(AppError::NotFound(format!("table {database}.{table} does not exist")).into());
    };
    let meta = parse_table(&row)?;
    let indexes = group_indexes(parse_indexes(&fetch(conn, INDEXES_SQL, database, table).await?)?);
    let foreign_keys = group_foreign_keys(parse_foreign_keys(
        &fetch(conn, FOREIGN_KEYS_SQL, database, table).await?,
    )?);
    let columns = fetch_columns(conn, database, table, &indexes).await?;
    let ddl = fetch_ddl(conn, database, table, meta.kind).await?;
    Ok(TableDetails {
        database: database.to_string(),
        table: table.to_string(),
        kind: meta.kind,
        engine: meta.engine,
        row_estimate: meta.row_estimate,
        data_length: meta.data_length,
        collation: meta.collation,
        comment: meta.comment,
        columns,
        indexes,
        foreign_keys,
        ddl,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(name: &str, non_unique: bool, column: Option<&str>) -> IndexRow {
        IndexRow {
            name: name.into(),
            non_unique,
            column: column.map(Into::into),
            index_type: "BTREE".into(),
        }
    }

    fn fk(name: &str, column: &str, referenced: &str) -> ForeignKeyRow {
        ForeignKeyRow {
            name: name.into(),
            column: column.into(),
            referenced_table: "parent".into(),
            referenced_column: referenced.into(),
            on_update: "CASCADE".into(),
            on_delete: "RESTRICT".into(),
        }
    }

    #[test]
    fn groups_index_columns_in_order() {
        let grouped = group_indexes(vec![
            index("PRIMARY", false, Some("id")),
            index("ix_ab", true, Some("a")),
            index("ix_ab", true, Some("b")),
            index("ix_fn", true, None),
        ]);
        assert_eq!(grouped.len(), 3);
        assert!(grouped[0].unique && grouped[0].columns == ["id"]);
        assert!(!grouped[1].unique && grouped[1].columns == ["a", "b"]);
        assert!(grouped[2].columns.is_empty());
    }

    #[test]
    fn groups_composite_foreign_keys() {
        let grouped =
            group_foreign_keys(vec![fk("fk1", "a", "x"), fk("fk1", "b", "y"), fk("fk2", "c", "z")]);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].columns, ["a", "b"]);
        assert_eq!(grouped[0].referenced_columns, ["x", "y"]);
        assert_eq!(
            (grouped[1].on_update.as_str(), grouped[1].on_delete.as_str()),
            ("CASCADE", "RESTRICT")
        );
    }
}
