//! Row decoding. Rows always come from the text protocol (`sqlx::raw_sql`), so every non-NULL
//! value is the exact server representation; typed `try_get` is used where it adds checking
//! (integers, floats, booleans) and the textual form is the fallback.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sqlx::mysql::{MySqlColumn, MySqlRow};
use sqlx::{Column, Row, ValueRef};

use super::cell::Cell;
use super::model::ColumnInfo;
use super::type_meta::{Category, TypeMeta};

const MAX_BIT_BYTES: usize = 8;

pub fn column_info(column: &MySqlColumn) -> ColumnInfo {
    let meta = TypeMeta::from_type_info(column.type_info());
    // sqlx does not expose the origin table of a result column.
    ColumnInfo {
        name: column.name().to_string(),
        type_name: meta.name,
        table: None,
        nullable: meta.nullable,
    }
}

pub fn columns_of(columns: &[MySqlColumn]) -> Vec<ColumnInfo> {
    columns.iter().map(column_info).collect()
}

/// Interprets big-endian BIT bytes as an unsigned integer.
pub fn bit_value(bytes: &[u8]) -> Option<u64> {
    if bytes.len() > MAX_BIT_BYTES {
        return None;
    }
    Some(bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b)))
}

/// Integer text from the server, or `None` when it is not a plain decimal integer.
pub fn integer_text(text: &str) -> Option<String> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let valid = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    valid.then(|| text.to_string())
}

fn raw_bytes(row: &MySqlRow, index: usize) -> Result<Vec<u8>, sqlx::Error> {
    row.try_get_unchecked::<Vec<u8>, _>(index)
}

fn text_or_bytes(row: &MySqlRow, index: usize) -> Result<Cell, sqlx::Error> {
    match row.try_get_unchecked::<String, _>(index) {
        Ok(text) => Ok(Cell::Str(text)),
        Err(_) => Ok(Cell::Bytes(BASE64.encode(raw_bytes(row, index)?))),
    }
}

fn text_as(row: &MySqlRow, index: usize, wrap: fn(String) -> Cell) -> Result<Cell, sqlx::Error> {
    match row.try_get_unchecked::<String, _>(index) {
        Ok(text) => Ok(wrap(text)),
        Err(_) => text_or_bytes(row, index),
    }
}

fn decode_bit(row: &MySqlRow, index: usize, meta: &TypeMeta) -> Result<Cell, sqlx::Error> {
    let bytes = raw_bytes(row, index)?;
    Ok(match bit_value(&bytes) {
        Some(value) if meta.is_single_bit() => Cell::Bool(value != 0),
        Some(value) => Cell::Int(value.to_string()),
        None => Cell::Bytes(BASE64.encode(bytes)),
    })
}

fn decode_integer_text(row: &MySqlRow, index: usize) -> Result<Cell, sqlx::Error> {
    let text = row.try_get_unchecked::<String, _>(index)?;
    Ok(integer_text(&text).map(Cell::Int).unwrap_or(Cell::Str(text)))
}

fn decode_value(row: &MySqlRow, index: usize, meta: &TypeMeta) -> Result<Cell, sqlx::Error> {
    match meta.category {
        Category::Bool => match row.try_get::<bool, _>(index) {
            Ok(value) => Ok(Cell::Bool(value)),
            Err(_) => decode_integer_text(row, index),
        },
        Category::SignedInt => match row.try_get::<i64, _>(index) {
            Ok(value) => Ok(Cell::Int(value.to_string())),
            Err(_) => decode_integer_text(row, index),
        },
        Category::UnsignedInt => match row.try_get::<u64, _>(index) {
            Ok(value) => Ok(Cell::Int(value.to_string())),
            Err(_) => decode_integer_text(row, index),
        },
        Category::Year => decode_integer_text(row, index),
        Category::Float => match row.try_get::<f64, _>(index) {
            Ok(value) if value.is_finite() => Ok(Cell::Float(value)),
            _ => text_or_bytes(row, index),
        },
        Category::Decimal => text_as(row, index, Cell::Decimal),
        Category::Date => text_as(row, index, Cell::Date),
        Category::Time => text_as(row, index, Cell::Time),
        Category::DateTime => text_as(row, index, Cell::Datetime),
        Category::Json => text_as(row, index, Cell::Json),
        Category::Bit => decode_bit(row, index, meta),
        Category::Bytes => Ok(Cell::Bytes(BASE64.encode(raw_bytes(row, index)?))),
        Category::Text => text_or_bytes(row, index),
    }
}

pub fn decode_cell(row: &MySqlRow, index: usize, meta: &TypeMeta) -> Result<Cell, sqlx::Error> {
    if row.try_get_raw(index)?.is_null() {
        return Ok(Cell::Null);
    }
    decode_value(row, index, meta)
}

/// Type metadata for every column of `row`, computed once per result set.
pub fn row_metas(row: &MySqlRow) -> Vec<TypeMeta> {
    row.columns().iter().map(|c| TypeMeta::from_type_info(c.type_info())).collect()
}

pub fn decode_row(row: &MySqlRow, metas: &[TypeMeta]) -> Result<Vec<Cell>, sqlx::Error> {
    metas.iter().enumerate().map(|(index, meta)| decode_cell(row, index, meta)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bit_bytes_are_big_endian() {
        assert_eq!(bit_value(&[0x01]), Some(1));
        assert_eq!(bit_value(&[0x01, 0x00]), Some(256));
        assert_eq!(bit_value(&[]), Some(0));
        assert_eq!(bit_value(&[0; 9]), None);
    }

    #[test]
    fn integer_text_accepts_only_plain_integers() {
        assert_eq!(integer_text("2024").as_deref(), Some("2024"));
        assert_eq!(integer_text("-5").as_deref(), Some("-5"));
        assert_eq!(integer_text("1.5"), None);
        assert_eq!(integer_text("-"), None);
    }
}
