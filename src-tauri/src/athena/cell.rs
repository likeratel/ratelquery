//! Athena column types and text values -> `Cell` / `ColumnInfo`.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::mysql::Cell;

/// The type without parameters, trimmed and lower-cased: `decimal(10,2)` -> `decimal`,
/// `array<string>` -> `array`, `timestamp(3) with time zone` -> `timestamp`.
pub fn base_type(type_name: &str) -> String {
    let end = type_name.find(['(', '<']).unwrap_or(type_name.len());
    type_name[..end].trim().to_ascii_lowercase()
}

/// `ColumnInfo.typeName`: the base type upper-cased (`VARCHAR`, `DECIMAL`, `ARRAY`).
pub fn display_type(type_name: &str) -> String {
    base_type(type_name).to_ascii_uppercase()
}

fn is_integer(text: &str) -> bool {
    let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn float_cell(text: &str) -> Cell {
    match text.trim().parse::<f64>() {
        Ok(value) if value.is_finite() => Cell::Float(value),
        _ => Cell::Str(text.to_string()),
    }
}

/// Space-separated hex pairs (`00 ff 1a`) -> bytes. `None` for anything else.
fn hex_pairs(text: &str) -> Option<Vec<u8>> {
    text.split_ascii_whitespace()
        .map(|pair| if pair.len() == 2 { u8::from_str_radix(pair, 16).ok() } else { None })
        .collect()
}

fn bytes_cell(text: &str) -> Cell {
    match hex_pairs(text) {
        Some(bytes) => Cell::Bytes(BASE64.encode(bytes)),
        None => Cell::Str(text.to_string()),
    }
}

/// Maps one value by its column type. `None` (no `VarCharValue`) is `null`.
pub fn to_cell(type_name: &str, value: Option<&str>) -> Cell {
    let Some(text) = value else { return Cell::Null };
    let base = base_type(type_name);
    match base.as_str() {
        "boolean" => match text {
            "true" => Cell::Bool(true),
            "false" => Cell::Bool(false),
            _ => Cell::Str(text.to_string()),
        },
        "tinyint" | "smallint" | "integer" | "int" | "bigint" if is_integer(text) => {
            Cell::Int(text.to_string())
        }
        "real" | "float" | "double" => float_cell(text),
        "decimal" => Cell::Decimal(text.to_string()),
        "date" => Cell::Date(text.to_string()),
        "time" => Cell::Time(text.to_string()),
        "json" => Cell::Json(text.to_string()),
        "varbinary" => bytes_cell(text),
        _ if base.starts_with("timestamp") => Cell::Datetime(text.to_string()),
        _ => Cell::Str(text.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_type_names() {
        assert_eq!(base_type("decimal(10,2)"), "decimal");
        assert_eq!(base_type("array<string>"), "array");
        assert_eq!(base_type("VARCHAR"), "varchar");
        assert_eq!(base_type("row(a integer)"), "row");
        assert_eq!(base_type("timestamp with time zone"), "timestamp with time zone");
        assert_eq!(base_type("timestamp(3) with time zone"), "timestamp");
        assert_eq!(base_type(" interval day to second "), "interval day to second");
        assert_eq!(display_type("decimal(10,2)"), "DECIMAL");
        assert_eq!(display_type("map<string,int>"), "MAP");
        assert_eq!(display_type("varchar"), "VARCHAR");
    }

    #[test]
    fn maps_scalar_types() {
        assert_eq!(to_cell("varchar", None), Cell::Null);
        assert_eq!(to_cell("bigint", None), Cell::Null);
        assert_eq!(to_cell("boolean", Some("true")), Cell::Bool(true));
        assert_eq!(to_cell("BOOLEAN", Some("false")), Cell::Bool(false));
        assert_eq!(to_cell("boolean", Some("yes")), Cell::Str("yes".into()));
        for t in ["tinyint", "smallint", "integer", "int", "bigint"] {
            assert_eq!(to_cell(t, Some("-42")), Cell::Int("-42".into()), "{t}");
        }
        assert_eq!(
            to_cell("bigint", Some("9223372036854775807")),
            Cell::Int("9223372036854775807".into())
        );
        assert_eq!(to_cell("integer", Some("n/a")), Cell::Str("n/a".into()));
        assert_eq!(to_cell("decimal(10,2)", Some("1.20")), Cell::Decimal("1.20".into()));
        assert_eq!(to_cell("date", Some("2024-01-02")), Cell::Date("2024-01-02".into()));
        assert_eq!(to_cell("time", Some("10:00:00.000")), Cell::Time("10:00:00.000".into()));
        assert_eq!(to_cell("json", Some("{\"a\":1}")), Cell::Json("{\"a\":1}".into()));
    }

    #[test]
    fn maps_floats_and_keeps_non_finite_as_text() {
        assert_eq!(to_cell("double", Some("1.5")), Cell::Float(1.5));
        assert_eq!(to_cell("real", Some("1.0E10")), Cell::Float(1.0e10));
        assert_eq!(to_cell("float", Some("-0.25")), Cell::Float(-0.25));
        for text in ["NaN", "Infinity", "-Infinity", "abc", ""] {
            assert_eq!(to_cell("double", Some(text)), Cell::Str(text.into()), "{text}");
        }
    }

    #[test]
    fn maps_timestamps() {
        for t in
            ["timestamp", "timestamp(3)", "timestamp with time zone", "TIMESTAMP(6) WITH TIME ZONE"]
        {
            assert_eq!(
                to_cell(t, Some("2024-01-02 03:04:05.000")),
                Cell::Datetime("2024-01-02 03:04:05.000".into()),
                "{t}"
            );
        }
    }

    #[test]
    fn decodes_varbinary_hex_pairs() {
        assert_eq!(to_cell("varbinary", Some("00 01 ff")), Cell::Bytes("AAH/".into()));
        assert_eq!(to_cell("varbinary", Some("68 65 6C 6C 6F")), Cell::Bytes("aGVsbG8=".into()));
        assert_eq!(to_cell("varbinary", Some("")), Cell::Bytes(String::new()));
        for text in ["0 1", "zz", "001", "hello"] {
            assert_eq!(to_cell("varbinary", Some(text)), Cell::Str(text.into()), "{text}");
        }
    }

    #[test]
    fn other_types_are_text() {
        for t in [
            "varchar",
            "char(3)",
            "string",
            "array<string>",
            "map<string,int>",
            "row(a int)",
            "interval day to second",
            "ipaddress",
            "uuid",
            "something_new",
        ] {
            assert_eq!(to_cell(t, Some("v")), Cell::Str("v".into()), "{t}");
        }
    }
}
