//! Per-cell formatting rules shared by the export writers.

use std::borrow::Cow;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Number, Value};

use crate::error::{AppError, AppResult};
use crate::mysql::Cell;

/// Largest integer magnitude a JS number represents exactly (2^53 - 1).
const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;

/// CSV field text: NULL is an empty field, bytes stay base64, booleans are `1`/`0` (MySQL's
/// own representation).
pub fn csv_field(cell: &Cell) -> Cow<'_, str> {
    match cell {
        Cell::Null => Cow::Borrowed(""),
        Cell::Bool(v) => Cow::Borrowed(if *v { "1" } else { "0" }),
        Cell::Float(v) => Cow::Owned(v.to_string()),
        Cell::Str(v)
        | Cell::Int(v)
        | Cell::Decimal(v)
        | Cell::Date(v)
        | Cell::Time(v)
        | Cell::Datetime(v)
        | Cell::Json(v)
        | Cell::Bytes(v) => Cow::Borrowed(v.as_str()),
    }
}

fn safe_integer(text: &str) -> Option<Value> {
    let parsed: i128 = text.trim().parse().ok()?;
    (parsed.abs() <= MAX_SAFE_INTEGER).then(|| Value::Number(Number::from(parsed as i64)))
}

/// JSON value: ints within 53 bits become numbers, larger ones strings; decimals and dates are
/// strings; JSON columns are embedded as parsed JSON (falling back to a string).
pub fn json_value(cell: &Cell) -> Value {
    match cell {
        Cell::Null => Value::Null,
        Cell::Bool(v) => Value::Bool(*v),
        Cell::Float(v) => Number::from_f64(*v).map(Value::Number).unwrap_or(Value::Null),
        Cell::Int(v) => safe_integer(v).unwrap_or_else(|| Value::String(v.clone())),
        Cell::Json(v) => serde_json::from_str(v).unwrap_or_else(|_| Value::String(v.clone())),
        Cell::Str(v)
        | Cell::Decimal(v)
        | Cell::Date(v)
        | Cell::Time(v)
        | Cell::Datetime(v)
        | Cell::Bytes(v) => Value::String(v.clone()),
    }
}

/// MySQL string literal with the standard backslash escapes.
pub fn quote_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for ch in text.chars() {
        match ch {
            '\0' => out.push_str("\\0"),
            '\'' => out.push_str("\\'"),
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{1a}' => out.push_str("\\Z"),
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

fn is_numeric_literal(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    let mut parts = body.splitn(2, '.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && fraction.is_none_or(digits)
}

fn hex_literal(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "''".to_string();
    }
    let hex: String = bytes.iter().map(|b| format!("{b:02X}")).collect();
    format!("X'{hex}'")
}

/// SQL literal for an INSERT statement.
pub fn sql_literal(cell: &Cell) -> AppResult<String> {
    Ok(match cell {
        Cell::Null => "NULL".to_string(),
        Cell::Bool(v) => (if *v { "1" } else { "0" }).to_string(),
        Cell::Float(v) if v.is_finite() => v.to_string(),
        Cell::Float(_) => "NULL".to_string(),
        Cell::Int(v) | Cell::Decimal(v) if is_numeric_literal(v) => v.clone(),
        Cell::Bytes(v) => hex_literal(
            &BASE64
                .decode(v)
                .map_err(|e| AppError::InvalidInput(format!("invalid base64 bytes value: {e}")))?,
        ),
        Cell::Int(v)
        | Cell::Decimal(v)
        | Cell::Str(v)
        | Cell::Date(v)
        | Cell::Time(v)
        | Cell::Datetime(v)
        | Cell::Json(v) => quote_string(v),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn csv_fields() {
        assert_eq!(csv_field(&Cell::Null), "");
        assert_eq!(csv_field(&Cell::Bool(true)), "1");
        assert_eq!(csv_field(&Cell::Float(0.1)), "0.1");
        assert_eq!(csv_field(&Cell::Decimal("1.50".into())), "1.50");
    }

    #[test]
    fn json_values_respect_53_bit_limit() {
        assert_eq!(json_value(&Cell::Int("9007199254740991".into())), json!(9007199254740991_i64));
        assert_eq!(
            json_value(&Cell::Int("-9007199254740991".into())),
            json!(-9007199254740991_i64)
        );
        assert_eq!(json_value(&Cell::Int("9007199254740992".into())), json!("9007199254740992"));
        assert_eq!(json_value(&Cell::Decimal("1.20".into())), json!("1.20"));
        assert_eq!(json_value(&Cell::Json("{\"a\":[1]}".into())), json!({ "a": [1] }));
        assert_eq!(json_value(&Cell::Float(f64::NAN)), Value::Null);
        assert_eq!(json_value(&Cell::Null), Value::Null);
    }

    #[test]
    fn sql_literals_escape_strings() {
        assert_eq!(
            sql_literal(&Cell::Str("it's \"x\"\\\n".into())).unwrap(),
            r#"'it\'s \"x\"\\\n'"#
        );
        assert_eq!(sql_literal(&Cell::Str("a\0b\u{1a}".into())).unwrap(), r"'a\0b\Z'");
        assert_eq!(sql_literal(&Cell::Null).unwrap(), "NULL");
        assert_eq!(sql_literal(&Cell::Int("-12".into())).unwrap(), "-12");
        assert_eq!(sql_literal(&Cell::Decimal("1.50".into())).unwrap(), "1.50");
        assert_eq!(sql_literal(&Cell::Decimal("1e5; DROP".into())).unwrap(), "'1e5; DROP'");
        assert_eq!(sql_literal(&Cell::Bytes("AAH/".into())).unwrap(), "X'0001FF'");
        assert_eq!(sql_literal(&Cell::Bytes(String::new())).unwrap(), "''");
        assert_eq!(sql_literal(&Cell::Bool(false)).unwrap(), "0");
        assert_eq!(
            sql_literal(&Cell::Datetime("2024-01-01 00:00:00".into())).unwrap(),
            "'2024-01-01 00:00:00'"
        );
    }

    #[test]
    fn numeric_literal_detection() {
        assert!(is_numeric_literal("10"));
        assert!(is_numeric_literal("-0.5"));
        assert!(!is_numeric_literal("1."));
        assert!(!is_numeric_literal(".5"));
        assert!(!is_numeric_literal(""));
    }
}
