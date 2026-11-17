use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::cell::Cell;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlSessionInfo {
    pub server_version: String,
    pub current_database: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlStateEvent {
    pub connection_id: String,
    pub state: SessionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    pub table: Option<String>,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Cell>>,
    pub row_count: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub reconnected: bool,
    pub statement: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub affected_rows: u64,
    pub last_insert_id: Option<String>,
    pub elapsed_ms: u64,
    pub reconnected: bool,
    pub statement: String,
    /// For a DELETE backed up to the trash: how many rows the entry holds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trashed_rows: Option<u64>,
    /// For a DELETE backed up to the trash: the entry id (absent when it deleted no rows).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trash_id: Option<String>,
}

/// The run stopped before statement `statement_index` (of the whole script) because its rows
/// could not be backed up; it and later statements did not run. Always the last result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStoppedResult {
    pub statement_index: usize,
    pub reason: String,
    pub statement: String,
    /// Always 0; present so every result has the field.
    pub elapsed_ms: u64,
    /// Continues the script on the same connection (`QueryOptions::resume_token`) for
    /// `RESUME_TIMEOUT`; `None` when the session is closing.
    pub resume_token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum QueryResult {
    Rows(RowsResult),
    Exec(ExecResult),
    #[serde(rename = "backup_stopped")]
    BackupStopped(BackupStoppedResult),
}

impl QueryResult {
    pub fn reconnected(&self) -> bool {
        match self {
            QueryResult::Rows(r) => r.reconnected,
            QueryResult::Exec(r) => r.reconnected,
            QueryResult::BackupStopped(_) => false,
        }
    }

    /// Returns a copy with the `reconnected` flag replaced.
    pub fn with_reconnected(self, reconnected: bool) -> QueryResult {
        match self {
            QueryResult::Rows(r) => QueryResult::Rows(RowsResult { reconnected, ..r }),
            QueryResult::Exec(r) => QueryResult::Exec(ExecResult { reconnected, ..r }),
            stopped @ QueryResult::BackupStopped(_) => stopped,
        }
    }
}

pub const DEFAULT_MAX_ROWS: usize = 1000;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOptions {
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub max_rows: Option<i64>,
    /// Run from this statement of the script (0-based, `split_statements` order); earlier ones
    /// are skipped. Above 0 it needs `resume_token`. Default 0.
    #[serde(default)]
    pub start_at: Option<usize>,
    /// The `resumeToken` of a `backup_stopped` result: the run continues on the connection the
    /// stopped run used, with its session state.
    #[serde(default)]
    pub resume_token: Option<String>,
    /// How DELETE statements are backed up to the trash (when the caller backs up at all).
    #[serde(default)]
    pub delete_backup: Option<DeleteBackupOptions>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBackupOptions {
    /// Statement indexes (whole script) the user agreed to run without a backup.
    #[serde(default)]
    pub skip: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaColumn {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub is_primary: bool,
    pub is_auto_increment: bool,
    pub default_value: Option<String>,
    /// `COLUMN_COMMENT`; empty when the column has none.
    pub comment: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTable {
    pub name: String,
    pub kind: TableKind,
    pub columns: Vec<SchemaColumn>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    pub database: String,
    pub tables: Vec<SchemaTable>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RowChange {
    Update { key: BTreeMap<String, Cell>, set: BTreeMap<String, Cell> },
    Delete { key: BTreeMap<String, Cell> },
    Insert { values: BTreeMap<String, Cell> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangesResult {
    pub affected_rows: u64,
    pub elapsed_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn query_result_uses_kind_tag_and_camel_case() {
        let exec = QueryResult::Exec(ExecResult {
            affected_rows: 2,
            last_insert_id: Some("7".into()),
            elapsed_ms: 1,
            reconnected: false,
            statement: "DELETE".into(),
            trashed_rows: None,
            trash_id: None,
        });
        assert_eq!(
            serde_json::to_value(exec).unwrap(),
            json!({ "kind": "exec", "affectedRows": 2, "lastInsertId": "7", "elapsedMs": 1,
                    "reconnected": false, "statement": "DELETE" })
        );
        let rows = QueryResult::Rows(RowsResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            truncated: false,
            elapsed_ms: 0,
            reconnected: true,
            statement: "SELECT 1".into(),
        });
        let value = serde_json::to_value(rows).unwrap();
        assert_eq!(value["kind"], "rows");
        assert_eq!(value["rowCount"], 0);
    }

    #[test]
    fn row_change_parses_type_tag() {
        let change: RowChange = serde_json::from_value(json!({
            "type": "update", "key": { "id": { "t": "int", "v": "1" } },
            "set": { "name": { "t": "str", "v": "x" } }
        }))
        .unwrap();
        assert!(matches!(change, RowChange::Update { .. }));
    }

    #[test]
    fn state_event_omits_missing_message() {
        let event = MysqlStateEvent {
            connection_id: "a".into(),
            state: SessionState::Reconnecting,
            message: None,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "connectionId": "a", "state": "reconnecting" })
        );
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    /// In `SEQ_IN_INDEX` order.
    pub columns: Vec<String>,
    #[serde(rename = "type")]
    pub index_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub database: String,
    pub table: String,
    pub kind: TableKind,
    pub engine: Option<String>,
    pub row_estimate: Option<u64>,
    pub data_length: Option<u64>,
    pub collation: Option<String>,
    pub comment: String,
    pub columns: Vec<SchemaColumn>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub ddl: String,
}
