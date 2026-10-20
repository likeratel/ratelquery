//! The query output log (what each executed statement returned) persisted as
//! `query-output.json`, so it survives a restart for the number of days set in Settings.

mod store;

pub use store::{MAX_FILE_BYTES, QUERY_OUTPUT_VERSION, QueryOutputStore};
