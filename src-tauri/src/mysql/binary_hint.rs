//! Settles binary-flagged result columns from `information_schema` when the statement reads a
//! single base table: a column whose `DATA_TYPE` is a binary string type stays bytes even when
//! its value happens to be valid UTF-8, and a `_bin`-collated text column is text.
//!
//! Result columns are matched by name (case-insensitive). sqlx does not expose the origin
//! column of a result, so an alias that reuses another column's name can be misattributed;
//! the value-based fallback in `decode::settle_columns` is used when nothing is known.

use std::collections::HashMap;

use sqlx::Row;
use sqlx::mysql::MySqlConnection;

use super::classify::{BaseTable, infer_base_table};
use super::type_meta::{Category, TypeMeta};

const BINARY_DATA_TYPES: [&str; 6] =
    ["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"];

const COLUMNS_SQL: &str = "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS \
     WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?";

/// Lower-cased column name -> "is a binary string type".
pub type BinaryHint = HashMap<String, bool>;

pub fn has_maybe_text(metas: &[TypeMeta]) -> bool {
    metas.iter().any(|m| m.category == Category::MaybeText)
}

async fn fetch_hint(
    conn: &mut MySqlConnection,
    table: &BaseTable,
) -> Result<BinaryHint, sqlx::Error> {
    let rows = sqlx::query(COLUMNS_SQL)
        .bind(table.database.as_deref())
        .bind(&table.table)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(|row| {
            let name = row.try_get_unchecked::<String, _>(0)?;
            let data_type = row.try_get_unchecked::<String, _>(1)?;
            let binary = BINARY_DATA_TYPES.iter().any(|t| data_type.eq_ignore_ascii_case(t));
            Ok((name.to_lowercase(), binary))
        })
        .collect()
}

/// Column hint for `statement`, or an empty hint when it does not read one base table.
/// The lookup is best effort: a failure only means the value-based fallback is used, and a
/// lost connection surfaces on the next statement.
pub async fn lookup(conn: &mut MySqlConnection, statement: &str) -> BinaryHint {
    let Some(table) = infer_base_table(statement) else { return BinaryHint::new() };
    fetch_hint(conn, &table).await.unwrap_or_default()
}

/// Metadata with every hinted binary-flagged column settled to text or bytes.
pub fn apply(names: &[String], metas: &[TypeMeta], hint: &BinaryHint) -> Vec<TypeMeta> {
    names
        .iter()
        .zip(metas)
        .map(|(name, meta)| match (meta.category, hint.get(&name.to_lowercase())) {
            (Category::MaybeText, Some(true)) => meta.as_binary(),
            (Category::MaybeText, Some(false)) => meta.as_text(),
            _ => meta.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mysql::type_meta::from_parts;

    #[test]
    fn applies_hint_only_to_binary_flagged_columns() {
        let names: Vec<String> = ["Data", "label", "n", "other"].map(String::from).to_vec();
        let metas = vec![
            from_parts("VARBINARY", ""),
            from_parts("VARBINARY", ""),
            from_parts("INT", ""),
            from_parts("BLOB", ""),
        ];
        let hint = BinaryHint::from([
            ("data".to_string(), true),
            ("label".to_string(), false),
            ("n".to_string(), false),
        ]);
        let applied = apply(&names, &metas, &hint);
        assert_eq!(applied[0].category, Category::Bytes);
        assert_eq!(applied[1].name, "VARCHAR");
        assert_eq!(applied[2], metas[2]);
        assert_eq!(applied[3].category, Category::MaybeText, "unknown column keeps fallback");
        assert!(has_maybe_text(&metas));
        assert!(!has_maybe_text(&applied[..3]));
    }
}
