//! Converts frontend `Cell` values into bound statement parameters.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sqlx::MySql;
use sqlx::mysql::MySqlArguments;
use sqlx::query::Query;

use super::cell::Cell;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq)]
pub enum BindValue {
    Null,
    Text(String),
    Signed(i64),
    Unsigned(u64),
    Float(f64),
    Bool(bool),
    Bytes(Vec<u8>),
}

fn integer(text: &str) -> AppResult<BindValue> {
    let trimmed = text.trim();
    if let Ok(v) = trimmed.parse::<i64>() {
        return Ok(BindValue::Signed(v));
    }
    trimmed
        .parse::<u64>()
        .map(BindValue::Unsigned)
        .map_err(|_| AppError::InvalidInput(format!("{text:?} is not an integer")))
}

/// Text-like values (decimal, temporal, JSON) are bound as strings so MySQL converts them
/// exactly; no precision is lost on the way.
pub fn to_bind_value(cell: &Cell) -> AppResult<BindValue> {
    Ok(match cell {
        Cell::Null => BindValue::Null,
        Cell::Int(v) => integer(v)?,
        Cell::Float(v) if v.is_finite() => BindValue::Float(*v),
        Cell::Float(v) => {
            return Err(AppError::InvalidInput(format!("{v} is not a finite number")));
        }
        Cell::Bool(v) => BindValue::Bool(*v),
        Cell::Bytes(v) => BindValue::Bytes(
            BASE64
                .decode(v)
                .map_err(|e| AppError::InvalidInput(format!("invalid base64 bytes value: {e}")))?,
        ),
        Cell::Str(v)
        | Cell::Decimal(v)
        | Cell::Date(v)
        | Cell::Time(v)
        | Cell::Datetime(v)
        | Cell::Json(v) => BindValue::Text(v.clone()),
    })
}

pub fn bind_value<'q>(
    query: Query<'q, MySql, MySqlArguments>,
    value: BindValue,
) -> Query<'q, MySql, MySqlArguments> {
    match value {
        BindValue::Null => query.bind(None::<String>),
        BindValue::Text(v) => query.bind(v),
        BindValue::Signed(v) => query.bind(v),
        BindValue::Unsigned(v) => query.bind(v),
        BindValue::Float(v) => query.bind(v),
        BindValue::Bool(v) => query.bind(v),
        BindValue::Bytes(v) => query.bind(v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_cells_to_bind_values() {
        assert_eq!(to_bind_value(&Cell::Null).unwrap(), BindValue::Null);
        assert_eq!(to_bind_value(&Cell::Int("-3".into())).unwrap(), BindValue::Signed(-3));
        assert_eq!(
            to_bind_value(&Cell::Int("18446744073709551615".into())).unwrap(),
            BindValue::Unsigned(u64::MAX)
        );
        assert_eq!(
            to_bind_value(&Cell::Decimal("12345678901234567890.123".into())).unwrap(),
            BindValue::Text("12345678901234567890.123".into())
        );
        assert_eq!(
            to_bind_value(&Cell::Bytes("AAE=".into())).unwrap(),
            BindValue::Bytes(vec![0, 1])
        );
        assert_eq!(to_bind_value(&Cell::Bool(true)).unwrap(), BindValue::Bool(true));
    }

    #[test]
    fn rejects_invalid_values() {
        assert_eq!(to_bind_value(&Cell::Int("1.5".into())).unwrap_err().kind(), "invalid_input");
        assert_eq!(to_bind_value(&Cell::Bytes("***".into())).unwrap_err().kind(), "invalid_input");
        assert_eq!(to_bind_value(&Cell::Float(f64::NAN)).unwrap_err().kind(), "invalid_input");
    }
}
