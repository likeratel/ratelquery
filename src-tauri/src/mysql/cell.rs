use serde::{Deserialize, Serialize};

/// A result cell, tagged so BIGINT/DECIMAL never lose precision in JS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "lowercase")]
pub enum Cell {
    Null,
    Str(String),
    /// Decimal string of any integer width.
    Int(String),
    Float(f64),
    Bool(bool),
    Decimal(String),
    Date(String),
    Time(String),
    Datetime(String),
    /// Raw JSON text.
    Json(String),
    /// Base64 encoded bytes.
    Bytes(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_with_t_and_v_tags() {
        assert_eq!(serde_json::to_value(Cell::Null).unwrap(), json!({ "t": "null" }));
        assert_eq!(
            serde_json::to_value(Cell::Int("18446744073709551615".into())).unwrap(),
            json!({ "t": "int", "v": "18446744073709551615" })
        );
        assert_eq!(
            serde_json::to_value(Cell::Datetime("2024-01-01 00:00:00.123".into())).unwrap(),
            json!({ "t": "datetime", "v": "2024-01-01 00:00:00.123" })
        );
        assert_eq!(
            serde_json::to_value(Cell::Bool(true)).unwrap(),
            json!({ "t": "bool", "v": true })
        );
    }

    #[test]
    fn deserializes_every_tag() {
        let input = json!([
            { "t": "null" }, { "t": "str", "v": "a" }, { "t": "int", "v": "1" },
            { "t": "float", "v": 1.5 }, { "t": "bool", "v": false }, { "t": "decimal", "v": "1.20" },
            { "t": "date", "v": "2024-01-01" }, { "t": "time", "v": "-01:00:00" },
            { "t": "datetime", "v": "2024-01-01 00:00:00" }, { "t": "json", "v": "{}" },
            { "t": "bytes", "v": "AAE=" }
        ]);
        let cells: Vec<Cell> = serde_json::from_value(input).unwrap();
        assert_eq!(cells.len(), 11);
        assert_eq!(cells[0], Cell::Null);
        assert_eq!(cells[10], Cell::Bytes("AAE=".into()));
    }
}
