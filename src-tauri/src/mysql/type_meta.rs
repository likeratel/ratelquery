//! Column type classification.
//!
//! `sqlx` exposes only the type *name* publicly. The display width (`M` in `BIT(M)`) and the
//! `NOT_NULL` flag are read from the `Debug` output of `MySqlTypeInfo`; if that format ever
//! changes, the parser degrades to "unknown width, nullable", which keeps BIT(1) as an int.
//!
//! MySQL sets the `BINARY` flag both for real binary strings (charset `binary`) and for text
//! with a `_bin` collation (including `JSON_UNQUOTE` / `->>` results). The collation id that
//! would tell them apart is not exposed by sqlx, so those columns are [`Category::MaybeText`]:
//! a value that is valid UTF-8 decodes as text, anything else as bytes, and a schema lookup
//! (see `binary_hint`) settles the column when its base table is known.

use sqlx::TypeInfo;
use sqlx::mysql::MySqlTypeInfo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Bool,
    SignedInt,
    UnsignedInt,
    Year,
    Float,
    Decimal,
    Date,
    Time,
    DateTime,
    Json,
    Bit,
    Bytes,
    /// A string type with the BINARY flag: binary charset or a `_bin` collation.
    MaybeText,
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeMeta {
    /// Upper-cased MySQL type name reported to the frontend.
    pub name: String,
    pub category: Category,
    pub max_size: Option<u32>,
    pub nullable: bool,
}

impl TypeMeta {
    pub fn from_type_info(info: &MySqlTypeInfo) -> TypeMeta {
        from_parts(info.name(), &format!("{info:?}"))
    }

    /// `BIT(1)` is reported as a boolean.
    pub fn is_single_bit(&self) -> bool {
        self.category == Category::Bit && self.max_size == Some(1)
    }

    /// The column is known to hold binary data (charset `binary`).
    pub fn as_binary(&self) -> TypeMeta {
        match self.category {
            Category::MaybeText => TypeMeta { category: Category::Bytes, ..self.clone() },
            _ => self.clone(),
        }
    }

    /// The column is known to hold text; the type name becomes the text equivalent.
    pub fn as_text(&self) -> TypeMeta {
        match (self.category, text_name(&self.name)) {
            (Category::MaybeText, Some(name)) => {
                TypeMeta { name: name.to_string(), category: Category::Text, ..self.clone() }
            }
            _ => self.clone(),
        }
    }
}

/// Text type with the same storage as a binary-flagged sqlx type name.
pub fn text_name(binary_name: &str) -> Option<&'static str> {
    Some(match binary_name {
        "BINARY" => "CHAR",
        "VARBINARY" => "VARCHAR",
        "TINYBLOB" => "TINYTEXT",
        "BLOB" => "TEXT",
        "MEDIUMBLOB" => "MEDIUMTEXT",
        "LONGBLOB" => "LONGTEXT",
        _ => return None,
    })
}

fn category_of(name: &str) -> Category {
    match name {
        "BOOLEAN" => Category::Bool,
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => Category::SignedInt,
        n if n.ends_with(" UNSIGNED") => Category::UnsignedInt,
        "YEAR" => Category::Year,
        "FLOAT" | "DOUBLE" => Category::Float,
        "DECIMAL" => Category::Decimal,
        "DATE" => Category::Date,
        "TIME" => Category::Time,
        "DATETIME" | "TIMESTAMP" => Category::DateTime,
        "JSON" => Category::Json,
        "BIT" => Category::Bit,
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            Category::MaybeText
        }
        "GEOMETRY" => Category::Bytes,
        _ => Category::Text,
    }
}

fn parse_max_size(debug: &str) -> Option<u32> {
    let rest = &debug[debug.find("max_size: Some(")? + "max_size: Some(".len()..];
    rest[..rest.find(')')?].trim().parse().ok()
}

fn has_flag(debug: &str, wanted: &str) -> bool {
    let Some(start) = debug.find("flags: ColumnFlags(") else {
        return false;
    };
    let rest = &debug[start + "flags: ColumnFlags(".len()..];
    let flags = rest.find(')').map(|end| &rest[..end]).unwrap_or("");
    flags.split('|').any(|flag| flag.trim() == wanted)
}

pub fn from_parts(sqlx_name: &str, debug: &str) -> TypeMeta {
    let category = category_of(sqlx_name);
    // sqlx calls TINYINT(1) "BOOLEAN" (signed or not); MySQL itself reports TINYINT.
    let name = match category {
        Category::Bool if has_flag(debug, "UNSIGNED") => "TINYINT UNSIGNED",
        Category::Bool => "TINYINT",
        _ => sqlx_name,
    };
    TypeMeta {
        name: name.to_string(),
        category,
        max_size: parse_max_size(debug),
        nullable: !has_flag(debug, "NOT_NULL"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIT1: &str =
        "MySqlTypeInfo { type: Bit, flags: ColumnFlags(NOT_NULL | UNSIGNED), max_size: Some(1) }";

    #[test]
    fn parses_width_and_not_null_from_debug() {
        let meta = from_parts("BIT", BIT1);
        assert_eq!(meta.max_size, Some(1));
        assert!(!meta.nullable);
        assert!(meta.is_single_bit());
    }

    #[test]
    fn unknown_debug_format_degrades_safely() {
        let meta = from_parts("BIT", "something else");
        assert_eq!(meta.max_size, None);
        assert!(meta.nullable);
        assert!(!meta.is_single_bit());
    }

    #[test]
    fn no_default_value_is_not_mistaken_for_not_null() {
        let debug =
            "MySqlTypeInfo { type: Long, flags: ColumnFlags(NO_DEFAULT_VALUE), max_size: None }";
        assert!(from_parts("INT", debug).nullable);
    }

    #[test]
    fn classifies_type_names() {
        assert_eq!(from_parts("BOOLEAN", "").category, Category::Bool);
        assert_eq!(from_parts("BOOLEAN", "").name, "TINYINT");
        assert_eq!(from_parts("BIGINT UNSIGNED", "").category, Category::UnsignedInt);
        assert_eq!(from_parts("INT", "").category, Category::SignedInt);
        assert_eq!(from_parts("DECIMAL", "").category, Category::Decimal);
        assert_eq!(from_parts("TIMESTAMP", "").category, Category::DateTime);
        assert_eq!(from_parts("MEDIUMBLOB", "").category, Category::MaybeText);
        assert_eq!(from_parts("GEOMETRY", "").category, Category::Bytes);
        assert_eq!(from_parts("MEDIUMTEXT", "").category, Category::Text);
        assert_eq!(from_parts("ENUM", "").category, Category::Text);
    }

    #[test]
    fn unsigned_tinyint1_keeps_unsigned_in_name() {
        let debug = "MySqlTypeInfo { type: Tiny, flags: ColumnFlags(UNSIGNED), max_size: Some(1) }";
        let meta = from_parts("BOOLEAN", debug);
        assert_eq!((meta.name.as_str(), meta.category), ("TINYINT UNSIGNED", Category::Bool));
    }

    #[test]
    fn maybe_text_settles_to_text_or_binary() {
        let meta = from_parts("LONGBLOB", "");
        assert_eq!(meta.as_text().name, "LONGTEXT");
        assert_eq!(meta.as_text().category, Category::Text);
        assert_eq!(meta.as_binary().name, "LONGBLOB");
        assert_eq!(meta.as_binary().category, Category::Bytes);
        let int = from_parts("INT", "");
        assert_eq!(int.as_text(), int);
        assert_eq!(text_name("VARBINARY"), Some("VARCHAR"));
        assert_eq!(text_name("GEOMETRY"), None);
    }
}
