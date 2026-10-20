//! Reads and atomically writes `<config dir>/query-output.json`.
//!
//! The entries are opaque to the backend: the frontend owns their shape, validates what it
//! loads and prunes them by age and count. Only the envelope is checked here
//! (`{ version: 1, connections: { <id>: [...] } }`), together with a size limit.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::fsutil::write_private_atomic;

const FILE_NAME: &str = "query-output.json";
/// Where a corrupt or oversized file is moved, like `settings.json.bak`.
const BACKUP_NAME: &str = "query-output.json.bak";

/// The only format this build reads and writes.
pub const QUERY_OUTPUT_VERSION: u64 = 1;

/// Largest file read or written. The frontend caps the entries per connection, so this is only
/// reached through very long statements; a save over it is refused instead of growing the file.
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct QueryOutputStore {
    path: PathBuf,
}

/// `Err` with the reason when `value` is not a version 1 envelope whose `connections` maps
/// non-empty ids to arrays.
fn check_envelope(value: &Value) -> Result<(), String> {
    let obj = value.as_object().ok_or("not a JSON object")?;
    if obj.get("version").and_then(Value::as_u64) != Some(QUERY_OUTPUT_VERSION) {
        return Err(format!("version is not {QUERY_OUTPUT_VERSION}"));
    }
    let connections =
        obj.get("connections").and_then(Value::as_object).ok_or("connections is not an object")?;
    for (id, entries) in connections {
        if id.is_empty() {
            return Err("a connection id is empty".into());
        }
        if !entries.is_array() {
            return Err(format!("entries of {id} are not an array"));
        }
    }
    Ok(())
}

impl QueryOutputStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join(FILE_NAME) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn backup_path(&self) -> PathBuf {
        self.path.with_file_name(BACKUP_NAME)
    }

    /// Moves a corrupt or oversized file to `query-output.json.bak` (replacing an older backup)
    /// so the next save doesn't destroy it, and logs why. When it can't be moved this is an `io`
    /// error, so the frontend leaves saving off rather than overwrite it.
    fn set_aside(&self, reason: &str) -> AppResult<Option<Value>> {
        let backup = self.backup_path();
        fs::rename(&self.path, &backup).map_err(|e| {
            AppError::Io(format!("{FILE_NAME} is {reason} and could not be moved aside: {e}"))
        })?;
        eprintln!("{FILE_NAME} is {reason}; moved it to {BACKUP_NAME} and started without it");
        Ok(None)
    }

    /// The saved log. A missing file is `None`; so is a corrupt or oversized one, which is
    /// moved to `query-output.json.bak` first (see `set_aside`). A file that exists but cannot
    /// be read is an `io` error.
    pub fn load(&self) -> AppResult<Option<Value>> {
        let size = match fs::metadata(&self.path) {
            Ok(meta) => meta.len(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::Io(format!("could not read {FILE_NAME}: {e}"))),
        };
        if size > MAX_FILE_BYTES {
            return self.set_aside(&format!("larger than {MAX_FILE_BYTES} bytes"));
        }
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::Io(format!("could not read {FILE_NAME}: {e}"))),
        };
        let parsed = serde_json::from_str::<Value>(&text)
            .map_err(|e| e.to_string())
            .and_then(|value| check_envelope(&value).map(|()| value));
        match parsed {
            Ok(value) => Ok(Some(value)),
            Err(reason) => self.set_aside(&format!("not valid ({reason})")),
        }
    }

    /// Replaces the file with `input`, or removes it when `input` is null (output kept for the
    /// session only). A malformed envelope or a body over [`MAX_FILE_BYTES`] is `invalid_input`
    /// and nothing is written.
    pub fn save(&self, input: Value) -> AppResult<()> {
        if input.is_null() {
            return self.remove();
        }
        check_envelope(&input).map_err(|reason| {
            AppError::InvalidInput(format!("query output is not valid: {reason}"))
        })?;
        let json = serde_json::to_vec(&input)
            .map_err(|e| AppError::Io(format!("could not encode query output: {e}")))?;
        if u64::try_from(json.len()).unwrap_or(u64::MAX) > MAX_FILE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "query output is larger than {MAX_FILE_BYTES} bytes"
            )));
        }
        write_private_atomic(&self.path, &json)
            .map_err(|e| AppError::Io(format!("could not write {FILE_NAME}: {e}")))
    }

    fn remove(&self) -> AppResult<()> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::Io(format!("could not remove {FILE_NAME}: {e}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "version": 1,
            "connections": {
                "c1": [{ "id": "e1", "sql": "select 1;\n-- 한글", "at": 1 }],
                "c2": []
            }
        })
    }

    #[test]
    fn missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(QueryOutputStore::new(dir.path()).load().unwrap(), None);
    }

    #[test]
    fn round_trips_through_a_new_store() {
        let dir = tempfile::tempdir().unwrap();
        QueryOutputStore::new(dir.path()).save(sample()).unwrap();
        assert_eq!(QueryOutputStore::new(dir.path()).load().unwrap(), Some(sample()));
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["query-output.json"]);
    }

    #[test]
    fn null_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = QueryOutputStore::new(dir.path());
        store.save(Value::Null).unwrap();
        store.save(sample()).unwrap();
        store.save(Value::Null).unwrap();
        assert!(!store.path().exists());
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn corrupt_file_is_none_and_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let store = QueryOutputStore::new(dir.path());
        for bad in [
            "{nope",
            "[]",
            r#"{"version":2,"connections":{}}"#,
            r#"{"version":1,"connections":{"c1":{}}}"#,
            r#"{"version":1}"#,
        ] {
            std::fs::write(store.path(), bad).unwrap();
            assert_eq!(store.load().unwrap(), None, "{bad}");
            assert!(!store.path().exists(), "{bad}");
            assert_eq!(std::fs::read_to_string(store.backup_path()).unwrap(), bad);
        }
        // The next save leaves the backup alone.
        store.save(sample()).unwrap();
        assert_eq!(std::fs::read_to_string(store.backup_path()).unwrap(), r#"{"version":1}"#);
    }

    #[cfg(unix)]
    #[test]
    fn a_corrupt_file_that_cannot_be_moved_is_an_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = QueryOutputStore::new(dir.path());
        std::fs::write(store.path(), "{nope").unwrap();
        // A directory where the backup goes can't be replaced by a file.
        std::fs::create_dir(store.backup_path()).unwrap();
        std::fs::write(store.backup_path().join("keep"), "x").unwrap();
        let err = store.load().unwrap_err();
        assert_eq!(err.kind(), "io");
        assert_eq!(std::fs::read_to_string(store.path()).unwrap(), "{nope");
    }

    #[test]
    fn invalid_input_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = QueryOutputStore::new(dir.path());
        for bad in [
            json!("x"),
            json!({ "version": 2, "connections": {} }),
            json!({ "version": 1, "connections": [] }),
            json!({ "version": 1, "connections": { "": [] } }),
            json!({ "version": 1, "connections": { "c1": 5 } }),
        ] {
            let err = store.save(bad.clone()).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{bad}");
        }
        assert!(!store.path().exists());
    }

    #[test]
    fn oversized_output_is_refused_and_an_oversized_file_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let store = QueryOutputStore::new(dir.path());
        let huge = "x".repeat(usize::try_from(MAX_FILE_BYTES).unwrap());
        let input = json!({ "version": 1, "connections": { "c1": [{ "sql": huge }] } });
        assert_eq!(store.save(input.clone()).unwrap_err().kind(), "invalid_input");
        assert!(!store.path().exists());
        std::fs::write(store.path(), serde_json::to_vec(&input).unwrap()).unwrap();
        assert_eq!(store.load().unwrap(), None);
        assert!(!store.path().exists(), "an oversized file is moved aside");
        assert!(store.backup_path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn output_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = QueryOutputStore::new(dir.path());
        store.save(sample()).unwrap();
        store.save(sample()).unwrap();
        let mode = std::fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
