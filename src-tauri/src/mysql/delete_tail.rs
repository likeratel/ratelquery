//! The part of a single-table DELETE after its table: which clauses it may have, and whether the
//! rows it picks could differ between the backup `SELECT` and the DELETE.

use super::classify::{Spanned, Token};

/// Top-level words that make the tail something other than `WHERE / ORDER BY / LIMIT n`.
const FORBIDDEN_TOP: [&str; 12] = [
    "INTO",
    "UNION",
    "EXCEPT",
    "INTERSECT",
    "GROUP",
    "HAVING",
    "WINDOW",
    "PROCEDURE",
    "FOR",
    "LOCK",
    "OFFSET",
    "RETURNING",
];
/// Words refused anywhere: a backup query must never write a file.
const FORBIDDEN_ANYWHERE: [&str; 2] = ["OUTFILE", "DUMPFILE"];

/// Called with `(`, these give another value each time they run but change nothing.
/// (`LAST_INSERT_ID(expr)` sets the value, so it is not here: any call to it is refused.)
const NONDETERMINISTIC_CALLS: [&str; 20] = [
    "NOW",
    "SYSDATE",
    "CURRENT_TIMESTAMP",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "LOCALTIME",
    "LOCALTIMESTAMP",
    "UTC_DATE",
    "UTC_TIME",
    "UTC_TIMESTAMP",
    "UNIX_TIMESTAMP",
    "CURDATE",
    "CURTIME",
    "ROW_COUNT",
    "FOUND_ROWS",
    "CONNECTION_ID",
    "RANDOM_BYTES",
    "RAND",
    "UUID",
    "UUID_SHORT",
];
/// The same functions written without parentheses.
const NONDETERMINISTIC_WORDS: [&str; 8] = [
    "CURRENT_TIMESTAMP",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "LOCALTIME",
    "LOCALTIMESTAMP",
    "UTC_DATE",
    "UTC_TIME",
    "UTC_TIMESTAMP",
];
/// Built-in functions and keywords that may be followed by `(`, always give the same value for
/// the same row and change nothing. Any other call (a stored function, or a built-in with side
/// effects such as SLEEP, GET_LOCK or BENCHMARK) would run twice, once for the backup.
const DETERMINISTIC_CALLS: &[&str] = &[
    // Aggregates (in subqueries) and full-text search.
    "COUNT",
    "SUM",
    "MIN",
    "MAX",
    "AVG",
    "GROUP_CONCAT",
    "BIT_AND",
    "BIT_OR",
    "BIT_XOR",
    "STD",
    "STDDEV",
    "STDDEV_POP",
    "STDDEV_SAMP",
    "VARIANCE",
    "VAR_POP",
    "VAR_SAMP",
    "JSON_ARRAYAGG",
    "JSON_OBJECTAGG",
    "MATCH",
    // Dates, strings, JSON and network addresses.
    "FROM_UNIXTIME",
    "TO_DAYS",
    "FROM_DAYS",
    "TO_SECONDS",
    "TIMESTAMP",
    "WEEK",
    "WEEKOFYEAR",
    "QUARTER",
    "YEARWEEK",
    "CONVERT_TZ",
    "TIME_FORMAT",
    "TIME_TO_SEC",
    "SEC_TO_TIME",
    "MAKEDATE",
    "MAKETIME",
    "PERIOD_ADD",
    "PERIOD_DIFF",
    "DAYNAME",
    "MONTHNAME",
    "MICROSECOND",
    "SUBSTRING_INDEX",
    "STRCMP",
    "SOUNDEX",
    "SPACE",
    "REPEAT",
    "INSERT",
    "ELT",
    "EXPORT_SET",
    "MAKE_SET",
    "QUOTE",
    "BIN",
    "OCT",
    "CONV",
    "ORD",
    "CHAR_LENGTH",
    "LN",
    "LOG",
    "LOG2",
    "LOG10",
    "EXP",
    "PI",
    "DEGREES",
    "RADIANS",
    "SIN",
    "COS",
    "TAN",
    "ASIN",
    "ACOS",
    "ATAN",
    "ATAN2",
    "COT",
    "CRC32",
    "TO_BASE64",
    "FROM_BASE64",
    "REGEXP_LIKE",
    "REGEXP_INSTR",
    "REGEXP_REPLACE",
    "REGEXP_SUBSTR",
    "JSON_OVERLAPS",
    "JSON_SEARCH",
    "JSON_KEYS",
    "JSON_DEPTH",
    "JSON_VALID",
    "JSON_QUOTE",
    "JSON_OBJECT",
    "JSON_ARRAY",
    "JSON_SET",
    "JSON_INSERT",
    "JSON_REMOVE",
    "JSON_MERGE_PATCH",
    "JSON_MERGE_PRESERVE",
    "JSON_PRETTY",
    "INET_ATON",
    "INET_NTOA",
    "INET6_ATON",
    "INET6_NTOA",
    "IS_IPV4",
    "IS_IPV6",
    "IS_UUID",
    "BIN_TO_UUID",
    "UUID_TO_BIN",
    "IN",
    "EXISTS",
    "NOT",
    "AND",
    "OR",
    "XOR",
    "ROW",
    "ANY",
    "SOME",
    "ALL",
    "OF",
    "IS",
    "INTERVAL",
    "BINARY",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "LIKE",
    "REGEXP",
    "RLIKE",
    "BETWEEN",
    "ABS",
    "CEIL",
    "CEILING",
    "FLOOR",
    "ROUND",
    "TRUNCATE",
    "MOD",
    "POW",
    "POWER",
    "SQRT",
    "SIGN",
    "LENGTH",
    "CHAR_LENGTH",
    "CHARACTER_LENGTH",
    "OCTET_LENGTH",
    "BIT_LENGTH",
    "LOWER",
    "UPPER",
    "LCASE",
    "UCASE",
    "TRIM",
    "LTRIM",
    "RTRIM",
    "SUBSTRING",
    "SUBSTR",
    "MID",
    "LEFT",
    "RIGHT",
    "CONCAT",
    "CONCAT_WS",
    "REPLACE",
    "LOCATE",
    "INSTR",
    "POSITION",
    "LPAD",
    "RPAD",
    "REVERSE",
    "HEX",
    "UNHEX",
    "MD5",
    "SHA1",
    "SHA2",
    "CRC32",
    "COALESCE",
    "IFNULL",
    "NULLIF",
    "IF",
    "ISNULL",
    "GREATEST",
    "LEAST",
    "CAST",
    "CONVERT",
    "DATE",
    "TIME",
    "YEAR",
    "MONTH",
    "DAY",
    "DAYOFMONTH",
    "HOUR",
    "MINUTE",
    "SECOND",
    "DATE_ADD",
    "DATE_SUB",
    "ADDDATE",
    "SUBDATE",
    "DATEDIFF",
    "TIMESTAMPDIFF",
    "TIMESTAMPADD",
    "DATE_FORMAT",
    "STR_TO_DATE",
    "EXTRACT",
    "WEEKDAY",
    "DAYOFWEEK",
    "DAYOFYEAR",
    "LAST_DAY",
    "JSON_EXTRACT",
    "JSON_UNQUOTE",
    "JSON_CONTAINS",
    "JSON_LENGTH",
    "JSON_TYPE",
    "JSON_VALUE",
    "JSON_CONTAINS_PATH",
    "FIELD",
    "FIND_IN_SET",
    "ASCII",
];

/// What the tail of a supported DELETE holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailInfo {
    /// `LIMIT n` of the DELETE, if it has one.
    pub limit: Option<u64>,
    /// Why the rows read first may differ from the rows deleted, when there is a reason. With a
    /// primary key the deleted keys are checked afterwards; without one the delete is stopped.
    pub needs_key: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Clause {
    Start,
    Where,
    Order,
}

fn word(token: Option<&Spanned>) -> Option<&str> {
    match token.map(|s| &s.token) {
        Some(Token::Word(w, _)) => Some(w.as_str()),
        _ => None,
    }
}

fn number(token: Option<&Spanned>) -> Option<u64> {
    match token.map(|s| &s.token) {
        Some(Token::Word(_, raw)) => raw.parse().ok(),
        _ => None,
    }
}

/// Checks that `tokens` (the tail, starting at WHERE, ORDER or LIMIT) is only
/// `[WHERE ...] [ORDER BY ...] [LIMIT n]`. `Err` with the reason otherwise.
fn check_clauses(tokens: &[Spanned]) -> Result<Option<u64>, String> {
    let shape = |what: &str| Err(format!("this DELETE has {what}, which can't be backed up"));
    if let Some(w) = tokens.iter().find_map(|t| match &t.token {
        Token::Word(w, _) if FORBIDDEN_ANYWHERE.contains(&w.as_str()) => Some(w),
        _ => None,
    }) {
        return shape(&format!("INTO {w}"));
    }
    let mut depth = 0i32;
    for token in tokens {
        match &token.token {
            Token::Punct('(') => depth += 1,
            Token::Punct(')') if depth == 0 => return shape("an unbalanced parenthesis"),
            Token::Punct(')') => depth -= 1,
            Token::Word(w, _) if depth == 0 && FORBIDDEN_TOP.contains(&w.as_str()) => {
                return shape(w);
            }
            _ => {}
        }
    }
    if depth != 0 {
        return shape("an unbalanced parenthesis");
    }
    let mut depth = 0i32;
    let mut clause = Clause::Start;
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        match &token.token {
            Token::Punct('(') => depth += 1,
            Token::Punct(')') => depth -= 1,
            Token::Punct(';') if depth == 0 => return shape("a second statement"),
            Token::Word(w, _) if depth == 0 => match w.as_str() {
                "WHERE" if clause == Clause::Start && i == 0 => clause = Clause::Where,
                "ORDER" if clause < Clause::Order && word(tokens.get(i + 1)) == Some("BY") => {
                    clause = Clause::Order;
                    i += 1;
                }
                "LIMIT" => {
                    let Some(limit) = number(tokens.get(i + 1)) else {
                        return shape("a LIMIT that is not one number");
                    };
                    if tokens.len() > i + 2 {
                        return shape("something after LIMIT");
                    }
                    return Ok(Some(limit));
                }
                _ if i == 0 => return shape("an unexpected clause"),
                "WHERE" | "ORDER" => return shape("clauses out of order"),
                _ => {}
            },
            _ => {}
        }
        i += 1;
    }
    Ok(None)
}

/// The first reason the backup query and the DELETE could pick other rows, if any.
fn row_choice_reason(tokens: &[Spanned], limit: Option<u64>) -> Option<String> {
    for (i, token) in tokens.iter().enumerate() {
        let called = tokens.get(i + 1).map(|s| &s.token) == Some(&Token::Punct('('));
        match &token.token {
            Token::Punct('@') => return Some("it uses a variable".into()),
            Token::Word(w, _) if w == "SELECT" => return Some("it has a subquery".into()),
            Token::Word(w, _) if called && NONDETERMINISTIC_CALLS.contains(&w.as_str()) => {
                return Some(format!("it uses {w}(), which changes between runs"));
            }
            Token::Word(w, _) if !called && NONDETERMINISTIC_WORDS.contains(&w.as_str()) => {
                return Some(format!("it uses {w}, which changes between runs"));
            }
            _ => {}
        }
    }
    limit.map(|_| "it has a LIMIT".to_string())
}

/// Keywords that may stand right before a parenthesis without calling anything.
/// Clause and operator words, and the type names of `CAST(x AS CHAR(10))` / `CONVERT(x, DECIMAL(5,2))`.
const KEYWORDS_BEFORE_PAREN: &[&str] = &[
    "WHERE", "BY", "ASC", "DESC", "AS", "DISTINCT", "ESCAPE", "DIV", "MEMBER", "NULL", "FROM",
    "ON", "USING", "SELECT", "JOIN", "HAVING", "AGAINST", "OVER", "VALUES", "LIMIT", "IN",
    "EXISTS", "AND", "OR", "NOT", "XOR", "ALL", "ANY", "SOME", "UNION", "WITH", "LATERAL", "CHAR",
    "VARCHAR", "NCHAR", "BINARY", "DECIMAL", "SIGNED", "UNSIGNED", "INTEGER", "DATE", "DATETIME",
    "TIME", "FLOAT", "DOUBLE", "REAL", "JSON", "YEAR",
];

/// A call that would run again for the backup query: a stored function or a built-in with side
/// effects. `Err` with the reason.
fn check_calls(tokens: &[Spanned]) -> Result<(), String> {
    let refuse = |name: &str| {
        Err(format!(
            "it calls {name}(), which could be a stored function or have side effects, and the \
             backup would run it a second time"
        ))
    };
    for (i, token) in tokens.iter().enumerate() {
        // `@a := 1` assigns while the backup reads and again while the DELETE runs.
        if token.token == Token::Punct(':')
            && tokens.get(i + 1).map(|s| &s.token) == Some(&Token::Punct('='))
        {
            return Err("it assigns a variable with :=, which would run twice".into());
        }
        if tokens.get(i + 1).map(|s| &s.token) != Some(&Token::Punct('(')) {
            continue;
        }
        // `db.f(x)` (or `db.LOWER(x)`) calls a stored function of that schema.
        let qualified = i > 0 && tokens[i - 1].token == Token::Punct('.');
        match &token.token {
            Token::Word(_, raw) if qualified => return refuse(raw),
            Token::Word(w, raw)
                if !DETERMINISTIC_CALLS.contains(&w.as_str())
                    && !NONDETERMINISTIC_CALLS.contains(&w.as_str())
                    && !KEYWORDS_BEFORE_PAREN.contains(&w.as_str()) =>
            {
                return refuse(raw);
            }
            Token::Quoted(name) => return refuse(&format!("`{name}`")),
            _ => {}
        }
    }
    Ok(())
}

/// Validates the tail and says what it holds. `Err` with the reason when it can't be backed up.
pub fn analyze_tail(tokens: &[Spanned]) -> Result<TailInfo, String> {
    let limit = check_clauses(tokens)?;
    check_calls(tokens)?;
    Ok(TailInfo { limit, needs_key: row_choice_reason(tokens, limit) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mysql::classify::tokenize_spans;

    fn info(tail: &str) -> Result<TailInfo, String> {
        analyze_tail(&tokenize_spans(tail))
    }

    #[test]
    fn accepts_where_order_and_one_limit() {
        for tail in [
            "WHERE a = 1",
            "WHERE a IN (1, 2) AND (b > 0 OR c IS NULL) ORDER BY a DESC, b LIMIT 5",
            "ORDER BY id LIMIT 10",
            "LIMIT 3",
            "WHERE name LIKE 'x%' AND d BETWEEN '2024-01-01' AND '2024-02-01'",
            "WHERE uuid = 'a' AND rand > 1",
        ] {
            assert!(info(tail).is_ok(), "{tail}");
        }
        assert_eq!(info("WHERE a = 1 LIMIT 7").unwrap().limit, Some(7));
        assert_eq!(info("WHERE a = 1").unwrap(), TailInfo { limit: None, needs_key: None });
    }

    #[test]
    fn refuses_other_clauses_and_files() {
        for tail in [
            "WHERE a = 1 GROUP BY a",
            "WHERE a = 1 HAVING a > 0",
            "WHERE a = 1 UNION SELECT 1",
            "WHERE a = 1 INTO OUTFILE '/tmp/x'",
            "WHERE a IN (SELECT b FROM s INTO DUMPFILE '/tmp/y')",
            "WHERE a = 1 FOR UPDATE",
            "WHERE a = 1 LOCK IN SHARE MODE",
            "LIMIT 1, 2",
            "LIMIT 10 OFFSET 5",
            "LIMIT x",
            "ORDER BY a WHERE b = 1",
            "WHERE a = 1 WHERE b = 2",
            "WHERE a = 1 WINDOW w AS ()",
            "WHERE a = 1 PROCEDURE ANALYSE()",
            "WHERE a = 1 RETURNING *",
            "ORDER a",
            "WHERE (a = 1",
            "WHERE a = 1)",
            "WHERE a = 1) OR (b = 2",
            "WHERE my_fn(a) = 1",
            "WHERE db.f(a) = 1",
            "WHERE `f`(a) = 1",
            "WHERE SLEEP(1) = 0",
            "WHERE GET_LOCK('x', 1) = 1",
            "WHERE BENCHMARK(10, MD5('a')) = 0",
            "WHERE db.LOWER(a) = 'x'",
            "WHERE `db`.COUNT(x) = 1",
            "WHERE db . MD5 (x) = 'y'",
            "WHERE LAST_INSERT_ID(id) > 0",
            "WHERE (@a := @a + 1) < 3",
        ] {
            assert!(info(tail).is_err(), "{tail}");
        }
        assert!(info("WHERE my_fn(a) = 1").unwrap_err().contains("side effects"));
    }

    #[test]
    fn finds_reasons_the_rows_could_differ() {
        let reason = |tail: &str| info(tail).unwrap().needs_key.unwrap_or_default();
        assert!(reason("WHERE id IN (SELECT id FROM s)").contains("subquery"));
        assert!(reason("WHERE created < NOW()").contains("NOW()"));
        assert!(reason("WHERE created < CURRENT_TIMESTAMP").contains("CURRENT_TIMESTAMP"));
        assert!(reason("WHERE id = @x").contains("variable"));
        assert!(reason("WHERE RAND() < 0.5").contains("RAND()"));
        assert!(reason("ORDER BY id LIMIT 10").contains("LIMIT"));
        assert_eq!(info("WHERE uuid = 'a' AND rand > 1").unwrap().needs_key, None);
        assert_eq!(info("WHERE LOWER(name) = 'a' AND id IN (1, 2)").unwrap().needs_key, None);
        assert_eq!(info("WHERE (a = 1) ORDER BY (b) DESC").unwrap().needs_key, None);
    }

    #[test]
    fn common_subqueries_and_built_ins_are_allowed() {
        for tail in [
            "WHERE id NOT IN (SELECT MIN(id) FROM u GROUP BY email)",
            "WHERE (SELECT COUNT(*) FROM u WHERE u.t = t.id) = 0",
            "WHERE id IN (SELECT id FROM (SELECT id FROM u) x)",
            "WHERE id IN (SELECT a.id FROM a JOIN b ON (a.k = b.k) HAVING (COUNT(*) > 1))",
            "WHERE EXISTS (SELECT 1 FROM u WHERE u.id = t.id)",
            "WHERE CAST(a AS CHAR(10)) = 'x' AND CONVERT(b, DECIMAL(5, 2)) > 1",
            "WHERE MATCH(body) AGAINST('word') AND (a IN (1) OR NOT (b = 2))",
            "WHERE FROM_UNIXTIME(ts) < '2024-01-01' AND TO_DAYS(d) > 1 AND WEEK(d) = 2",
            "WHERE SUBSTRING_INDEX(email, '@', -1) = 'x' AND JSON_OVERLAPS(tags, '[1]')",
            "WHERE INET_ATON(ip) > 0 AND BIN_TO_UUID(u) = 'x' AND TIMESTAMPDIFF(DAY, a, b) > 3",
        ] {
            assert!(info(tail).is_ok(), "{tail}: {:?}", info(tail));
        }
        // Subqueries still need a primary key to verify against.
        let info = info("WHERE id NOT IN (SELECT MIN(id) FROM u GROUP BY email)").unwrap();
        assert_eq!(info.needs_key.as_deref(), Some("it has a subquery"));
    }
}
