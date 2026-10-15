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

pub fn column_info(name: &str, meta: &TypeMeta) -> ColumnInfo {
    // sqlx does not expose the origin table of a result column.
    ColumnInfo {
        name: name.to_string(),
        type_name: meta.name.clone(),
        table: None,
        nullable: meta.nullable,
    }
}

pub fn column_names(columns: &[MySqlColumn]) -> Vec<String> {
    columns.iter().map(|c| c.name().to_string()).collect()
}

pub fn column_metas(columns: &[MySqlColumn]) -> Vec<TypeMeta> {
    columns.iter().map(|c| TypeMeta::from_type_info(c.type_info())).collect()
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

/// TINYINT(1): only the texts `0` and `1` are booleans; any other value stays an integer.
pub fn bool_cell(text: String) -> Cell {
    match text.as_str() {
        "0" => Cell::Bool(false),
        "1" => Cell::Bool(true),
        _ => integer_text(&text).map(Cell::Int).unwrap_or(Cell::Str(text)),
    }
}

/// Binary-flagged string: valid UTF-8 is text, anything else bytes.
pub fn maybe_text_cell(bytes: Vec<u8>) -> Cell {
    match String::from_utf8(bytes) {
        Ok(text) => Cell::Str(text),
        Err(err) => Cell::Bytes(BASE64.encode(err.into_bytes())),
    }
}

fn decode_value(row: &MySqlRow, index: usize, meta: &TypeMeta) -> Result<Cell, sqlx::Error> {
    match meta.category {
        Category::Bool => Ok(bool_cell(row.try_get_unchecked::<String, _>(index)?)),
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
        Category::MaybeText => Ok(maybe_text_cell(raw_bytes(row, index)?)),
        Category::Text => text_or_bytes(row, index),
    }
}

pub fn decode_cell(row: &MySqlRow, index: usize, meta: &TypeMeta) -> Result<Cell, sqlx::Error> {
    if row.try_get_raw(index)?.is_null() {
        return Ok(Cell::Null);
    }
    decode_value(row, index, meta)
}

pub fn decode_row(row: &MySqlRow, metas: &[TypeMeta]) -> Result<Vec<Cell>, sqlx::Error> {
    metas.iter().enumerate().map(|(index, meta)| decode_cell(row, index, meta)).collect()
}

fn column_has(rows: &[Vec<Cell>], index: usize, test: fn(&Cell) -> bool) -> bool {
    rows.iter().any(|row| row.get(index).is_some_and(test))
}

/// Final metadata for a column once its decoded values are known: a binary-flagged column is
/// binary when any value was not UTF-8 and otherwise a text column, including when it has no
/// non-null values at all (every value is then vacuously valid UTF-8, as the contract says).
/// A TINYINT(1) is only boolean when every value was 0 or 1.
fn settled_meta(meta: &TypeMeta, rows: &[Vec<Cell>], index: usize) -> TypeMeta {
    let has_bytes = column_has(rows, index, |c| matches!(c, Cell::Bytes(_)));
    match meta.category {
        Category::MaybeText if has_bytes => meta.as_binary(),
        Category::MaybeText => meta.as_text(),
        _ => meta.clone(),
    }
}

/// Re-types one cell so a column never mixes representations.
fn settled_cell(cell: Cell, meta: &TypeMeta, ints_in_bool_column: bool) -> Cell {
    match (cell, meta.category) {
        (Cell::Str(text), Category::Bytes) => Cell::Bytes(BASE64.encode(text.as_bytes())),
        (Cell::Bool(v), Category::Bool) if ints_in_bool_column => {
            Cell::Int(if v { "1" } else { "0" }.to_string())
        }
        (cell, _) => cell,
    }
}

/// Makes every column of a collected result consistent and returns the column infos.
pub fn settle_columns(
    names: &[String],
    metas: &[TypeMeta],
    rows: Vec<Vec<Cell>>,
) -> (Vec<ColumnInfo>, Vec<Vec<Cell>>) {
    let settled: Vec<TypeMeta> =
        metas.iter().enumerate().map(|(i, meta)| settled_meta(meta, &rows, i)).collect();
    let int_columns: Vec<bool> = (0..metas.len())
        .map(|i| {
            metas[i].category == Category::Bool
                && column_has(&rows, i, |c| matches!(c, Cell::Int(_)))
        })
        .collect();
    let rows = rows
        .into_iter()
        .map(|row| {
            row.into_iter()
                .enumerate()
                .map(|(i, cell)| match (settled.get(i), int_columns.get(i)) {
                    (Some(meta), Some(ints)) => settled_cell(cell, meta, *ints),
                    _ => cell,
                })
                .collect()
        })
        .collect();
    let columns = names.iter().zip(&settled).map(|(name, meta)| column_info(name, meta)).collect();
    (columns, rows)
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
    fn tinyint1_is_bool_only_for_zero_and_one() {
        assert_eq!(bool_cell("0".into()), Cell::Bool(false));
        assert_eq!(bool_cell("1".into()), Cell::Bool(true));
        assert_eq!(bool_cell("2".into()), Cell::Int("2".into()));
        assert_eq!(bool_cell("-128".into()), Cell::Int("-128".into()));
    }

    #[test]
    fn binary_flagged_values_decode_as_text_when_utf8() {
        assert_eq!(maybe_text_cell("한글".as_bytes().to_vec()), Cell::Str("한글".into()));
        assert_eq!(maybe_text_cell(vec![0x00, 0xff, 0x10]), Cell::Bytes("AP8Q".into()));
    }

    fn meta(name: &str) -> TypeMeta {
        super::super::type_meta::from_parts(name, "")
    }

    #[test]
    fn settles_maybe_text_columns_by_their_values() {
        let names = vec!["t".to_string(), "b".to_string(), "e".to_string()];
        let metas = vec![meta("VARBINARY"), meta("BLOB"), meta("LONGBLOB")];
        let rows = vec![
            vec![Cell::Str("a".into()), Cell::Str("AB".into()), Cell::Null],
            vec![Cell::Str("b".into()), Cell::Bytes("/w==".into()), Cell::Null],
        ];
        let (columns, rows) = settle_columns(&names, &metas, rows);
        let types: Vec<&str> = columns.iter().map(|c| c.type_name.as_str()).collect();
        assert_eq!(types, ["VARCHAR", "BLOB", "LONGTEXT"], "all-null column settles as text");
        assert_eq!(rows[0][1], Cell::Bytes("QUI=".into()), "text cell re-encoded as bytes");
        assert_eq!(rows[1][1], Cell::Bytes("/w==".into()));
        assert_eq!(rows[0][0], Cell::Str("a".into()));
    }

    #[test]
    fn maybe_text_columns_without_rows_settle_as_text() {
        let names = vec!["v".to_string(), "b".to_string()];
        let metas = vec![meta("VARBINARY"), meta("BLOB")];
        let (columns, rows) = settle_columns(&names, &metas, Vec::new());
        let types: Vec<&str> = columns.iter().map(|c| c.type_name.as_str()).collect();
        assert_eq!(types, ["VARCHAR", "TEXT"]);
        assert!(rows.is_empty());
    }

    #[test]
    fn known_binary_column_turns_text_cells_into_bytes() {
        let names = vec!["b".to_string()];
        let metas = vec![meta("VARBINARY").as_binary()];
        let (columns, rows) = settle_columns(&names, &metas, vec![vec![Cell::Str("AB".into())]]);
        assert_eq!(columns[0].type_name, "VARBINARY");
        assert_eq!(rows[0][0], Cell::Bytes("QUI=".into()));
    }

    #[test]
    fn bool_column_with_other_values_becomes_int() {
        let names = vec!["f".to_string()];
        let metas = vec![meta("BOOLEAN")];
        let rows = vec![vec![Cell::Bool(true)], vec![Cell::Int("2".into())], vec![Cell::Null]];
        let (columns, rows) = settle_columns(&names, &metas, rows);
        assert_eq!(columns[0].type_name, "TINYINT");
        assert_eq!(rows[0][0], Cell::Int("1".into()));
        assert_eq!(rows[1][0], Cell::Int("2".into()));
        let (_, kept) = settle_columns(&names, &metas, vec![vec![Cell::Bool(false)]]);
        assert_eq!(kept[0][0], Cell::Bool(false));
    }

    #[test]
    fn integer_text_accepts_only_plain_integers() {
        assert_eq!(integer_text("2024").as_deref(), Some("2024"));
        assert_eq!(integer_text("-5").as_deref(), Some("-5"));
        assert_eq!(integer_text("1.5"), None);
        assert_eq!(integer_text("-"), None);
    }
}
