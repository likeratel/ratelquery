//! GetQueryResults paging: columns, header-row removal, `maxRows` and `truncated`.

use aws_sdk_athena::types::{ColumnInfo as SdkColumnInfo, ColumnNullable, ResultSet};

use super::cell::{display_type, to_cell};
use super::errors::map_sdk_error;
use super::registry::AthenaHandle;
use crate::error::AppResult;
use crate::mysql::{Cell, ColumnInfo};

/// Rows per GetQueryResults page (the API maximum).
const PAGE_SIZE: i32 = 1000;
const FALLBACK_TYPE: &str = "varchar";

/// One page as plain text values (`None` = no `VarCharValue`).
pub type TextRow = Vec<Option<String>>;

pub fn column_info(column: &SdkColumnInfo) -> ColumnInfo {
    ColumnInfo {
        name: column.name().to_string(),
        type_name: display_type(column.r#type()),
        table: None,
        nullable: column.nullable() != Some(&ColumnNullable::NotNull),
    }
}

pub fn text_rows(result_set: &ResultSet) -> Vec<TextRow> {
    result_set
        .rows()
        .iter()
        .map(|row| row.data().iter().map(|d| d.var_char_value().map(str::to_string)).collect())
        .collect()
}

/// True when `row` repeats the column names (the header row of `SELECT`-like results).
pub fn is_header_row(row: &[Option<String>], names: &[String]) -> bool {
    !names.is_empty()
        && row.len() == names.len()
        && row.iter().zip(names).all(|(value, name)| value.as_deref() == Some(name.as_str()))
}

/// Collects mapped rows across pages up to `max_rows`.
#[derive(Debug)]
pub struct RowCollector {
    names: Vec<String>,
    types: Vec<String>,
    max_rows: usize,
    rows: Vec<Vec<Cell>>,
    truncated: bool,
    first_page: bool,
}

impl RowCollector {
    pub fn new(names: Vec<String>, types: Vec<String>, max_rows: usize) -> Self {
        Self { names, types, max_rows, rows: Vec::new(), truncated: false, first_page: true }
    }

    fn map_row(&self, row: &[Option<String>]) -> Vec<Cell> {
        self.types
            .iter()
            .enumerate()
            .map(|(i, t)| to_cell(t, row.get(i).and_then(Option::as_deref)))
            .collect()
    }

    /// Adds one page. Returns false once `max_rows` rows are kept and more exist (`has_more`
    /// tells whether another page follows), so the caller stops paging.
    pub fn push_page(&mut self, page: &[TextRow], has_more: bool) -> bool {
        let skip = self.first_page && page.first().is_some_and(|r| is_header_row(r, &self.names));
        self.first_page = false;
        if self.types.is_empty() {
            return false;
        }
        for row in page.iter().skip(usize::from(skip)) {
            if self.rows.len() >= self.max_rows {
                self.truncated = true;
                return false;
            }
            let mapped = self.map_row(row);
            self.rows.push(mapped);
        }
        if has_more && self.rows.len() >= self.max_rows {
            self.truncated = true;
            return false;
        }
        has_more
    }

    pub fn finish(self) -> (Vec<Vec<Cell>>, bool) {
        (self.rows, self.truncated)
    }
}

pub struct FetchedRows {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Cell>>,
    pub truncated: bool,
}

/// Pages through GetQueryResults until `max_rows` rows are kept or the results end.
pub async fn fetch_rows(
    handle: &AthenaHandle,
    execution_id: &str,
    max_rows: usize,
) -> AppResult<FetchedRows> {
    let mut token: Option<String> = None;
    let mut columns: Vec<ColumnInfo> = Vec::new();
    let mut collector: Option<RowCollector> = None;
    loop {
        let output = handle
            .client()
            .get_query_results()
            .query_execution_id(execution_id)
            .max_results(PAGE_SIZE)
            .set_next_token(token.take())
            .send()
            .await
            .map_err(|e| map_sdk_error(&e, handle.auth()))?;
        let Some(result_set) = output.result_set() else { break };
        let current = collector.get_or_insert_with(|| {
            let sdk_columns =
                result_set.result_set_metadata().map(|m| m.column_info()).unwrap_or_default();
            columns = sdk_columns.iter().map(column_info).collect();
            let names = sdk_columns.iter().map(|c| c.name().to_string()).collect();
            let types = sdk_columns
                .iter()
                .map(|c| if c.r#type().is_empty() { FALLBACK_TYPE } else { c.r#type() })
                .map(str::to_string)
                .collect();
            RowCollector::new(names, types, max_rows)
        });
        let next = output.next_token().map(str::to_string);
        if !current.push_page(&text_rows(result_set), next.is_some()) {
            break;
        }
        token = next;
    }
    let (rows, truncated) = collector.map(RowCollector::finish).unwrap_or_default();
    Ok(FetchedRows { columns, rows, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_athena::types::{Datum, ResultSetMetadata, Row};

    fn text(values: &[Option<&str>]) -> TextRow {
        values.iter().map(|v| v.map(str::to_string)).collect()
    }

    fn collector(max_rows: usize) -> RowCollector {
        RowCollector::new(
            vec!["id".into(), "name".into()],
            vec!["bigint".into(), "varchar".into()],
            max_rows,
        )
    }

    #[test]
    fn detects_the_header_row() {
        let names = vec!["id".to_string(), "name".to_string()];
        assert!(is_header_row(&text(&[Some("id"), Some("name")]), &names));
        assert!(!is_header_row(&text(&[Some("1"), Some("name")]), &names));
        assert!(!is_header_row(&text(&[Some("id")]), &names));
        assert!(!is_header_row(&text(&[Some("id"), None]), &names));
        assert!(!is_header_row(&[], &[]));
    }

    #[test]
    fn drops_the_header_only_on_the_first_page() {
        let mut rows = collector(10);
        let header = text(&[Some("id"), Some("name")]);
        assert!(rows.push_page(&[header.clone(), text(&[Some("1"), None])], true));
        assert!(!rows.push_page(&[header], false));
        let (rows, truncated) = rows.finish();
        assert!(!truncated);
        assert_eq!(rows[0], vec![Cell::Int("1".into()), Cell::Null]);
        assert_eq!(rows[1], vec![Cell::Str("id".into()), Cell::Str("name".into())]);
    }

    #[test]
    fn metadata_rows_without_header_are_kept() {
        let mut rows = RowCollector::new(vec!["tab_name".into()], vec!["string".into()], 10);
        rows.push_page(&[text(&[Some("events")]), text(&[Some("users")])], false);
        let (rows, _) = rows.finish();
        assert_eq!(rows, vec![vec![Cell::Str("events".into())], vec![Cell::Str("users".into())]]);
    }

    #[test]
    fn stops_at_max_rows_and_reports_truncation() {
        let row = |i: &str| text(&[Some(i), Some("x")]);
        let mut within = collector(2);
        assert!(!within.push_page(&[row("1"), row("2")], false));
        assert!(!within.finish().1, "exactly max rows and no more pages");

        let mut cut = collector(2);
        assert!(!cut.push_page(&[row("1"), row("2"), row("3")], false));
        let (rows, truncated) = cut.finish();
        assert_eq!((rows.len(), truncated), (2, true));

        let mut paged = collector(2);
        assert!(paged.push_page(&[row("1")], true));
        assert!(!paged.push_page(&[row("2")], true), "max reached with another page");
        assert!(paged.finish().1);
    }

    #[test]
    fn short_rows_are_padded_and_no_columns_means_no_rows() {
        let mut rows = collector(5);
        rows.push_page(&[text(&[Some("7")])], false);
        assert_eq!(rows.finish().0, vec![vec![Cell::Int("7".into()), Cell::Null]]);
        let mut none = RowCollector::new(vec![], vec![], 5);
        assert!(!none.push_page(&[text(&[])], true));
        assert_eq!(none.finish(), (vec![], false));
    }

    #[test]
    fn reads_columns_and_text_from_sdk_shapes() {
        let info = |nullable| {
            SdkColumnInfo::builder()
                .name("price")
                .r#type("decimal")
                .precision(10)
                .scale(2)
                .set_nullable(nullable)
                .build()
                .unwrap()
        };
        let column = column_info(&info(Some(ColumnNullable::NotNull)));
        assert_eq!((column.name.as_str(), column.type_name.as_str()), ("price", "DECIMAL"));
        assert!(!column.nullable && column.table.is_none());
        assert!(column_info(&info(Some(ColumnNullable::Nullable))).nullable);
        assert!(column_info(&info(Some(ColumnNullable::from("UNKNOWN")))).nullable);
        assert!(column_info(&info(None)).nullable);

        let result_set = ResultSet::builder()
            .result_set_metadata(ResultSetMetadata::builder().column_info(info(None)).build())
            .rows(Row::builder().data(Datum::builder().var_char_value("1.20").build()).build())
            .rows(Row::builder().data(Datum::builder().build()).build())
            .build();
        assert_eq!(text_rows(&result_set), vec![text(&[Some("1.20")]), text(&[None])]);
    }
}
