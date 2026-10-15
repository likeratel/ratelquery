//! Lightweight statement analysis: which statements are safe to re-run after a lost connection,
//! and which single base table a simple `SELECT` reads from.
//!
//! This is a tokenizer, not a parser. It skips string literals and comments and only looks at
//! keywords at parenthesis depth 0, erring on the side of "not a read" and "unknown table".

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    /// Unquoted word, upper-cased, and its original text.
    Word(String, String),
    /// Backtick-quoted identifier, unescaped.
    Quoted(String),
    /// String literal (content is irrelevant here).
    Str,
    Punct(char),
}

fn skip_quoted(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if quote != b'`' => i += 2,
            b if b == quote => {
                if bytes.get(i + 1) == Some(&quote) {
                    i += 2;
                } else {
                    return i + 1;
                }
            }
            _ => i += 1,
        }
    }
    bytes.len()
}

fn skip_line(bytes: &[u8], start: usize) -> usize {
    bytes[start..].iter().position(|b| *b == b'\n').map_or(bytes.len(), |p| start + p + 1)
}

fn skip_block(bytes: &[u8], start: usize) -> usize {
    let mut i = start + 2;
    while i + 1 < bytes.len() {
        if bytes[i] == b'*' && bytes[i + 1] == b'/' {
            return i + 2;
        }
        i += 1;
    }
    bytes.len()
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

fn tokenize(sql: &str) -> Vec<Token> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'\'' | b'"' => {
                i = skip_quoted(bytes, i, b);
                tokens.push(Token::Str);
            }
            b'`' => {
                let end = skip_quoted(bytes, i, b'`');
                // `end` is past the closing backtick, or the end of an unterminated identifier.
                let closed = end > i + 1 && bytes.get(end - 1) == Some(&b'`');
                let inner = &sql[i + 1..if closed { end - 1 } else { end }];
                tokens.push(Token::Quoted(inner.replace("``", "`")));
                i = end;
            }
            b'#' => i = skip_line(bytes, i),
            b'-' if bytes.get(i + 1) == Some(&b'-')
                && bytes.get(i + 2).is_none_or(|c| c.is_ascii_whitespace()) =>
            {
                i = skip_line(bytes, i);
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = skip_block(bytes, i),
            b if is_word_byte(b) => {
                let start = i;
                while i < bytes.len() && is_word_byte(bytes[i]) {
                    i += 1;
                }
                tokens.push(Token::Word(
                    sql[start..i].to_ascii_uppercase(),
                    sql[start..i].to_string(),
                ));
            }
            b if b.is_ascii_whitespace() => i += 1,
            other => {
                tokens.push(Token::Punct(char::from(other)));
                i += 1;
            }
        }
    }
    tokens
}

fn is_word(token: Option<&Token>, word: &str) -> bool {
    matches!(token, Some(Token::Word(w, _)) if w == word)
}

const READ_STARTERS: [&str; 8] =
    ["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "WITH", "TABLE", "VALUES"];
const WRITE_KEYWORDS: [&str; 4] = ["INSERT", "UPDATE", "DELETE", "REPLACE"];

/// A write keyword used as a statement (not `FOR UPDATE` or the `INSERT()`/`REPLACE()`
/// string functions).
fn writes_at(tokens: &[Token], index: usize) -> bool {
    let Some(Token::Word(word, _)) = tokens.get(index) else { return false };
    if !WRITE_KEYWORDS.contains(&word.as_str()) {
        return false;
    }
    let is_call = tokens.get(index + 1) == Some(&Token::Punct('('));
    let for_update = word == "UPDATE" && index > 0 && is_word(tokens.get(index - 1), "FOR");
    !is_call && !for_update
}

fn writes_file(tokens: &[Token]) -> bool {
    tokens.windows(2).any(|pair| {
        is_word(pair.first(), "INTO")
            && (is_word(pair.get(1), "OUTFILE") || is_word(pair.get(1), "DUMPFILE"))
    })
}

/// True when re-running `statement` on a new connection cannot apply a change twice:
/// `SELECT`, `SHOW`, `EXPLAIN`, `DESCRIBE`/`DESC`, `WITH`, `TABLE` and `VALUES`, unless the text
/// also contains a data-changing statement (`WITH ... DELETE`, `EXPLAIN ANALYZE UPDATE`) or
/// writes a file (`SELECT ... INTO OUTFILE`).
pub fn is_read_statement(statement: &str) -> bool {
    let tokens = tokenize(statement);
    let first = tokens.iter().position(|t| *t != Token::Punct('('));
    let Some(Token::Word(starter, _)) = first.and_then(|i| tokens.get(i)) else { return false };
    if !READ_STARTERS.contains(&starter.as_str()) {
        return false;
    }
    if starter == "SHOW" {
        return true;
    }
    !(0..tokens.len()).any(|i| writes_at(&tokens, i)) && !writes_file(&tokens)
}

pub fn is_use_statement(statement: &str) -> bool {
    is_word(tokenize(statement).first(), "USE")
}

/// Table read by a single-table `SELECT ... FROM t` or `TABLE t`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseTable {
    pub database: Option<String>,
    pub table: String,
}

const CLAUSE_KEYWORDS: [&str; 8] =
    ["WHERE", "ORDER", "GROUP", "HAVING", "LIMIT", "WINDOW", "FOR", "LOCK"];
const MULTI_TABLE_KEYWORDS: [&str; 9] =
    ["JOIN", "STRAIGHT_JOIN", "UNION", "INTERSECT", "EXCEPT", "NATURAL", "CROSS", "INNER", "OUTER"];

fn identifier(token: Option<&Token>) -> Option<String> {
    match token? {
        Token::Quoted(name) => Some(name.clone()),
        Token::Word(upper, raw) if !CLAUSE_KEYWORDS.contains(&upper.as_str()) => Some(raw.clone()),
        _ => None,
    }
}

/// Parses `ident` or `ident.ident` starting at `index`; returns the table and the next index.
fn table_ref(tokens: &[Token], index: usize) -> Option<(BaseTable, usize)> {
    let first = identifier(tokens.get(index))?;
    if tokens.get(index + 1) == Some(&Token::Punct('.')) {
        let table = identifier(tokens.get(index + 2))?;
        return Some((BaseTable { database: Some(first), table }, index + 3));
    }
    Some((BaseTable { database: None, table: first }, index + 1))
}

/// Skips an optional `[AS] alias` after the table reference.
fn skip_alias(tokens: &[Token], index: usize) -> usize {
    let index = if is_word(tokens.get(index), "AS") { index + 1 } else { index };
    match tokens.get(index) {
        Some(Token::Quoted(_)) => index + 1,
        Some(Token::Word(w, _)) if !CLAUSE_KEYWORDS.contains(&w.as_str()) => index + 1,
        _ => index,
    }
}

fn top_level_from(tokens: &[Token]) -> Option<usize> {
    let mut depth = 0i32;
    for (i, token) in tokens.iter().enumerate() {
        match token {
            Token::Punct('(') => depth += 1,
            Token::Punct(')') => depth -= 1,
            Token::Word(w, _) if depth == 0 && w == "FROM" => return Some(i),
            Token::Word(w, _) if depth == 0 && MULTI_TABLE_KEYWORDS.contains(&w.as_str()) => {
                return None;
            }
            _ => {}
        }
    }
    None
}

fn has_multi_table_keyword(tokens: &[Token]) -> bool {
    let mut depth = 0i32;
    tokens.iter().any(|token| match token {
        Token::Punct('(') => {
            depth += 1;
            false
        }
        Token::Punct(')') => {
            depth -= 1;
            false
        }
        Token::Word(w, _) => depth == 0 && MULTI_TABLE_KEYWORDS.contains(&w.as_str()),
        _ => false,
    })
}

/// The single base table of a simple query, or `None` for joins, unions, derived tables and
/// anything else this tokenizer does not understand.
pub fn infer_base_table(statement: &str) -> Option<BaseTable> {
    let tokens = tokenize(statement);
    let start = match tokens.first() {
        Some(Token::Word(w, _)) if w == "TABLE" => 1,
        Some(Token::Word(w, _)) if w == "SELECT" => top_level_from(&tokens)? + 1,
        _ => return None,
    };
    if has_multi_table_keyword(&tokens) {
        return None;
    }
    let (table, next) = table_ref(&tokens, start)?;
    let after = skip_alias(&tokens, next);
    let ends_cleanly = match tokens.get(after) {
        None | Some(Token::Punct(';')) => true,
        Some(Token::Word(w, _)) => CLAUSE_KEYWORDS.contains(&w.as_str()),
        _ => false,
    };
    ends_cleanly.then_some(table)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(database: Option<&str>, name: &str) -> Option<BaseTable> {
        Some(BaseTable { database: database.map(str::to_string), table: name.to_string() })
    }

    #[test]
    fn read_statements_are_retryable() {
        for sql in [
            "SELECT 1",
            "  select * from t",
            "(SELECT 1) UNION (SELECT 2)",
            "SHOW TABLES",
            "EXPLAIN SELECT 1",
            "DESCRIBE t",
            "desc t",
            "WITH c AS (SELECT 1) SELECT * FROM c",
            "TABLE t",
            "VALUES ROW(1, 2)",
            "SELECT * FROM t FOR UPDATE",
            "SELECT REPLACE(name, 'a', 'b'), INSERT('abc', 1, 1, 'x') FROM t",
            "SELECT 'delete from t' AS s",
            "/* note */ SELECT 1",
        ] {
            assert!(is_read_statement(sql), "{sql}");
        }
    }

    #[test]
    fn write_statements_are_not_retryable() {
        for sql in [
            "UPDATE t SET a = 1",
            "INSERT INTO t VALUES (1)",
            "DELETE FROM t",
            "REPLACE INTO t VALUES (1)",
            "DO SLEEP(1)",
            "CALL p()",
            "CREATE TABLE x (a INT)",
            "SET @a = 1",
            "WITH c AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM c)",
            "EXPLAIN ANALYZE UPDATE t SET a = 1",
            "SELECT * FROM t INTO OUTFILE '/tmp/x'",
            "",
            "-- only a comment",
        ] {
            assert!(!is_read_statement(sql), "{sql}");
        }
    }

    #[test]
    fn unterminated_quotes_do_not_panic() {
        assert!(is_read_statement("SELECT `한글"));
        assert!(is_read_statement("SELECT '한글"));
        assert_eq!(
            infer_base_table("SELECT * FROM `표"),
            Some(BaseTable { database: None, table: "표".into() })
        );
    }

    #[test]
    fn detects_use_statements() {
        assert!(is_use_statement("use sample"));
        assert!(is_use_statement("USE\n`x`"));
        assert!(!is_use_statement("user_table"));
        assert!(!is_use_statement("SELECT 1"));
    }

    #[test]
    fn infers_single_base_table() {
        assert_eq!(infer_base_table("SELECT * FROM files"), table(None, "files"));
        assert_eq!(infer_base_table("select a FROM `Files` f WHERE a = 1"), table(None, "Files"));
        assert_eq!(
            infer_base_table("SELECT a FROM Sample.Docs AS d"),
            table(Some("Sample"), "Docs")
        );
        assert_eq!(infer_base_table("SELECT a FROM `we``ird` LIMIT 1;"), table(None, "we`ird"));
        assert_eq!(
            infer_base_table("SELECT (SELECT 1 FROM u), a FROM t ORDER BY a, b"),
            table(None, "t")
        );
        assert_eq!(infer_base_table("TABLE t"), table(None, "t"));
    }

    #[test]
    fn rejects_multi_table_and_unknown_shapes() {
        for sql in [
            "SELECT * FROM a JOIN b ON a.id = b.id",
            "SELECT * FROM a, b",
            "SELECT * FROM (SELECT 1) x",
            "SELECT 1",
            "SELECT * FROM a UNION SELECT * FROM b",
            "UPDATE t SET a = 1",
            "SELECT * FROM t PARTITION (p0)",
        ] {
            assert_eq!(infer_base_table(sql), None, "{sql}");
        }
    }
}
