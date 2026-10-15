//! `dynamo_export`: follows `lastKey` until exhausted and streams items to a file.
//!
//! - `json`: an array of items in the DynamoDB JSON wire format (lossless).
//! - `jsonl`: one wire-format item per line.
//! - `csv`: the header is the union of top-level attribute names, which is only known after the
//!   last page. Items are therefore spooled as JSON lines into a temp file next to the target
//!   while the names are collected, then the spool is read back and written as CSV. Header
//!   order: the table's hash and range key, then every other name sorted. Scalars are written
//!   as text (`S`, `N` as is, `B` base64, `BOOL` true/false, `NULL` and missing attributes
//!   empty); `M`, `L` and sets are written as plain JSON text (see [`plain_json`]).
//!
//! Every file is written through [`AtomicFile`], so a failed export removes its temp files and
//! never leaves a partial target behind. All file I/O (open, each page, the spool-to-CSV pass
//! and the final commit) runs on the blocking pool via [`run_blocking`]; the sink moves into
//! each blocking task and back, and is dropped there (removing its temp files) on failure.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::time::Instant;

use serde_json::{Map, Number, Value};

use super::expr::MAX_LIMIT;
use super::model::{
    DynamoExportFormat, DynamoExportOptions, DynamoExportRequest, Page, QueryRequest, ScanRequest,
};
use super::ops::{elapsed_ms, query, scan};
use super::registry::DynamoHandle;
use super::schema::table_info;
use super::wire::WireItem;
use crate::error::{AppError, AppResult};
use crate::export::{AtomicFile, CountingWriter, ExportResult, run_blocking, validate_target};

const BUFFER_SIZE: usize = 64 * 1024;

type Out = CountingWriter<BufWriter<File>>;

fn open(target: &std::path::Path) -> AppResult<(AtomicFile, Out)> {
    let (atomic, file) = AtomicFile::create(target)?;
    Ok((atomic, CountingWriter::new(BufWriter::with_capacity(BUFFER_SIZE, file))))
}

fn commit(atomic: AtomicFile, out: Out) -> AppResult<u64> {
    let (buffered, bytes) = out.into_parts();
    let file = buffered.into_inner().map_err(|e| AppError::Io(e.error().to_string()))?;
    atomic.commit(file)?;
    Ok(bytes)
}

fn csv_error(err: csv::Error) -> AppError {
    AppError::Io(format!("could not write CSV: {err}"))
}

fn plain_number(text: &str) -> Value {
    match serde_json::from_str::<Number>(text) {
        Ok(number) if number.to_string() == text => Value::Number(number),
        _ => Value::String(text.to_string()),
    }
}

/// Wire value -> plain JSON for CSV cells: maps become objects, lists and sets arrays, `N`
/// becomes a JSON number when it round-trips exactly (otherwise a string), `B` base64 text.
pub fn plain_json(wire: &Value) -> Value {
    let Some((tag, inner)) = wire.as_object().and_then(|o| o.iter().next()) else {
        return wire.clone();
    };
    let each = |f: &dyn Fn(&Value) -> Value| -> Value {
        Value::Array(inner.as_array().map(|a| a.iter().map(f).collect()).unwrap_or_default())
    };
    match tag.as_str() {
        "N" => inner.as_str().map(plain_number).unwrap_or_else(|| inner.clone()),
        "NULL" => Value::Null,
        "M" => Value::Object(
            inner
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), plain_json(v))).collect())
                .unwrap_or_default(),
        ),
        "L" => each(&plain_json),
        "NS" => each(&|v| v.as_str().map(plain_number).unwrap_or_else(|| v.clone())),
        _ => inner.clone(),
    }
}

/// One CSV field for a top-level attribute (`None` when the item lacks it).
pub fn csv_cell(wire: Option<&Value>) -> String {
    let Some(wire) = wire else { return String::new() };
    match plain_json(wire) {
        Value::Null => String::new(),
        Value::String(text) => text,
        Value::Bool(v) => v.to_string(),
        Value::Number(n) => n.to_string(),
        nested => nested.to_string(),
    }
}

/// CSV header: key attributes first, then the remaining names sorted.
pub fn csv_header(keys: &[String], names: &BTreeSet<String>) -> Vec<String> {
    let rest = names.iter().filter(|n| !keys.contains(n)).cloned();
    keys.iter().cloned().chain(rest).collect()
}

/// Writers are declared before their [`AtomicFile`] so an abandoned export drops (flushes or
/// discards) the buffer before the temp file is removed.
enum Sink {
    Json { out: Out, atomic: AtomicFile },
    Jsonl { out: Out, atomic: AtomicFile },
    Csv { out: BufWriter<File>, spool: AtomicFile, names: BTreeSet<String> },
}

impl Sink {
    fn open(format: DynamoExportFormat, target: &std::path::Path) -> AppResult<Sink> {
        Ok(match format {
            DynamoExportFormat::Json => {
                let (atomic, out) = open(target)?;
                Sink::Json { out, atomic }
            }
            DynamoExportFormat::Jsonl => {
                let (atomic, out) = open(target)?;
                Sink::Jsonl { out, atomic }
            }
            DynamoExportFormat::Csv => {
                let (spool, file) = AtomicFile::create(target)?;
                let out = BufWriter::with_capacity(BUFFER_SIZE, file);
                Sink::Csv { out, spool, names: BTreeSet::new() }
            }
        })
    }

    fn write(&mut self, item: &WireItem, index: u64) -> AppResult<()> {
        let text = serde_json::to_string(item)?;
        match self {
            Sink::Json { out, .. } => {
                let lead = if index == 0 { "[\n  " } else { ",\n  " };
                write!(out, "{lead}{text}")?;
            }
            Sink::Jsonl { out, .. } => writeln!(out, "{text}")?,
            Sink::Csv { out, names, .. } => {
                for name in item.keys() {
                    if !names.contains(name) {
                        names.insert(name.clone());
                    }
                }
                writeln!(out, "{text}")?;
            }
        }
        Ok(())
    }

    fn finish(self, rows: u64, target: &std::path::Path, keys: &[String]) -> AppResult<u64> {
        match self {
            Sink::Json { atomic, mut out } => {
                out.write_all(if rows == 0 { b"[]\n" } else { b"\n]\n" })?;
                commit(atomic, out)
            }
            Sink::Jsonl { atomic, out } => commit(atomic, out),
            Sink::Csv { spool, out, names } => {
                let file = out.into_inner().map_err(|e| AppError::Io(e.error().to_string()))?;
                file.sync_all()?;
                drop(file);
                let bytes = spool_to_csv(&spool, target, &csv_header(keys, &names))?;
                drop(spool);
                Ok(bytes)
            }
        }
    }
}

fn spool_to_csv(spool: &AtomicFile, target: &std::path::Path, header: &[String]) -> AppResult<u64> {
    let reader = BufReader::with_capacity(BUFFER_SIZE, File::open(spool.temp_path())?);
    let (atomic, out) = open(target)?;
    let mut writer = csv::WriterBuilder::new()
        .terminator(csv::Terminator::Any(b'\n'))
        .quote_style(csv::QuoteStyle::Necessary)
        .from_writer(out);
    writer.write_record(header).map_err(csv_error)?;
    for line in reader.lines() {
        let item: Map<String, Value> = serde_json::from_str(&line?)?;
        writer.write_record(header.iter().map(|h| csv_cell(item.get(h)))).map_err(csv_error)?;
    }
    let out = writer
        .into_inner()
        .map_err(|e| AppError::Io(format!("could not write CSV: {}", e.error())))?;
    commit(atomic, out)
}

fn table_of(request: &DynamoExportRequest) -> &str {
    match request {
        DynamoExportRequest::Scan(r) => &r.table,
        DynamoExportRequest::Query(r) => &r.table,
    }
}

async fn fetch(
    handle: &DynamoHandle,
    request: &DynamoExportRequest,
    start_key: Option<WireItem>,
) -> AppResult<Page> {
    let limit = Some(i64::from(MAX_LIMIT));
    match request {
        DynamoExportRequest::Scan(r) => {
            scan(handle, &ScanRequest { start_key, limit: r.limit.or(limit), ..r.clone() }).await
        }
        DynamoExportRequest::Query(r) => {
            query(handle, &QueryRequest { start_key, limit: r.limit.or(limit), ..r.clone() }).await
        }
    }
}

fn initial_start_key(request: &DynamoExportRequest) -> Option<WireItem> {
    match request {
        DynamoExportRequest::Scan(r) => r.start_key.clone(),
        DynamoExportRequest::Query(r) => r.start_key.clone(),
    }
}

/// Runs the whole export. The request's `limit` is the page size (default 1000).
pub async fn run_export(
    handle: &DynamoHandle,
    request: &DynamoExportRequest,
    options: &DynamoExportOptions,
) -> AppResult<ExportResult> {
    let start = Instant::now();
    let target = validate_target(&options.path)?;
    let description = table_info(handle, table_of(request)).await?;
    let keys: Vec<String> = std::iter::once(description.key_schema.hash.name.clone())
        .chain(description.key_schema.range.as_ref().map(|r| r.name.clone()))
        .collect();
    let format = options.format;
    let open_target = target.clone();
    let mut sink = run_blocking(move || Sink::open(format, &open_target)).await?;
    let mut rows: u64 = 0;
    let mut next = initial_start_key(request);
    loop {
        let page = fetch(handle, request, next.take()).await?;
        (sink, rows) = write_page(sink, page.items, rows).await?;
        match page.last_key {
            Some(key) => next = Some(key),
            None => break,
        }
    }
    let bytes = run_blocking(move || sink.finish(rows, &target, &keys)).await?;
    Ok(ExportResult { rows, bytes, elapsed_ms: elapsed_ms(start) })
}

/// Writes one page on the blocking pool; returns the sink and the new row count.
async fn write_page(mut sink: Sink, items: Vec<WireItem>, rows: u64) -> AppResult<(Sink, u64)> {
    run_blocking(move || {
        let mut index = rows;
        for item in &items {
            sink.write(item, index)?;
            index += 1;
        }
        Ok((sink, index))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plain_json_converts_nested_values() {
        let wire = json!({ "M": {
            "n": { "N": "12" }, "f": { "N": "1.5" }, "big": { "N": "123456789012345678901234567890" },
            "l": { "L": [ { "S": "a" }, { "NULL": true }, { "BOOL": true } ] },
            "ss": { "SS": ["x"] }, "ns": { "NS": ["1", "2"] }, "b": { "B": "AQ==" }
        } });
        assert_eq!(
            plain_json(&wire),
            json!({ "n": 12, "f": 1.5, "big": "123456789012345678901234567890",
                    "l": ["a", null, true], "ss": ["x"], "ns": [1, 2], "b": "AQ==" })
        );
    }

    #[test]
    fn csv_cells() {
        assert_eq!(csv_cell(None), "");
        assert_eq!(csv_cell(Some(&json!({ "S": "a,b" }))), "a,b");
        assert_eq!(csv_cell(Some(&json!({ "N": "007" }))), "007");
        assert_eq!(csv_cell(Some(&json!({ "BOOL": false }))), "false");
        assert_eq!(csv_cell(Some(&json!({ "NULL": true }))), "");
        assert_eq!(csv_cell(Some(&json!({ "B": "AAH/" }))), "AAH/");
        assert_eq!(csv_cell(Some(&json!({ "M": { "k": { "S": "v" } } }))), r#"{"k":"v"}"#);
        assert_eq!(csv_cell(Some(&json!({ "SS": ["a", "b"] }))), r#"["a","b"]"#);
    }

    #[test]
    fn header_puts_keys_first() {
        let names: BTreeSet<String> =
            ["z", "pk", "a", "sk"].iter().map(|s| s.to_string()).collect();
        let keys = vec!["pk".to_string(), "sk".to_string()];
        assert_eq!(csv_header(&keys, &names), vec!["pk", "sk", "a", "z"]);
        assert_eq!(csv_header(&keys, &BTreeSet::new()), vec!["pk", "sk"]);
    }

    #[test]
    fn csv_sink_spools_then_writes_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.csv");
        let mut sink = Sink::open(DynamoExportFormat::Csv, &target).unwrap();
        let first: WireItem =
            serde_json::from_value(json!({ "pk": { "S": "a" }, "x": { "N": "1" } })).unwrap();
        let second: WireItem =
            serde_json::from_value(json!({ "pk": { "S": "b" }, "y": { "L": [ { "S": "q\"" } ] } }))
                .unwrap();
        sink.write(&first, 0).unwrap();
        sink.write(&second, 1).unwrap();
        let bytes = sink.finish(2, &target, &["pk".to_string()]).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert_eq!(text, "pk,x,y\na,1,\nb,,\"[\"\"q\\\"\"\"\"]\"\n");
        assert_eq!(bytes, text.len() as u64);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn dropped_sink_leaves_no_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.json");
        let mut sink = Sink::open(DynamoExportFormat::Json, &target).unwrap();
        sink.write(&WireItem::new(), 0).unwrap();
        drop(sink);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    /// The sink moves through blocking tasks page by page and still produces the same file.
    #[tokio::test(flavor = "current_thread")]
    async fn pages_are_written_on_the_blocking_pool() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.jsonl");
        let open_target = target.clone();
        let sink = run_blocking(move || Sink::open(DynamoExportFormat::Jsonl, &open_target))
            .await
            .unwrap();
        let item =
            |v: &str| -> WireItem { serde_json::from_value(json!({ "pk": { "S": v } })).unwrap() };
        let (sink, rows) = write_page(sink, vec![item("a"), item("b")], 0).await.unwrap();
        let (sink, rows) = write_page(sink, vec![item("c")], rows).await.unwrap();
        assert_eq!(rows, 3);
        let finish_target = target.clone();
        let bytes = run_blocking(move || sink.finish(rows, &finish_target, &[])).await.unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert_eq!(bytes, text.len() as u64);
    }

    #[test]
    fn json_sink_writes_arrays() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.json");
        let sink = Sink::open(DynamoExportFormat::Json, &target).unwrap();
        sink.finish(0, &target, &[]).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "[]\n");
    }
}
