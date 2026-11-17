//! MySQL literals for values that are otherwise bound: the statement preview shows what will
//! run, and the trash backup `SELECT` runs over the text protocol so its rows decode exactly like
//! a query result.
//!
//! Strings are always quoted with `'` and an embedded `'` is doubled, which works in every SQL
//! mode. With backslash escapes on (the default, no `NO_BACKSLASH_ESCAPES` in `sql_mode`) the
//! backslash and the control characters MySQL treats specially are escaped too.
//!
//! That is only sound when the server reads the statement in a character set where the bytes of
//! `'`, `\` and `` ` `` (0x27, 0x5C, 0x60) are always those characters and never the trailing
//! byte of a multi-byte character. sqlx connects with utf8mb4, but a session can switch with
//! `SET NAMES` (e.g. to gbk or sjis, where 0x5C can end a character and swallow an escape), so
//! callers check [`is_literal_safe_charset`] for the session first.

use std::fmt::Write;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

use super::bind::{BindValue, to_bind_value};
use super::cell::Cell;
use crate::error::{AppError, AppResult};

/// The `sql_mode` flag that turns backslash into an ordinary character inside strings.
pub const NO_BACKSLASH_ESCAPES: &str = "NO_BACKSLASH_ESCAPES";

/// Character sets in which every byte below 0x80 is the ASCII character and multi-byte
/// sequences only use bytes from 0x80 up: UTF-8 (lead and continuation bytes are 0xC2-0xF4 and
/// 0x80-0xBF), and the single-byte latin1, ascii and binary. Anything else (gbk, big5, sjis,
/// cp932, gb18030, ucs2, utf16, ...) is treated as unsafe.
const LITERAL_SAFE_CHARSETS: [&str; 6] =
    ["utf8mb4", "utf8mb3", "utf8", "latin1", "ascii", "binary"];

/// Whether literals built here are read back exactly in the character set `name`.
pub fn is_literal_safe_charset(name: &str) -> bool {
    LITERAL_SAFE_CHARSETS.iter().any(|safe| name.trim().eq_ignore_ascii_case(safe))
}

/// Whether strings need backslash escaping under `sql_mode` (a comma separated flag list).
pub fn backslash_escapes(sql_mode: &str) -> bool {
    !sql_mode.split(',').any(|flag| flag.trim().eq_ignore_ascii_case(NO_BACKSLASH_ESCAPES))
}

/// `'text'` with `'` doubled and, when `backslash_escapes`, `\`, NUL, newline, carriage return
/// and Ctrl-Z escaped.
pub fn string_literal(text: &str, backslash_escapes: bool) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for ch in text.chars() {
        match ch {
            '\'' => out.push_str("''"),
            '\\' if backslash_escapes => out.push_str("\\\\"),
            '\0' if backslash_escapes => out.push_str("\\0"),
            '\n' if backslash_escapes => out.push_str("\\n"),
            '\r' if backslash_escapes => out.push_str("\\r"),
            '\u{1a}' if backslash_escapes => out.push_str("\\Z"),
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

/// `X'00ff'`; valid in every SQL mode.
pub fn bytes_literal(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2 + 3);
    out.push_str("X'");
    for byte in bytes {
        // Writing to a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out.push('\'');
    out
}

/// A finite double in exponent form, so MySQL reads it as an approximate (DOUBLE) value just
/// like a bound `f64`, with the shortest digits that round-trip.
fn float_literal(value: f64) -> AppResult<String> {
    if value.is_finite() {
        Ok(format!("{value:e}"))
    } else {
        Err(AppError::InvalidInput(format!("{value} is not a finite number")))
    }
}

/// The literal MySQL receives in place of a bound value: text is a quoted string, as it is sent
/// as a string parameter.
pub fn bind_literal(value: &BindValue, backslash_escapes: bool) -> AppResult<String> {
    Ok(match value {
        BindValue::Null => "NULL".to_string(),
        BindValue::Text(text) => string_literal(text, backslash_escapes),
        BindValue::Signed(v) => v.to_string(),
        BindValue::Unsigned(v) => v.to_string(),
        BindValue::Float(v) => float_literal(*v)?,
        BindValue::Bool(true) => "TRUE".to_string(),
        BindValue::Bool(false) => "FALSE".to_string(),
        BindValue::Bytes(bytes) => bytes_literal(bytes),
    })
}

/// `-?digits(.digits)?`, the form the server returns DECIMAL values in.
fn is_decimal_text(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    let all_digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    all_digits(whole) && fraction.is_none_or(all_digits)
}

/// A cell as a MySQL literal: integers and decimals unquoted after checking their form, floats
/// in exponent form, booleans as `TRUE` / `FALSE`, bytes as `X'..'`, everything else quoted.
pub fn cell_literal(cell: &Cell, backslash_escapes: bool) -> AppResult<String> {
    match cell {
        Cell::Decimal(text) if is_decimal_text(text) => Ok(text.clone()),
        Cell::Decimal(text) => {
            Err(AppError::InvalidInput(format!("{text:?} is not a decimal number")))
        }
        Cell::Bytes(encoded) => BASE64
            .decode(encoded)
            .map(|bytes| bytes_literal(&bytes))
            .map_err(|e| AppError::InvalidInput(format!("invalid base64 bytes value: {e}"))),
        other => bind_literal(&to_bind_value(other)?, backslash_escapes),
    }
}

/// `sql` with the `?` at each byte offset of `placeholders` replaced by the literal of the bind
/// at the same position. The offsets come from the statement builder, so a `?` inside a quoted
/// identifier is never mistaken for a placeholder.
pub fn inline_binds(
    sql: &str,
    placeholders: &[usize],
    binds: &[BindValue],
    backslash_escapes: bool,
) -> AppResult<String> {
    if placeholders.len() != binds.len() {
        return Err(AppError::Query(format!(
            "internal error: {} placeholders for {} values",
            placeholders.len(),
            binds.len()
        )));
    }
    let mut out = String::with_capacity(sql.len());
    let mut copied = 0;
    for (&at, bind) in placeholders.iter().zip(binds) {
        if at < copied || sql.get(at..at + 1) != Some("?") {
            return Err(AppError::Query(format!(
                "internal error: no placeholder at offset {at} of the statement"
            )));
        }
        out.push_str(&sql[copied..at]);
        out.push_str(&bind_literal(bind, backslash_escapes)?);
        copied = at + 1;
    }
    out.push_str(&sql[copied..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_no_backslash_escapes_from_sql_mode() {
        assert!(backslash_escapes(""));
        assert!(backslash_escapes("STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY"));
        assert!(!backslash_escapes("STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES"));
        assert!(!backslash_escapes("no_backslash_escapes"));
        assert!(backslash_escapes("NO_BACKSLASH_ESCAPES_X"), "only the exact flag counts");
    }

    #[test]
    fn only_ascii_safe_charsets_are_accepted() {
        for safe in ["utf8mb4", "UTF8MB4", "utf8mb3", "utf8", "latin1", "ascii", "binary"] {
            assert!(is_literal_safe_charset(safe), "{safe}");
        }
        for unsafe_set in ["gbk", "big5", "sjis", "cp932", "gb18030", "ucs2", "utf16", "", "x"] {
            assert!(!is_literal_safe_charset(unsafe_set), "{unsafe_set}");
        }
    }

    #[test]
    fn quotes_strings_for_both_modes() {
        assert_eq!(string_literal("plain", true), "'plain'");
        assert_eq!(string_literal("it's", true), "'it''s'");
        assert_eq!(string_literal("it's", false), "'it''s'");
        assert_eq!(string_literal(r"a\b", true), r"'a\\b'");
        assert_eq!(string_literal(r"a\b", false), r"'a\b'");
        assert_eq!(string_literal("a\0b\nc\rd\u{1a}", true), r"'a\0b\nc\rd\Z'");
        assert_eq!(string_literal("a\0b\nc", false), "'a\0b\nc'");
        assert_eq!(string_literal("", true), "''");
        assert_eq!(string_literal("한글 ✓", true), "'한글 ✓'");
    }

    #[test]
    fn injection_attempts_stay_inside_the_literal() {
        let attacks = [
            "'; DROP TABLE users; --",
            r"\'; DROP TABLE users; --",
            r"\\'; DROP TABLE users; --",
            "' OR '1'='1",
            "\\",
            "'",
            r"\'",
            "x\\",
        ];
        for attack in attacks {
            for escapes in [true, false] {
                let literal = string_literal(attack, escapes);
                assert_eq!(unquote(&literal, escapes), attack, "{attack:?} escapes={escapes}");
            }
        }
    }

    /// A model of how MySQL reads a single-quoted literal: returns the value and asserts the
    /// literal ends exactly at its last character.
    fn unquote(literal: &str, escapes: bool) -> String {
        let inner: Vec<char> = literal.chars().collect();
        assert_eq!(inner.first(), Some(&'\''));
        let mut out = String::new();
        let mut i = 1;
        loop {
            match inner.get(i) {
                None => panic!("unterminated literal {literal:?}"),
                Some('\'') if inner.get(i + 1) == Some(&'\'') => {
                    out.push('\'');
                    i += 2;
                }
                Some('\'') => {
                    assert_eq!(i, inner.len() - 1, "literal {literal:?} ends early");
                    return out;
                }
                Some('\\') if escapes => {
                    let next = inner.get(i + 1).copied().expect("dangling backslash");
                    out.push(match next {
                        '0' => '\0',
                        'n' => '\n',
                        'r' => '\r',
                        'Z' => '\u{1a}',
                        other => other,
                    });
                    i += 2;
                }
                Some(&c) => {
                    out.push(c);
                    i += 1;
                }
            }
        }
    }

    #[test]
    fn formats_cells() {
        let lit = |cell: Cell| cell_literal(&cell, true).unwrap();
        assert_eq!(lit(Cell::Null), "NULL");
        assert_eq!(lit(Cell::Int("-42".into())), "-42");
        assert_eq!(lit(Cell::Int("18446744073709551615".into())), "18446744073709551615");
        assert_eq!(
            lit(Cell::Decimal("-12345678901234567890.120".into())),
            "-12345678901234567890.120"
        );
        assert_eq!(lit(Cell::Decimal("7".into())), "7");
        assert_eq!(lit(Cell::Float(1.5)), "1.5e0");
        assert_eq!(lit(Cell::Float(-0.1)), "-1e-1");
        assert_eq!(lit(Cell::Float(1e300)), "1e300");
        assert_eq!(lit(Cell::Bool(true)), "TRUE");
        assert_eq!(lit(Cell::Bool(false)), "FALSE");
        assert_eq!(lit(Cell::Str("O'Brien".into())), "'O''Brien'");
        assert_eq!(lit(Cell::Date("2024-01-02".into())), "'2024-01-02'");
        assert_eq!(lit(Cell::Time("-01:00:00".into())), "'-01:00:00'");
        assert_eq!(
            lit(Cell::Datetime("2024-01-02 03:04:05.678".into())),
            "'2024-01-02 03:04:05.678'"
        );
        assert_eq!(lit(Cell::Json(r#"{"a":"b'c\\d"}"#.into())), r#"'{"a":"b''c\\\\d"}'"#);
        assert_eq!(lit(Cell::Bytes("AP8Q".into())), "X'00ff10'");
        assert_eq!(lit(Cell::Bytes(String::new())), "X''");
    }

    #[test]
    fn rejects_malformed_numbers_and_bytes() {
        for bad in [
            Cell::Int("1; DROP TABLE t".into()),
            Cell::Int("1.5".into()),
            Cell::Decimal("1e5".into()),
            Cell::Decimal("1.2.3".into()),
            Cell::Decimal("1; DROP TABLE t".into()),
            Cell::Decimal("".into()),
            Cell::Decimal("-".into()),
            Cell::Decimal(".5".into()),
            Cell::Float(f64::NAN),
            Cell::Float(f64::INFINITY),
            Cell::Bytes("***".into()),
        ] {
            assert_eq!(cell_literal(&bad, true).unwrap_err().kind(), "invalid_input", "{bad:?}");
        }
    }

    #[test]
    fn bind_literals_match_what_is_bound() {
        let lit = |v: BindValue| bind_literal(&v, true).unwrap();
        assert_eq!(lit(BindValue::Text("1.50".into())), "'1.50'", "decimals are bound as text");
        assert_eq!(lit(BindValue::Signed(i64::MIN)), "-9223372036854775808");
        assert_eq!(lit(BindValue::Unsigned(u64::MAX)), "18446744073709551615");
        assert_eq!(lit(BindValue::Bytes(vec![0xde, 0xad])), "X'dead'");
        assert_eq!(lit(BindValue::Null), "NULL");
        assert_eq!(
            bind_literal(&BindValue::Float(f64::NAN), true).unwrap_err().kind(),
            "invalid_input"
        );
    }

    #[test]
    fn inlines_binds_at_the_given_offsets_only() {
        let sql = "UPDATE `a?b` SET `c` = ? WHERE `?` <=> ?";
        let marks = vec![sql.find("= ?").unwrap() + 2, sql.len() - 1];
        let binds = vec![BindValue::Text("x?'y".into()), BindValue::Signed(1)];
        assert_eq!(
            inline_binds(sql, &marks, &binds, true).unwrap(),
            "UPDATE `a?b` SET `c` = 'x?''y' WHERE `?` <=> 1"
        );
        assert_eq!(inline_binds("SELECT 1", &[], &[], true).unwrap(), "SELECT 1");
    }

    #[test]
    fn inline_rejects_inconsistent_placeholders() {
        let one = [BindValue::Null];
        assert!(inline_binds("SELECT ?", &[], &one, true).is_err());
        assert!(inline_binds("SELECT ?", &[0], &one, true).is_err(), "offset 0 is not a ?");
        assert!(inline_binds("SELECT ?", &[99], &one, true).is_err());
        let two = [BindValue::Null, BindValue::Null];
        assert!(inline_binds("SELECT ?, ?", &[10, 7], &two, true).is_err(), "out of order");
    }
}
