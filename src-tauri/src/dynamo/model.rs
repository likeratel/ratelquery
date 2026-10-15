//! IPC types for the DynamoDB commands (`docs/ipc-contract.md`, `src/lib/dynamo.ts`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::wire::WireItem;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeyType {
    S,
    N,
    B,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyAttribute {
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: KeyType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeySchema {
    pub hash: KeyAttribute,
    pub range: Option<KeyAttribute>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexKind {
    Gsi,
    Lsi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Projection {
    All,
    KeysOnly,
    Include,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDescription {
    pub name: String,
    pub kind: IndexKind,
    pub key_schema: KeySchema,
    pub projection: Projection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDescription {
    pub name: String,
    pub status: String,
    pub key_schema: KeySchema,
    pub indexes: Vec<IndexDescription>,
    pub item_count: Option<i64>,
    pub size_bytes: Option<i64>,
    pub billing_mode: Option<String>,
}

impl TableDescription {
    /// Key schema of the table (`index == None`) or of one of its indexes.
    pub fn key_schema_for(&self, index: Option<&str>) -> Option<&KeySchema> {
        match index {
            None => Some(&self.key_schema),
            Some(name) => self.indexes.iter().find(|i| i.name == name).map(|i| &i.key_schema),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RangeOp {
    Eq,
    Lt,
    Le,
    Gt,
    Ge,
    BeginsWith,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum RangeCondition {
    Between { op: BetweenOp, from: Value, to: Value },
    Compare { op: RangeOp, value: Value },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BetweenOp {
    Between,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub table: String,
    #[serde(default)]
    pub index: Option<String>,
    pub hash: Value,
    #[serde(default)]
    pub range: Option<RangeCondition>,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub names: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub values: Option<WireItem>,
    /// Kept wide so out-of-range values reach validation instead of failing deserialization.
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub start_key: Option<WireItem>,
    #[serde(default)]
    pub scan_forward: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    pub table: String,
    #[serde(default)]
    pub index: Option<String>,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub names: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub values: Option<WireItem>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub start_key: Option<WireItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<WireItem>,
    pub last_key: Option<WireItem>,
    pub count: i64,
    pub scanned_count: i64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PutExpectation {
    Exists,
    NotExists,
    Any,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DynamoExportRequest {
    Scan(ScanRequest),
    Query(QueryRequest),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DynamoExportFormat {
    Json,
    Jsonl,
    Csv,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamoExportOptions {
    pub format: DynamoExportFormat,
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deserializes_range_conditions() {
        let eq: RangeCondition =
            serde_json::from_value(json!({ "op": "begins_with", "value": { "S": "a" } })).unwrap();
        assert_eq!(
            eq,
            RangeCondition::Compare { op: RangeOp::BeginsWith, value: json!({ "S": "a" }) }
        );
        let between: RangeCondition = serde_json::from_value(
            json!({ "op": "between", "from": { "N": "1" }, "to": { "N": "2" } }),
        )
        .unwrap();
        assert!(matches!(between, RangeCondition::Between { .. }));
        assert!(
            serde_json::from_value::<RangeCondition>(json!({ "op": "between", "value": {} }))
                .is_err()
        );
        assert!(
            serde_json::from_value::<RangeCondition>(json!({ "op": "ne", "value": {} })).is_err()
        );
    }

    #[test]
    fn deserializes_export_request_and_serializes_description() {
        let request: DynamoExportRequest = serde_json::from_value(
            json!({ "query": { "table": "t", "hash": { "S": "a" }, "scanForward": false } }),
        )
        .unwrap();
        assert!(matches!(request, DynamoExportRequest::Query(q) if q.scan_forward == Some(false)));
        let description = TableDescription {
            name: "t".into(),
            status: "ACTIVE".into(),
            key_schema: KeySchema {
                hash: KeyAttribute { name: "pk".into(), key_type: KeyType::S },
                range: None,
            },
            indexes: vec![IndexDescription {
                name: "gsi".into(),
                kind: IndexKind::Gsi,
                key_schema: KeySchema {
                    hash: KeyAttribute { name: "g".into(), key_type: KeyType::N },
                    range: None,
                },
                projection: Projection::KeysOnly,
            }],
            item_count: Some(1),
            size_bytes: None,
            billing_mode: None,
        };
        assert_eq!(
            serde_json::to_value(&description).unwrap(),
            json!({
                "name": "t", "status": "ACTIVE",
                "keySchema": { "hash": { "name": "pk", "type": "S" }, "range": null },
                "indexes": [{ "name": "gsi", "kind": "gsi",
                    "keySchema": { "hash": { "name": "g", "type": "N" }, "range": null },
                    "projection": "keys_only" }],
                "itemCount": 1, "sizeBytes": null, "billingMode": null
            })
        );
    }
}
