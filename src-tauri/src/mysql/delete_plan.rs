//! Which DELETE statements of a script can be backed up to the trash, and the query that reads
//! the rows they delete.
//!
//! Only the plain single-table form is backed up:
//! `DELETE [LOW_PRIORITY] [QUICK] FROM [db.]tbl [[AS] alias] [PARTITION (...)] [WHERE ...]
//! [ORDER BY ...] [LIMIT n]` (see `delete_tail` for what the tail may hold). Its backup query is
//! `SELECT <columns> FROM [db.]tbl [PARTITION (...)] [[AS] alias] <the rest as written> FOR
//! UPDATE`, built from the user's own text: no value is written as a literal here. Everything
//! else that deletes rows, or that this tokenizer is not sure about, is `unsupported` (fail
//! closed).

use serde::Serialize;

use super::classify::{Spanned, Token, tokenize_spans};
use super::delete_tail::analyze_tail;

/// What one statement is, for the trash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteKind {
    /// Not a statement that deletes rows (as far as the tokenizer can tell).
    NotDelete,
    Backup(DeleteTarget),
    /// Deletes rows, but can't be backed up; the reason is shown to the user.
    Unsupported(String),
}

/// The table a supported DELETE removes rows from, and how to read those rows first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteTarget {
    pub database: Option<String>,
    pub table: String,
    /// `FROM <table> [PARTITION] [alias] <tail as written>`; the caller adds the column list,
    /// a row cap and `FOR UPDATE`.
    pub from_sql: String,
    /// The DELETE's own `LIMIT n`.
    pub limit: Option<u64>,
    /// Why the rows read could differ from the rows deleted (subquery, LIMIT, functions that
    /// change, variables). The deleted keys are checked afterwards, so this only stops a
    /// table without a primary key.
    pub needs_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupSupport {
    Ok,
    Unsupported,
}

/// `mysql_delete_plan` entry, for each statement that deletes rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePlanEntry {
    /// Index in `split_statements` of the script.
    pub index: usize,
    pub backup: BackupSupport,
    pub reason: Option<String>,
    /// The statement as split, so the caller can show it without splitting again.
    pub statement: String,
}

/// First words of statements that only define code or objects; a DELETE in them doesn't run.
const DEFINITION_STARTERS: [&str; 6] = ["CREATE", "ALTER", "DROP", "SHOW", "GRANT", "REVOKE"];
const EXPLAIN_STARTERS: [&str; 3] = ["EXPLAIN", "DESCRIBE", "DESC"];
const DELETE_MODIFIERS: [&str; 2] = ["LOW_PRIORITY", "QUICK"];
/// Words that end the table reference of a single-table DELETE.
const CLAUSE_STARTERS: [&str; 3] = ["WHERE", "ORDER", "LIMIT"];
/// Words that can't be an alias right after the table.
const NOT_ALIAS: [&str; 8] =
    ["WHERE", "ORDER", "LIMIT", "PARTITION", "USING", "RETURNING", "JOIN", "AS"];
/// First words of statements that control transactions or table locks.
const TRANSACTION_STARTERS: [&str; 8] =
    ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "XA", "LOCK", "UNLOCK"];

const MULTI_TABLE: &str = "a DELETE over several tables (comma, JOIN or USING) can't be backed up";
const SCRIPT_TRANSACTIONS: &str = "the script controls transactions or table locks (BEGIN, \
     COMMIT, ROLLBACK, SAVEPOINT, XA, autocommit, SET TRANSACTION, LOCK TABLES), so a DELETE in \
     it can't be backed up in a transaction of its own";

fn word(spanned: Option<&Spanned>) -> Option<&str> {
    match spanned.map(|s| &s.token) {
        Some(Token::Word(upper, _)) => Some(upper.as_str()),
        _ => None,
    }
}

fn mentions(tokens: &[Spanned], wanted: &str) -> bool {
    tokens.iter().any(|s| matches!(&s.token, Token::Word(w, _) if w == wanted))
}

/// An identifier (table, database or alias) at `index`.
fn identifier(tokens: &[Spanned], index: usize, not: &[&str]) -> Option<String> {
    match tokens.get(index).map(|s| &s.token)? {
        Token::Quoted(name) => Some(name.clone()),
        Token::Word(upper, raw) if !not.contains(&upper.as_str()) => Some(raw.clone()),
        _ => None,
    }
}

/// Index just past the `)` matching the `(` at `open`.
fn close_paren(tokens: &[Spanned], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (i, s) in tokens.iter().enumerate().skip(open) {
        match s.token {
            Token::Punct('(') => depth += 1,
            Token::Punct(')') => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

struct TableRef {
    database: Option<String>,
    table: String,
    /// Byte ranges in the statement of the table reference, the alias and the PARTITION clause.
    table_span: (usize, usize),
    alias_span: Option<(usize, usize)>,
    partition_span: Option<(usize, usize)>,
    /// Index of the first token after them.
    next: usize,
}

fn parse_table_ref(tokens: &[Spanned], start: usize) -> Option<TableRef> {
    let first = identifier(tokens, start, &CLAUSE_STARTERS)?;
    let (database, table, mut next) =
        if tokens.get(start + 1).map(|s| &s.token) == Some(&Token::Punct('.')) {
            (Some(first), identifier(tokens, start + 2, &[])?, start + 3)
        } else {
            (None, first, start + 1)
        };
    let table_span = (tokens[start].start, tokens[next - 1].end);
    let alias_start = next;
    if word(tokens.get(next)) == Some("AS") {
        next += 1;
        identifier(tokens, next, &NOT_ALIAS)?;
        next += 1;
    } else if identifier(tokens, next, &NOT_ALIAS).is_some() {
        next += 1;
    }
    let alias_span =
        (next > alias_start).then(|| (tokens[alias_start].start, tokens[next - 1].end));
    let mut partition_span = None;
    if word(tokens.get(next)) == Some("PARTITION") {
        if tokens.get(next + 1).map(|s| &s.token) != Some(&Token::Punct('(')) {
            return None;
        }
        let end = close_paren(tokens, next + 1)?;
        partition_span = Some((tokens[next].start, tokens[end - 1].end));
        next = end;
    }
    Some(TableRef { database, table, table_span, alias_span, partition_span, next })
}

/// The statement text from `start`, without a trailing `;`.
fn tail(statement: &str, start: usize) -> &str {
    let rest = statement[start..].trim_end();
    rest.strip_suffix(';').unwrap_or(rest).trim_end()
}

fn plain_delete(statement: &str, tokens: &[Spanned]) -> DeleteKind {
    let unsupported = |reason: &str| DeleteKind::Unsupported(reason.to_string());
    let mut i = 1;
    while let Some(w) = word(tokens.get(i)) {
        match w {
            m if DELETE_MODIFIERS.contains(&m) => i += 1,
            "IGNORE" => {
                return unsupported(
                    "DELETE IGNORE may skip rows on errors, so the backup could hold rows that \
                     were not deleted",
                );
            }
            _ => break,
        }
    }
    if word(tokens.get(i)) != Some("FROM") {
        return unsupported(MULTI_TABLE);
    }
    let Some(target) = parse_table_ref(tokens, i + 1) else {
        return unsupported("the table of this DELETE could not be read");
    };
    let rest_tokens = match tokens.get(target.next) {
        None => &tokens[target.next..],
        Some(s) if s.token == Token::Punct(';') && target.next + 1 == tokens.len() => &[],
        Some(s) => match &s.token {
            Token::Word(w, _) if CLAUSE_STARTERS.contains(&w.as_str()) => {
                let end = tokens.len()
                    - usize::from(tokens.last().map(|t| &t.token) == Some(&Token::Punct(';')));
                &tokens[target.next..end]
            }
            Token::Punct(',') => return unsupported(MULTI_TABLE),
            Token::Word(w, _) if w == "USING" || w == "JOIN" => return unsupported(MULTI_TABLE),
            Token::Word(w, _) if w == "RETURNING" => {
                return unsupported("DELETE ... RETURNING can't be backed up");
            }
            _ => return unsupported("this DELETE has a form that can't be backed up"),
        },
    };
    let info = match analyze_tail(rest_tokens) {
        Ok(info) => info,
        Err(reason) => return DeleteKind::Unsupported(reason),
    };
    let rest = rest_tokens.first().map_or("", |first| tail(statement, first.start));
    let span = |(from, to): (usize, usize)| &statement[from..to];
    let pieces: Vec<&str> = [Some(target.table_span), target.partition_span, target.alias_span]
        .into_iter()
        .flatten()
        .map(span)
        .collect();
    DeleteKind::Backup(DeleteTarget {
        database: target.database,
        table: target.table,
        from_sql: format!("FROM {} {rest}", pieces.join(" ")),
        limit: info.limit,
        needs_key: info.needs_key,
    })
}

/// EXPLAIN only shows the plan, but EXPLAIN ANALYZE (the word right after EXPLAIN) runs it.
fn explained(tokens: &[Spanned]) -> DeleteKind {
    if word(tokens.get(1)) == Some("ANALYZE") {
        DeleteKind::Unsupported("EXPLAIN ANALYZE runs the DELETE, which can't be backed up".into())
    } else {
        DeleteKind::NotDelete
    }
}

/// Classifies one statement (as split by `split_statements`).
pub fn classify_delete(statement: &str) -> DeleteKind {
    let tokens = tokenize_spans(statement);
    if !mentions(&tokens, "DELETE") {
        return DeleteKind::NotDelete;
    }
    if tokens.iter().any(|s| s.in_exec) {
        return DeleteKind::Unsupported(
            "a DELETE with a /*! */ executable comment can't be backed up".into(),
        );
    }
    match word(tokens.first()) {
        Some(w) if DEFINITION_STARTERS.contains(&w) => DeleteKind::NotDelete,
        Some(w) if EXPLAIN_STARTERS.contains(&w) => explained(&tokens),
        Some("DELETE") => plain_delete(statement, &tokens),
        Some("WITH") => DeleteKind::Unsupported("WITH ... DELETE can't be backed up".into()),
        _ => DeleteKind::Unsupported(
            "this statement deletes rows in a way that can't be backed up".into(),
        ),
    }
}

/// Whether `statement` starts or ends a transaction, changes autocommit or the next
/// transaction's characteristics, or locks tables. Executable comments are read as part of the
/// text (the server runs them), so `/*!50000 SET */ autocommit = 0` counts too, as does such a
/// statement hidden in a comment after another one.
pub fn controls_transactions(statement: &str) -> bool {
    let tokens = tokenize_spans(statement);
    let words: Vec<&str> = tokens.iter().filter_map(|s| word(Some(s))).collect();
    let first = words.first().copied();
    let set_controls = |words: &[&str]| {
        words.first() == Some(&"SET")
            && (words.contains(&"AUTOCOMMIT") || words.contains(&"TRANSACTION"))
    };
    let starts = first.is_some_and(|w| TRANSACTION_STARTERS.contains(&w))
        || (first == Some("START") && words.get(1) == Some(&"TRANSACTION"))
        || set_controls(&words);
    starts || exec_controls(&tokens)
}

/// With an executable comment anywhere, the same words count wherever they stand, since the
/// comment can put a statement start at any position (`SELECT 1 /*!, 2 */; COMMIT` patterns).
fn exec_controls(tokens: &[Spanned]) -> bool {
    if !tokens.iter().any(|s| s.in_exec) {
        return false;
    }
    let words: Vec<&str> = tokens.iter().filter_map(|s| word(Some(s))).collect();
    let starts = words.iter().any(|w| TRANSACTION_STARTERS.contains(w));
    let start_transaction = words.windows(2).any(|w| w == ["START", "TRANSACTION"]);
    let set =
        words.contains(&"SET") && (words.contains(&"AUTOCOMMIT") || words.contains(&"TRANSACTION"));
    starts || start_transaction || set
}

/// The trash status of each statement of a script: `classify_delete`, except that every DELETE
/// of a script that controls transactions is unsupported.
pub fn classify_script(statements: &[String]) -> Vec<DeleteKind> {
    let transactions = statements.iter().any(|s| controls_transactions(s));
    statements
        .iter()
        .map(|statement| match classify_delete(statement) {
            DeleteKind::Backup(_) if transactions => {
                DeleteKind::Unsupported(SCRIPT_TRANSACTIONS.into())
            }
            other => other,
        })
        .collect()
}

/// `mysql_delete_plan`: one entry per statement that deletes rows.
pub fn delete_plan(statements: &[String]) -> Vec<DeletePlanEntry> {
    classify_script(statements)
        .into_iter()
        .zip(statements)
        .enumerate()
        .filter_map(|(index, (kind, statement))| {
            let (backup, reason) = match kind {
                DeleteKind::NotDelete => return None,
                DeleteKind::Backup(_) => (BackupSupport::Ok, None),
                DeleteKind::Unsupported(reason) => (BackupSupport::Unsupported, Some(reason)),
            };
            Some(DeletePlanEntry { index, backup, reason, statement: statement.clone() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mysql::split_statements;

    fn backup(statement: &str) -> DeleteTarget {
        match classify_delete(statement) {
            DeleteKind::Backup(target) => target,
            other => panic!("{statement}: {other:?}"),
        }
    }

    fn reason(statement: &str) -> String {
        match classify_delete(statement) {
            DeleteKind::Unsupported(reason) => reason,
            other => panic!("{statement} should be unsupported: {other:?}"),
        }
    }

    #[test]
    fn plain_deletes_keep_their_target_and_tail() {
        assert_eq!(backup("DELETE FROM t").from_sql, "FROM t ");
        assert_eq!(backup("delete from t where id = 1").from_sql, "FROM t where id = 1");
        let t =
            backup("DELETE LOW_PRIORITY QUICK FROM `my db`.`t``x` WHERE a > 0 ORDER BY a LIMIT 5;");
        assert_eq!(t.from_sql, "FROM `my db`.`t``x` WHERE a > 0 ORDER BY a LIMIT 5");
        assert_eq!(
            (t.database.as_deref(), t.table.as_str(), t.limit),
            (Some("my db"), "t`x", Some(5))
        );
        assert_eq!(
            backup("DELETE FROM t AS x PARTITION (p0, p1) WHERE x.id = 2").from_sql,
            "FROM t PARTITION (p0, p1) AS x WHERE x.id = 2"
        );
        assert_eq!(backup("DELETE FROM t x WHERE x.id = 2").from_sql, "FROM t x WHERE x.id = 2");
        assert_eq!(
            backup("DELETE FROM t WHERE id = 1 -- why").from_sql,
            "FROM t WHERE id = 1 -- why"
        );
        let quoted = backup(
            "DELETE /* c */ FROM t WHERE name = 'a; DELETE FROM u' AND id IN (SELECT id FROM s)",
        );
        assert_eq!(quoted.needs_key.as_deref(), Some("it has a subquery"));
        assert_eq!(backup("DELETE FROM t WHERE uuid = 'x' AND rand = 2").needs_key, None);
        assert!(backup("DELETE FROM t WHERE RAND() < 0.5").needs_key.unwrap().contains("RAND()"));
        assert!(reason("DELETE FROM t WHERE my_fn(id) = 1").contains("side effects"));
        assert!(reason("DELETE FROM t WHERE SLEEP(1) = 0").contains("SLEEP"));
        assert!(backup("DELETE FROM t LIMIT 10").needs_key.unwrap().contains("LIMIT"));
    }

    #[test]
    fn other_deletes_are_unsupported() {
        for statement in [
            "DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id",
            "DELETE FROM t1, t2 USING t1 JOIN t2",
            "DELETE FROM t1 USING t1 JOIN t2 ON t1.id = t2.id",
            "DELETE t1, t2 FROM t1, t2 WHERE t1.id = t2.id",
        ] {
            assert!(reason(statement).contains("several tables"), "{statement}");
        }
        assert!(reason("DELETE IGNORE FROM t WHERE id = 1").contains("IGNORE"));
        assert!(
            reason("WITH c AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM c)")
                .contains("WITH")
        );
        assert!(reason("DELETE FROM t WHERE id = 1 /*! AND 1 */").contains("executable comment"));
        assert!(reason("/*!80000 DELETE FROM t */").contains("executable comment"));
        assert!(reason("/*!50000DELETE FROM t*/").contains("executable comment"));
        assert!(reason("/*M!100000 DELETE FROM t */").contains("executable comment"));
        assert!(
            reason(
                "CREATE TRIGGER x BEFORE DELETE ON t FOR EACH ROW /*! DELETE FROM u */ SET @a = 1"
            )
            .contains("executable comment")
        );
        assert!(reason("DELETE FROM t RETURNING *").contains("RETURNING"));
        assert!(reason("EXPLAIN ANALYZE DELETE FROM t").contains("EXPLAIN ANALYZE"));
        assert!(reason("DELETE FROM").contains("could not be read"));
        assert!(reason("DELETE FROM t PARTITION p0").contains("could not be read"));
        assert!(reason("DELETE FROM t garbage more").contains("form"));
        assert!(reason("DELETE FROM t WHERE id = 1 GROUP BY id").contains("GROUP"));
        assert!(reason("DELETE FROM t WHERE a = 1 INTO OUTFILE '/tmp/x'").contains("OUTFILE"));
        assert!(reason("DELETE FROM t LIMIT 1, 2").contains("LIMIT"));
        assert!(reason("DELETE FROM t ORDER BY id LIMIT 5 OFFSET 1").contains("OFFSET"));
    }

    #[test]
    fn statements_that_only_mention_delete_are_not_deletes() {
        for statement in [
            "SELECT 'delete from t'",
            "SELECT `delete` FROM t",
            "SELECT 1 -- delete from t",
            "UPDATE t SET note = \"DELETE\"",
            "CREATE TRIGGER x BEFORE DELETE ON t FOR EACH ROW SET @a = 1",
            "GRANT DELETE ON db.* TO u",
            "SHOW GRANTS",
            "EXPLAIN DELETE FROM t WHERE id = 1",
            "DESCRIBE DELETE FROM t",
            "EXPLAIN FORMAT=JSON DELETE FROM analyze WHERE id = 1",
        ] {
            assert_eq!(classify_delete(statement), DeleteKind::NotDelete, "{statement}");
        }
    }

    #[test]
    fn deeply_nested_executable_comments_are_handled_quickly() {
        let statement = format!("DELETE FROM t WHERE id = 1 {}", "/*!".repeat(200_000));
        let start = std::time::Instant::now();
        assert!(reason(&statement).contains("executable comment"));
        let script = split_statements(&statement);
        assert_eq!(delete_plan(&script).len(), 1);
        assert!(start.elapsed() < std::time::Duration::from_secs(3), "{:?}", start.elapsed());
    }

    #[test]
    fn transaction_control_makes_every_delete_of_the_script_unsupported() {
        for statement in [
            "BEGIN",
            "begin work",
            "START TRANSACTION",
            "COMMIT",
            "ROLLBACK",
            "SAVEPOINT a",
            "RELEASE SAVEPOINT a",
            "XA START 'x'",
            "SET autocommit = 0",
            "SET SESSION autocommit=0",
            "SET @@session.autocommit = 0",
            "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
            "SET SESSION TRANSACTION READ ONLY",
            "LOCK TABLES t WRITE",
            "UNLOCK TABLES",
            "/*!40000 BEGIN */",
            "SELECT 1 /*!40000 SET autocommit = 0 */",
            "DO 1 /*!80000 START TRANSACTION */",
            "/*!80000 SET TRANSACTION READ ONLY */",
            "/*!50000 SET */ autocommit = 0",
            "/*!50000 START */ TRANSACTION",
            "/*!80000 COMMIT */",
            "SELECT 1 /*!50000 , 2 */ FROM t WHERE x = 'a' AND COMMIT",
            "DO /*!50000 1 */, 2; SET x = 1, autocommit = 0",
        ] {
            assert!(controls_transactions(statement), "{statement}");
        }
        for statement in ["SET @a = 1", "SELECT 'BEGIN'", "START REPLICA", "DELETE FROM t"] {
            assert!(!controls_transactions(statement), "{statement}");
        }
        let script = split_statements("BEGIN; DELETE FROM t WHERE id = 1; COMMIT");
        let plan = delete_plan(&script);
        assert_eq!(plan.len(), 1);
        assert_eq!((plan[0].index, plan[0].backup), (1, BackupSupport::Unsupported));
        assert!(plan[0].reason.as_deref().unwrap().contains("transactions"));
    }

    #[test]
    fn plan_lists_only_deletes_with_script_indexes() {
        let script = split_statements(
            "SELECT 1; DELETE FROM t WHERE id = 1; UPDATE t SET a = 1; DELETE t FROM t JOIN u",
        );
        let plan = delete_plan(&script);
        assert_eq!(
            plan.iter().map(|e| (e.index, e.backup)).collect::<Vec<_>>(),
            [(1, BackupSupport::Ok), (3, BackupSupport::Unsupported)]
        );
        let json = serde_json::to_value(&plan[0]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "index": 1, "backup": "ok", "reason": null,
                "statement": "DELETE FROM t WHERE id = 1"
            })
        );
    }
}
