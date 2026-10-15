//! Workgroups, databases and table metadata (ListWorkGroups / ListDatabases /
//! ListTableMetadata) as the schema browser's `SchemaSnapshot`.

use aws_sdk_athena::Client;
use aws_sdk_athena::types::{Column, TableMetadata};

use super::errors::map_sdk_error;
use super::model::DEFAULT_CATALOG;
use super::registry::AthenaHandle;
use crate::connections::AwsAuth;
use crate::error::AppResult;
use crate::mysql::{SchemaColumn, SchemaSnapshot, SchemaTable, TableKind};

const VIEW_TABLE_TYPE: &str = "VIRTUAL_VIEW";

fn sorted(names: Vec<String>) -> Vec<String> {
    let mut names = names;
    names.sort();
    names
}

/// Every workgroup name, sorted.
pub async fn list_workgroups(client: &Client, auth: &AwsAuth) -> AppResult<Vec<String>> {
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let output = client
            .list_work_groups()
            .set_next_token(token.take())
            .send()
            .await
            .map_err(|e| map_sdk_error(&e, auth))?;
        names.extend(output.work_groups().iter().filter_map(|w| w.name()).map(str::to_string));
        match output.next_token() {
            Some(next) => token = Some(next.to_string()),
            None => return Ok(sorted(names)),
        }
    }
}

/// Every database of the default catalog, sorted.
pub async fn list_databases(handle: &AthenaHandle) -> AppResult<Vec<String>> {
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let output = handle
            .client()
            .list_databases()
            .catalog_name(DEFAULT_CATALOG)
            .set_next_token(token.take())
            .send()
            .await
            .map_err(|e| map_sdk_error(&e, handle.auth()))?;
        names.extend(output.database_list().iter().map(|d| d.name().to_string()));
        match output.next_token() {
            Some(next) => token = Some(next.to_string()),
            None => return Ok(sorted(names)),
        }
    }
}

fn schema_column(column: &Column) -> SchemaColumn {
    SchemaColumn {
        name: column.name().to_string(),
        type_name: column.r#type().unwrap_or_default().to_string(),
        nullable: true,
        is_primary: false,
        is_auto_increment: false,
        default_value: None,
        comment: column.comment().unwrap_or_default().to_string(),
    }
}

/// Table metadata -> schema table: columns followed by partition keys.
pub fn schema_table(table: &TableMetadata) -> SchemaTable {
    let kind = if table.table_type() == Some(VIEW_TABLE_TYPE) {
        TableKind::View
    } else {
        TableKind::Table
    };
    SchemaTable {
        name: table.name().to_string(),
        kind,
        columns: table.columns().iter().chain(table.partition_keys()).map(schema_column).collect(),
    }
}

pub fn snapshot(database: &str, tables: Vec<SchemaTable>, fetched_at: String) -> SchemaSnapshot {
    let mut tables = tables;
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    SchemaSnapshot { database: database.to_string(), tables, fetched_at }
}

/// Every table of `database` in the default catalog.
pub async fn schema(handle: &AthenaHandle, database: &str) -> AppResult<SchemaSnapshot> {
    let mut tables = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let output = handle
            .client()
            .list_table_metadata()
            .catalog_name(DEFAULT_CATALOG)
            .database_name(database)
            .set_next_token(token.take())
            .send()
            .await
            .map_err(|e| map_sdk_error(&e, handle.auth()))?;
        tables.extend(output.table_metadata_list().iter().map(schema_table));
        match output.next_token() {
            Some(next) => token = Some(next.to_string()),
            None => break,
        }
    }
    let fetched_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok(snapshot(database, tables, fetched_at))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, type_name: &str, comment: Option<&str>) -> Column {
        Column::builder()
            .name(name)
            .r#type(type_name)
            .set_comment(comment.map(str::to_string))
            .build()
            .unwrap()
    }

    #[test]
    fn maps_table_metadata_with_partition_keys_last() {
        let table = TableMetadata::builder()
            .name("events")
            .table_type("EXTERNAL_TABLE")
            .columns(column("id", "bigint", Some("primary id")))
            .columns(column("tags", "array<string>", None))
            .partition_keys(column("dt", "string", None))
            .build()
            .unwrap();
        let mapped = schema_table(&table);
        assert_eq!(mapped.kind, TableKind::Table);
        let names: Vec<_> = mapped.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["id", "tags", "dt"]);
        let id = &mapped.columns[0];
        assert_eq!((id.type_name.as_str(), id.comment.as_str()), ("bigint", "primary id"));
        assert!(
            id.nullable && !id.is_primary && !id.is_auto_increment && id.default_value.is_none()
        );
        assert_eq!(mapped.columns[1].type_name, "array<string>");
        assert_eq!(mapped.columns[1].comment, "");
    }

    #[test]
    fn virtual_views_are_views() {
        let view = TableMetadata::builder().name("v").table_type("VIRTUAL_VIEW").build().unwrap();
        assert_eq!(schema_table(&view).kind, TableKind::View);
        let untyped = TableMetadata::builder().name("t").build().unwrap();
        assert_eq!(schema_table(&untyped).kind, TableKind::Table);
    }

    #[test]
    fn snapshot_sorts_tables() {
        let table =
            |name: &str| SchemaTable { name: name.into(), kind: TableKind::Table, columns: vec![] };
        let snap = snapshot("db", vec![table("b"), table("a")], "now".into());
        let names: Vec<_> = snap.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!((snap.database.as_str(), names), ("db", vec!["a", "b"]));
        assert_eq!(sorted(vec!["z".into(), "a".into()]), ["a", "z"]);
    }
}
