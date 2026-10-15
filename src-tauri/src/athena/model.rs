//! IPC shapes of the Athena commands.

use serde::{Deserialize, Serialize};

use crate::mysql::RowsResult;

/// Catalog used when the query options name none.
pub const DEFAULT_CATALOG: &str = "AwsDataCatalog";

/// What `connections_test` found out about the workgroup and its output location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AthenaTestInfo {
    pub workgroup: String,
    pub output_location: Option<String>,
    /// Default bucket name that would have to be created.
    pub missing_bucket: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AthenaQueryOptions {
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub catalog: Option<String>,
    #[serde(default)]
    pub max_rows: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AthenaStarted {
    pub execution_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AthenaBucketCreated {
    pub output_location: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AthenaStats {
    pub execution_id: String,
    pub data_scanned_bytes: i64,
    pub engine_ms: Option<i64>,
    pub output_location: Option<String>,
}

/// A `RowsResult` (fields flattened) plus Athena statistics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AthenaRowsResult {
    #[serde(flatten)]
    pub rows: RowsResult,
    pub athena: AthenaStats,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mysql::{Cell, ColumnInfo};
    use serde_json::json;

    #[test]
    fn rows_result_is_flattened_with_athena_stats() {
        let result = AthenaRowsResult {
            rows: RowsResult {
                columns: vec![ColumnInfo {
                    name: "n".into(),
                    type_name: "BIGINT".into(),
                    table: None,
                    nullable: true,
                }],
                rows: vec![vec![Cell::Int("1".into())]],
                row_count: 1,
                truncated: false,
                elapsed_ms: 7,
                reconnected: false,
                statement: "SELECT 1 AS n".into(),
            },
            athena: AthenaStats {
                execution_id: "e-1".into(),
                data_scanned_bytes: 0,
                engine_ms: Some(12),
                output_location: Some("s3://b/e-1.csv".into()),
            },
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "columns": [{ "name": "n", "typeName": "BIGINT", "table": null, "nullable": true }],
                "rows": [[{ "t": "int", "v": "1" }]], "rowCount": 1, "truncated": false,
                "elapsedMs": 7, "reconnected": false, "statement": "SELECT 1 AS n",
                "athena": { "executionId": "e-1", "dataScannedBytes": 0, "engineMs": 12,
                            "outputLocation": "s3://b/e-1.csv" }
            })
        );
    }

    #[test]
    fn options_and_small_shapes_use_camel_case() {
        let options: AthenaQueryOptions =
            serde_json::from_value(json!({ "database": "sales", "catalog": "c", "maxRows": 5 }))
                .unwrap();
        assert_eq!(
            (options.database.as_deref(), options.catalog.as_deref(), options.max_rows),
            (Some("sales"), Some("c"), Some(5))
        );
        let empty: AthenaQueryOptions = serde_json::from_value(json!({})).unwrap();
        assert!(empty.database.is_none() && empty.catalog.is_none() && empty.max_rows.is_none());
        assert_eq!(
            serde_json::to_value(AthenaStarted { execution_id: "x".into() }).unwrap(),
            json!({ "executionId": "x" })
        );
        assert_eq!(
            serde_json::to_value(AthenaBucketCreated { output_location: "s3://b/".into() })
                .unwrap(),
            json!({ "outputLocation": "s3://b/" })
        );
        let info = AthenaTestInfo {
            workgroup: "primary".into(),
            output_location: Some("s3://b/".into()),
            missing_bucket: None,
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            json!({ "workgroup": "primary", "outputLocation": "s3://b/", "missingBucket": null })
        );
    }
}
