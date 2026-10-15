//! Splits a SQL script on `;` outside string literals, quoted identifiers and comments.
//! `DELIMITER` client commands are not supported.

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Normal,
    Quoted(char),
    LineComment,
    BlockComment,
}

struct Piece {
    start: usize,
    has_code: bool,
}

fn starts_line_comment(bytes: &[u8], i: usize) -> bool {
    bytes.get(i) == Some(&b'-')
        && bytes.get(i + 1) == Some(&b'-')
        && bytes.get(i + 2).is_none_or(|b| b.is_ascii_whitespace())
}

/// Returns the trimmed statements of `sql`; pieces containing only whitespace and comments are
/// dropped.
pub fn split_statements(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut statements = Vec::new();
    let mut state = State::Normal;
    let mut piece = Piece { start: 0, has_code: false };
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match state {
            State::Normal => match b {
                b'\'' | b'"' | b'`' => {
                    state = State::Quoted(char::from(b));
                    piece.has_code = true;
                }
                b'#' => state = State::LineComment,
                b'-' if starts_line_comment(bytes, i) => state = State::LineComment,
                b'/' if bytes.get(i + 1) == Some(&b'*') => {
                    // `/*! ... */` is a MySQL executable comment: the server runs its body.
                    if bytes.get(i + 2) == Some(&b'!') {
                        piece.has_code = true;
                    }
                    state = State::BlockComment;
                    i += 1;
                }
                b';' => {
                    if piece.has_code {
                        statements.push(sql[piece.start..i].trim().to_string());
                    }
                    piece = Piece { start: i + 1, has_code: false };
                }
                b if b.is_ascii_whitespace() => {}
                _ => piece.has_code = true,
            },
            State::Quoted(quote) => {
                if b == b'\\' && quote != '`' {
                    i += 1;
                } else if char::from(b) == quote {
                    // A doubled quote closes and immediately reopens, which is equivalent.
                    state = State::Normal;
                }
            }
            State::LineComment => {
                if b == b'\n' {
                    state = State::Normal;
                }
            }
            State::BlockComment => {
                if b == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    state = State::Normal;
                    i += 1;
                }
            }
        }
        i += 1;
    }
    if piece.has_code {
        statements.push(sql[piece.start..].trim().to_string());
    }
    statements
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_simple_statements() {
        assert_eq!(split_statements("SELECT 1; SELECT 2;"), vec!["SELECT 1", "SELECT 2"]);
        assert_eq!(split_statements("SELECT 1"), vec!["SELECT 1"]);
    }

    #[test]
    fn ignores_semicolons_in_strings_and_identifiers() {
        let sql = r#"SELECT 'a;b', "c;d", `e;f` FROM t; SELECT 'it''s;', 'x\';y'"#;
        assert_eq!(
            split_statements(sql),
            vec![r#"SELECT 'a;b', "c;d", `e;f` FROM t"#, r"SELECT 'it''s;', 'x\';y'"]
        );
    }

    #[test]
    fn ignores_semicolons_in_comments() {
        let sql = "SELECT 1 -- a;b\n; # c;d\nSELECT /* e;f */ 2;";
        assert_eq!(split_statements(sql), vec!["SELECT 1 -- a;b", "# c;d\nSELECT /* e;f */ 2"]);
    }

    #[test]
    fn double_dash_without_space_is_not_a_comment() {
        assert_eq!(split_statements("SELECT 1--1; SELECT 2"), vec!["SELECT 1--1", "SELECT 2"]);
    }

    #[test]
    fn drops_empty_and_comment_only_pieces() {
        assert_eq!(split_statements(" ; ;\n-- only a comment\n; /* x */ "), Vec::<String>::new());
        assert_eq!(split_statements("SELECT 1; -- trailing"), vec!["SELECT 1"]);
    }

    #[test]
    fn keeps_executable_comment_statements() {
        let sql =
            "/*!40101 SET NAMES utf8mb4 */;\n/* plain */;\n/*!40014 SET FOREIGN_KEY_CHECKS=0 */";
        assert_eq!(
            split_statements(sql),
            vec!["/*!40101 SET NAMES utf8mb4 */", "/*!40014 SET FOREIGN_KEY_CHECKS=0 */"]
        );
    }

    #[test]
    fn keeps_multibyte_text_intact() {
        assert_eq!(
            split_statements("SELECT '한글;값'; SELECT `이름`"),
            vec!["SELECT '한글;값'", "SELECT `이름`"]
        );
    }

    #[test]
    fn unterminated_string_swallows_rest() {
        assert_eq!(split_statements("SELECT 'a; SELECT 2"), vec!["SELECT 'a; SELECT 2"]);
    }
}
