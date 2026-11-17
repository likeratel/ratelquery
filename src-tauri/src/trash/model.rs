//! Shapes of the trash entries shared with the frontend.

use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::mysql::Cell;

/// Most rows one entry keeps; a larger delete is refused (`backup_failed`) instead.
pub const MAX_BACKUP_ROWS: usize = 10_000;
/// Largest encoded entry (its file size); a larger delete is refused (`backup_failed`).
pub const MAX_BACKUP_BYTES: usize = 50 * 1024 * 1024;

/// `pending`: written before the delete ran, its transaction not finished yet.
/// `committed`: the delete was committed. `uncertain`: the connection dropped during COMMIT, or
/// the app stopped while the entry was pending, so the rows may or may not still exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashStatus {
    Pending,
    Committed,
    Uncertain,
}

/// Where the delete came from: grid edits, or a DELETE statement run from the editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashSource {
    Grid,
    Sql,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashColumn {
    pub name: String,
    pub type_name: String,
}

/// The rows one delete removed, with the table they came from. `rows` follow `columns`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// Lower-case hyphenated UUID v4; also the file name.
    pub id: String,
    pub status: TrashStatus,
    /// UTC RFC 3339 with milliseconds, e.g. `2026-01-02T03:04:05.678Z`.
    pub deleted_at: String,
    pub connection_id: String,
    /// The connection's name when the rows were deleted.
    pub connection_name: String,
    pub database: String,
    pub table: String,
    pub source: TrashSource,
    /// The statement that deleted the rows, for `sql` entries.
    pub statement: Option<String>,
    pub columns: Vec<TrashColumn>,
    /// Primary key column names, in table order.
    pub primary_key: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

/// A [`TrashEntry`] without its rows, for listing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashSummary {
    pub id: String,
    pub status: TrashStatus,
    pub deleted_at: String,
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub table: String,
    pub source: TrashSource,
    pub statement: Option<String>,
    pub columns: Vec<TrashColumn>,
    pub primary_key: Vec<String>,
    pub row_count: usize,
}

/// Characters of the statement a summary shows; `get` has all of it.
pub const SUMMARY_STATEMENT_CHARS: usize = 200;

fn preview(statement: Option<String>) -> Option<String> {
    statement.map(|text| match text.char_indices().nth(SUMMARY_STATEMENT_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    })
}

/// What `list` reads from a file: the rows are counted, not decoded.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SummaryFile {
    id: String,
    status: TrashStatus,
    deleted_at: String,
    connection_id: String,
    connection_name: String,
    database: String,
    table: String,
    source: TrashSource,
    statement: Option<String>,
    columns: Vec<TrashColumn>,
    primary_key: Vec<String>,
    rows: Vec<IgnoredAny>,
}

impl SummaryFile {
    pub(super) fn into_summary(self) -> TrashSummary {
        TrashSummary {
            id: self.id,
            status: self.status,
            deleted_at: self.deleted_at,
            connection_id: self.connection_id,
            connection_name: self.connection_name,
            database: self.database,
            table: self.table,
            source: self.source,
            statement: preview(self.statement),
            columns: self.columns,
            primary_key: self.primary_key,
            row_count: self.rows.len(),
        }
    }
}

/// A new entry id.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().hyphenated().to_string()
}

/// Accepts only the lower-case hyphenated UUID form ids are created in, so an id from IPC can
/// never name a path outside the trash directory.
pub fn check_id(id: &str) -> AppResult<()> {
    match uuid::Uuid::parse_str(id) {
        Ok(parsed) if parsed.hyphenated().to_string() == id => Ok(()),
        _ => Err(AppError::InvalidInput(format!("{id:?} is not a trash entry id"))),
    }
}

/// The current time as stored in `deletedAt`.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_must_be_canonical_uuids() {
        let id = new_id();
        assert!(check_id(&id).is_ok());
        for bad in [
            "",
            "../settings",
            "../../etc/passwd",
            "a/b",
            &id.to_uppercase(),
            &id.replace('-', ""),
            &format!("{{{id}}}"),
            &format!("urn:uuid:{id}"),
            &format!("{id}.json"),
            &format!("{id}/.."),
        ] {
            assert_eq!(check_id(bad).unwrap_err().kind(), "invalid_input", "{bad}");
        }
    }

    #[test]
    fn serializes_camel_case_with_lowercase_enums() {
        let entry = TrashEntry {
            id: "i".into(),
            status: TrashStatus::Uncertain,
            deleted_at: "2026-01-02T03:04:05.678Z".into(),
            connection_id: "c".into(),
            connection_name: "n".into(),
            database: "d".into(),
            table: "t".into(),
            source: TrashSource::Grid,
            statement: None,
            columns: vec![TrashColumn { name: "id".into(), type_name: "INT".into() }],
            primary_key: vec!["id".into()],
            rows: vec![vec![Cell::Int("1".into())]],
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["status"], json!("uncertain"));
        assert_eq!(value["source"], json!("grid"));
        assert_eq!(value["deletedAt"], json!("2026-01-02T03:04:05.678Z"));
        assert_eq!(value["statement"], json!(null));
        assert_eq!(value["columns"][0]["typeName"], json!("INT"));
        assert_eq!(value["primaryKey"], json!(["id"]));
        assert_eq!(value["rows"], json!([[{ "t": "int", "v": "1" }]]));
        let back: TrashEntry = serde_json::from_value(value).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn summaries_show_a_short_statement() {
        assert_eq!(preview(Some("DELETE FROM t".into())).as_deref(), Some("DELETE FROM t"));
        let long = "가".repeat(SUMMARY_STATEMENT_CHARS + 5);
        let shown = preview(Some(long)).unwrap();
        assert_eq!(shown.chars().count(), SUMMARY_STATEMENT_CHARS + 1);
        assert!(shown.ends_with('…'));
        assert_eq!(preview(None), None);
    }

    #[test]
    fn now_is_utc_rfc3339_with_millis() {
        let now = now_rfc3339();
        assert!(now.ends_with('Z'), "{now}");
        assert!(chrono::DateTime::parse_from_rfc3339(&now).is_ok());
        assert_eq!(now.len(), "2026-01-02T03:04:05.678Z".len());
    }
}
