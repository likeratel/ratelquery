//! DynamoDB JSON wire format (`{"S": "a"}`, `{"N": "12"}`, `{"M": {...}}` ...) <-> SDK values.

use std::collections::HashMap;

use aws_sdk_dynamodb::primitives::Blob;
use aws_sdk_dynamodb::types::AttributeValue;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

/// One item as it crosses IPC: attribute name -> wire attribute value.
pub type WireItem = Map<String, Value>;
/// One item as the SDK uses it.
pub type SdkItem = HashMap<String, AttributeValue>;

fn invalid(path: &str, reason: &str) -> AppError {
    AppError::InvalidInput(format!("invalid attribute value at {path}: {reason}"))
}

fn tagged(tag: &str, value: Value) -> Value {
    Value::Object(Map::from_iter([(tag.to_string(), value)]))
}

fn strings(values: &[String]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}

fn blobs(values: &[Blob]) -> Value {
    Value::Array(values.iter().map(|b| Value::String(BASE64.encode(b.as_ref()))).collect())
}

/// SDK value -> wire value. Fails only for variants this SDK version does not know.
pub fn to_wire(value: &AttributeValue) -> AppResult<Value> {
    Ok(match value {
        AttributeValue::S(v) => tagged("S", Value::String(v.clone())),
        AttributeValue::N(v) => tagged("N", Value::String(v.clone())),
        AttributeValue::B(v) => tagged("B", Value::String(BASE64.encode(v.as_ref()))),
        AttributeValue::Bool(v) => tagged("BOOL", Value::Bool(*v)),
        AttributeValue::Null(v) => tagged("NULL", Value::Bool(*v)),
        AttributeValue::M(v) => tagged("M", Value::Object(to_wire_item(v)?)),
        AttributeValue::L(v) => {
            tagged("L", Value::Array(v.iter().map(to_wire).collect::<AppResult<_>>()?))
        }
        AttributeValue::Ss(v) => tagged("SS", strings(v)),
        AttributeValue::Ns(v) => tagged("NS", strings(v)),
        AttributeValue::Bs(v) => tagged("BS", blobs(v)),
        _ => return Err(AppError::Query("DynamoDB returned an unsupported attribute type".into())),
    })
}

/// SDK item -> wire item.
pub fn to_wire_item(item: &SdkItem) -> AppResult<WireItem> {
    item.iter().map(|(k, v)| Ok((k.clone(), to_wire(v)?))).collect()
}

fn as_str<'a>(value: &'a Value, path: &str, tag: &str) -> AppResult<&'a str> {
    value.as_str().ok_or_else(|| invalid(path, &format!("{tag} must be a string")))
}

fn as_array<'a>(value: &'a Value, path: &str, tag: &str) -> AppResult<&'a Vec<Value>> {
    value.as_array().ok_or_else(|| invalid(path, &format!("{tag} must be an array")))
}

fn decode_blob(text: &str, path: &str) -> AppResult<Blob> {
    BASE64
        .decode(text)
        .map(Blob::new)
        .map_err(|e| invalid(path, &format!("B is not valid base64 ({e})")))
}

fn skip_digits(bytes: &[u8]) -> (usize, &[u8]) {
    let count = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    (count, &bytes[count..])
}

/// DynamoDB number syntax: optional sign, digits with an optional fraction (`5`, `5.`, `.5`,
/// `5.25`), then an optional exponent (`e`/`E`, optional sign, digits). Range and precision are
/// left to the service.
pub fn is_number_text(text: &str) -> bool {
    let rest = text.as_bytes();
    let rest = rest.strip_prefix(b"+").or_else(|| rest.strip_prefix(b"-")).unwrap_or(rest);
    let (whole, rest) = skip_digits(rest);
    let (fraction, rest) = match rest.strip_prefix(b".") {
        Some(after) => skip_digits(after),
        None => (0, rest),
    };
    if whole + fraction == 0 {
        return false;
    }
    match rest.strip_prefix(b"e").or_else(|| rest.strip_prefix(b"E")) {
        None => rest.is_empty(),
        Some(exp) => {
            let exp = exp.strip_prefix(b"+").or_else(|| exp.strip_prefix(b"-")).unwrap_or(exp);
            let (digits, rest) = skip_digits(exp);
            digits > 0 && rest.is_empty()
        }
    }
}

fn number<'a>(text: &'a str, path: &str, tag: &str) -> AppResult<&'a str> {
    if is_number_text(text) {
        Ok(text)
    } else {
        Err(invalid(
            path,
            &format!("{tag} must be a number such as \"12\" or \"-1.5e3\", got {text:?}"),
        ))
    }
}

fn string_set(value: &Value, path: &str, tag: &str) -> AppResult<Vec<String>> {
    let items = as_array(value, path, tag)?;
    if items.is_empty() {
        return Err(invalid(
            path,
            &format!("{tag} must not be empty (DynamoDB rejects empty sets)"),
        ));
    }
    items.iter().map(|v| as_str(v, path, tag).map(str::to_string)).collect()
}

fn from_tagged(tag: &str, inner: &Value, path: &str) -> AppResult<AttributeValue> {
    Ok(match tag {
        "S" => AttributeValue::S(as_str(inner, path, tag)?.to_string()),
        "N" => AttributeValue::N(number(as_str(inner, path, tag)?, path, tag)?.to_string()),
        "B" => AttributeValue::B(decode_blob(as_str(inner, path, tag)?, path)?),
        "BOOL" => AttributeValue::Bool(
            inner.as_bool().ok_or_else(|| invalid(path, "BOOL must be true or false"))?,
        ),
        "NULL" => match inner {
            Value::Bool(true) => AttributeValue::Null(true),
            _ => return Err(invalid(path, "NULL must be true")),
        },
        "M" => {
            let map = inner.as_object().ok_or_else(|| invalid(path, "M must be an object"))?;
            AttributeValue::M(from_wire_map(map, path)?)
        }
        "L" => AttributeValue::L(
            as_array(inner, path, tag)?
                .iter()
                .enumerate()
                .map(|(i, v)| from_wire_at(v, &format!("{path}[{i}]")))
                .collect::<AppResult<_>>()?,
        ),
        "SS" => AttributeValue::Ss(string_set(inner, path, tag)?),
        "NS" => {
            let values = string_set(inner, path, tag)?;
            for value in &values {
                number(value, path, tag)?;
            }
            AttributeValue::Ns(values)
        }
        "BS" => AttributeValue::Bs(
            string_set(inner, path, tag)?
                .iter()
                .map(|s| decode_blob(s, path))
                .collect::<AppResult<_>>()?,
        ),
        other => return Err(invalid(path, &format!("unknown type tag {other:?}"))),
    })
}

fn from_wire_at(value: &Value, path: &str) -> AppResult<AttributeValue> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid(path, "expected an object such as {\"S\": \"text\"}"))?;
    let mut entries = object.iter();
    match (entries.next(), entries.next()) {
        (Some((tag, inner)), None) => from_tagged(tag, inner, path),
        _ => Err(invalid(path, "expected exactly one type tag")),
    }
}

fn from_wire_map(map: &WireItem, path: &str) -> AppResult<SdkItem> {
    map.iter().map(|(k, v)| Ok((k.clone(), from_wire_at(v, &format!("{path}.{k}"))?))).collect()
}

/// Wire value -> SDK value. Malformed input is `invalid_input`.
pub fn from_wire(value: &Value) -> AppResult<AttributeValue> {
    from_wire_at(value, "$")
}

/// Wire item -> SDK item. Malformed input is `invalid_input`.
pub fn from_wire_item(item: &WireItem) -> AppResult<SdkItem> {
    from_wire_map(item, "$")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(value: Value) {
        let sdk = from_wire(&value).unwrap();
        assert_eq!(to_wire(&sdk).unwrap(), value);
    }

    #[test]
    fn scalars_round_trip() {
        round_trip(json!({ "S": "한글" }));
        round_trip(json!({ "N": "-12.5" }));
        round_trip(json!({ "B": "AAH/" }));
        round_trip(json!({ "BOOL": false }));
        round_trip(json!({ "NULL": true }));
        assert_eq!(
            from_wire(&json!({ "B": "AAH/" })).unwrap(),
            AttributeValue::B(Blob::new(vec![0, 1, 255]))
        );
    }

    #[test]
    fn nested_values_round_trip() {
        round_trip(json!({ "M": {
            "list": { "L": [ { "S": "a" }, { "M": { "n": { "N": "1" } } }, { "L": [] } ] },
            "empty": { "M": {} },
            "ss": { "SS": ["a", "b"] },
            "ns": { "NS": ["1", "2.5"] },
            "bs": { "BS": ["AQ==", "Ag=="] }
        } }));
    }

    #[test]
    fn items_round_trip() {
        let item: WireItem =
            serde_json::from_value(json!({ "pk": { "S": "u#1" }, "n": { "N": "3" } })).unwrap();
        let sdk = from_wire_item(&item).unwrap();
        assert_eq!(sdk["pk"], AttributeValue::S("u#1".into()));
        assert_eq!(to_wire_item(&sdk).unwrap(), item);
    }

    #[test]
    fn empty_sets_serialize_but_are_rejected_on_input() {
        assert_eq!(to_wire(&AttributeValue::Ss(vec![])).unwrap(), json!({ "SS": [] }));
        assert_eq!(to_wire(&AttributeValue::Bs(vec![])).unwrap(), json!({ "BS": [] }));
        for tag in ["SS", "NS", "BS"] {
            let err = from_wire(&json!({ tag: [] })).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{tag}");
        }
    }

    #[test]
    fn number_syntax_matches_dynamodb() {
        for ok in ["0", "-12.5", "+5", ".5", "5.", "1e+21", "1e-7", "2E3", "007"] {
            assert!(is_number_text(ok), "{ok}");
            round_trip(json!({ "N": ok }));
        }
        for bad in ["", "abc", "1..2", "--1", ".", "+", "1e", "1e+", " 1", "1 ", "0x10", "NaN"] {
            assert!(!is_number_text(bad), "{bad:?}");
            let err = from_wire(&json!({ "N": bad })).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{bad:?}");
        }
        let err = from_wire(&json!({ "NS": ["1", "abc"] })).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn malformed_input_is_invalid_input() {
        let cases = [
            json!("text"),
            json!({}),
            json!({ "S": "a", "N": "1" }),
            json!({ "X": "a" }),
            json!({ "S": 1 }),
            json!({ "N": 12 }),
            json!({ "B": "not base64!" }),
            json!({ "BOOL": "true" }),
            json!({ "NULL": false }),
            json!({ "M": [] }),
            json!({ "L": {} }),
            json!({ "SS": [1] }),
            json!({ "BS": ["%%"] }),
            json!({ "M": { "deep": { "L": [ { "Q": 1 } ] } } }),
        ];
        for case in cases {
            let err = from_wire(&case).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{case}");
        }
        let err = from_wire(&json!({ "M": { "deep": { "L": [ { "Q": 1 } ] } } })).unwrap_err();
        assert!(err.to_string().contains("$.deep[0]"), "{err}");
    }
}
