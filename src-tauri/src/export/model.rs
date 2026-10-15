use serde::{Deserialize, Serialize};

pub const DEFAULT_TABLE_NAME: &str = "export";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub format: ExportFormat,
    pub path: String,
    #[serde(default)]
    pub table_name: Option<String>,
    #[serde(default)]
    pub include_header: Option<bool>,
    /// `mysql_export` only: schema to run the statement in; defaults to the session database.
    #[serde(default)]
    pub database: Option<String>,
}

impl ExportOptions {
    pub fn table_name(&self) -> &str {
        self.table_name.as_deref().filter(|t| !t.trim().is_empty()).unwrap_or(DEFAULT_TABLE_NAME)
    }

    pub fn database(&self) -> Option<&str> {
        self.database.as_deref().filter(|d| !d.trim().is_empty())
    }

    pub fn include_header(&self) -> bool {
        self.include_header.unwrap_or(true)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub rows: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
}
