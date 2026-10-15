//! CSV writer settings and error mapping shared by every CSV export.

use std::io::Write;

use crate::error::{AppError, AppResult};

/// RFC 4180 CSV with `\n` line ends, quoting only when needed.
pub fn csv_writer<W: Write>(out: W) -> csv::Writer<W> {
    csv::WriterBuilder::new()
        .terminator(csv::Terminator::Any(b'\n'))
        .quote_style(csv::QuoteStyle::Necessary)
        .from_writer(out)
}

pub fn csv_error(err: csv::Error) -> AppError {
    AppError::Io(format!("could not write CSV: {err}"))
}

/// Flushes the CSV writer and returns the underlying writer.
pub fn finish_csv<W: Write>(writer: csv::Writer<W>) -> AppResult<W> {
    writer.into_inner().map_err(|e| AppError::Io(format!("could not write CSV: {}", e.error())))
}

/// Serialization of data the app produced itself failing is an I/O problem of the export,
/// not bad user input.
pub fn json_error(err: serde_json::Error) -> AppError {
    AppError::Io(format!("could not encode JSON: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_necessary_quotes_and_newlines() {
        let mut writer = csv_writer(Vec::new());
        writer.write_record(["a,b", "c"]).map_err(csv_error).unwrap();
        assert_eq!(finish_csv(writer).unwrap(), b"\"a,b\",c\n");
        let bad = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        assert_eq!(json_error(bad).kind(), "io");
    }
}
