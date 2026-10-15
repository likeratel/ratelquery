use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::time::Instant;

use super::file::{AtomicFile, validate_target};
use super::format::{csv_field, json_value, sql_literal};
use super::model::{ExportFormat, ExportOptions, ExportResult};
use crate::error::{AppError, AppResult};
use crate::mysql::{Cell, ColumnInfo, quote_ident};

const BUFFER_SIZE: usize = 64 * 1024;

/// Counts bytes written through it.
pub struct CountingWriter<W: Write> {
    inner: W,
    bytes: u64,
}

impl<W: Write> CountingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self { inner, bytes: 0 }
    }

    pub fn into_parts(self) -> (W, u64) {
        (self.inner, self.bytes)
    }
}

impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.bytes += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

enum Inner<W: Write> {
    Csv(Box<csv::Writer<CountingWriter<W>>>),
    Json { out: CountingWriter<W>, keys: Vec<String> },
    Sql { out: CountingWriter<W>, prefix: String },
}

/// Streams rows in one export format.
pub struct RowWriter<W: Write> {
    inner: Inner<W>,
    width: usize,
    rows: u64,
}

fn csv_error(err: csv::Error) -> AppError {
    AppError::Io(format!("could not write CSV: {err}"))
}

impl<W: Write> RowWriter<W> {
    pub fn new(out: W, columns: &[String], options: &ExportOptions) -> AppResult<Self> {
        let out = CountingWriter::new(out);
        let inner = match options.format {
            ExportFormat::Csv => {
                let mut writer = csv::WriterBuilder::new()
                    .terminator(csv::Terminator::Any(b'\n'))
                    .quote_style(csv::QuoteStyle::Necessary)
                    .from_writer(out);
                if options.include_header() {
                    writer.write_record(columns).map_err(csv_error)?;
                }
                Inner::Csv(Box::new(writer))
            }
            ExportFormat::Json => {
                let keys = columns.iter().map(serde_json::to_string).collect::<Result<_, _>>()?;
                Inner::Json { out, keys }
            }
            ExportFormat::Sql => {
                let names: Vec<String> = columns.iter().map(|c| quote_ident(c)).collect();
                let prefix = format!(
                    "INSERT INTO {} ({}) VALUES (",
                    quote_ident(options.table_name()),
                    names.join(", ")
                );
                Inner::Sql { out, prefix }
            }
        };
        Ok(Self { inner, width: columns.len(), rows: 0 })
    }

    pub fn write_row(&mut self, cells: &[Cell]) -> AppResult<()> {
        if cells.len() != self.width {
            return Err(AppError::InvalidInput(format!(
                "row {} has {} cells but there are {} columns",
                self.rows + 1,
                cells.len(),
                self.width
            )));
        }
        let first = self.rows == 0;
        match &mut self.inner {
            Inner::Csv(writer) => writer
                .write_record(cells.iter().map(|c| csv_field(c).into_owned()))
                .map_err(csv_error)?,
            Inner::Json { out, keys } => {
                let pairs: Vec<String> = keys
                    .iter()
                    .zip(cells)
                    .map(|(k, c)| format!("{k}: {}", json_value(c)))
                    .collect();
                let lead = if first { "[\n  " } else { ",\n  " };
                write!(out, "{lead}{{{}}}", pairs.join(", "))?;
            }
            Inner::Sql { out, prefix } => {
                let values = cells.iter().map(sql_literal).collect::<AppResult<Vec<_>>>()?;
                writeln!(out, "{prefix}{});", values.join(", "))?;
            }
        }
        self.rows += 1;
        Ok(())
    }

    pub fn rows(&self) -> u64 {
        self.rows
    }

    /// Writes any trailer and returns the inner writer, row count and byte count.
    pub fn finish(self) -> AppResult<(W, u64, u64)> {
        let counting = match self.inner {
            Inner::Csv(writer) => writer
                .into_inner()
                .map_err(|e| AppError::Io(format!("could not write CSV: {}", e.error())))?,
            Inner::Json { mut out, .. } => {
                out.write_all(if self.rows == 0 { b"[]\n" } else { b"\n]\n" })?;
                out
            }
            Inner::Sql { out, .. } => out,
        };
        let (mut inner, bytes) = counting.into_parts();
        inner.flush()?;
        Ok((inner, self.rows, bytes))
    }
}

/// Opens an atomic target file wrapped in a buffered row writer.
pub fn open_file_writer(
    columns: &[String],
    options: &ExportOptions,
) -> AppResult<(AtomicFile, RowWriter<BufWriter<File>>)> {
    let target = validate_target(&options.path)?;
    let (atomic, file) = AtomicFile::create(&target)?;
    let writer = RowWriter::new(BufWriter::with_capacity(BUFFER_SIZE, file), columns, options)?;
    Ok((atomic, writer))
}

/// Finishes the writer and moves the file into place.
pub fn commit_file_writer(
    atomic: AtomicFile,
    writer: RowWriter<BufWriter<File>>,
) -> AppResult<(u64, u64)> {
    let (buffered, rows, bytes) = writer.finish()?;
    let file = buffered.into_inner().map_err(|e| AppError::Io(e.error().to_string()))?;
    atomic.commit(file)?;
    Ok((rows, bytes))
}

/// `export_rows`: writes rows already held by the frontend.
pub fn export_rows(
    columns: &[ColumnInfo],
    rows: &[Vec<Cell>],
    options: &ExportOptions,
) -> AppResult<ExportResult> {
    let start = Instant::now();
    let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
    let (atomic, mut writer) = open_file_writer(&names, options)?;
    for row in rows {
        writer.write_row(row)?;
    }
    let (rows, bytes) = commit_file_writer(atomic, writer)?;
    let elapsed_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(ExportResult { rows, bytes, elapsed_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(format: ExportFormat) -> ExportOptions {
        ExportOptions {
            format,
            path: String::new(),
            table_name: None,
            include_header: None,
            database: None,
        }
    }

    fn render(format: ExportFormat, rows: &[Vec<Cell>]) -> (String, u64) {
        let columns = vec!["id".to_string(), "na\"me".to_string()];
        let mut writer = RowWriter::new(Vec::new(), &columns, &options(format)).unwrap();
        for row in rows {
            writer.write_row(row).unwrap();
        }
        let (out, _, bytes) = writer.finish().unwrap();
        (String::from_utf8(out).unwrap(), bytes)
    }

    fn sample() -> Vec<Vec<Cell>> {
        vec![
            vec![Cell::Int("1".into()), Cell::Str("a,b \"q\"".into())],
            vec![Cell::Int("99999999999999999999".into()), Cell::Null],
        ]
    }

    #[test]
    fn csv_follows_rfc4180_with_lf() {
        let (text, bytes) = render(ExportFormat::Csv, &sample());
        assert_eq!(text, "id,\"na\"\"me\"\n1,\"a,b \"\"q\"\"\"\n99999999999999999999,\n");
        assert_eq!(bytes, text.len() as u64);
    }

    #[test]
    fn json_writes_array_of_objects() {
        let (text, _) = render(ExportFormat::Json, &sample());
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!([
                { "id": 1, "na\"me": "a,b \"q\"" },
                { "id": "99999999999999999999", "na\"me": null }
            ])
        );
        assert_eq!(render(ExportFormat::Json, &[]).0, "[]\n");
    }

    #[test]
    fn sql_writes_one_insert_per_line() {
        let (text, _) = render(ExportFormat::Sql, &sample());
        assert_eq!(
            text,
            "INSERT INTO `export` (`id`, `na\"me`) VALUES (1, 'a,b \\\"q\\\"');\n\
             INSERT INTO `export` (`id`, `na\"me`) VALUES (99999999999999999999, NULL);\n"
        );
    }

    #[test]
    fn rejects_rows_with_wrong_width() {
        let columns = vec!["a".to_string()];
        let mut writer = RowWriter::new(Vec::new(), &columns, &options(ExportFormat::Csv)).unwrap();
        assert_eq!(writer.write_row(&[]).unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn csv_header_can_be_disabled() {
        let columns = vec!["a".to_string()];
        let opts = ExportOptions { include_header: Some(false), ..options(ExportFormat::Csv) };
        let mut writer = RowWriter::new(Vec::new(), &columns, &opts).unwrap();
        writer.write_row(&[Cell::Bool(true)]).unwrap();
        assert_eq!(String::from_utf8(writer.finish().unwrap().0).unwrap(), "1\n");
    }

    #[test]
    fn export_rows_writes_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.sql");
        let opts = ExportOptions {
            path: path.to_string_lossy().into_owned(),
            table_name: Some("t".into()),
            ..options(ExportFormat::Sql)
        };
        let columns = vec![ColumnInfo {
            name: "a".into(),
            type_name: "INT".into(),
            table: None,
            nullable: true,
        }];
        let result = export_rows(&columns, &[vec![Cell::Int("5".into())]], &opts).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "INSERT INTO `t` (`a`) VALUES (5);\n");
        assert_eq!((result.rows, result.bytes), (1, text.len() as u64));
    }
}
