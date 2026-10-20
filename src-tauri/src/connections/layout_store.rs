//! Reads and atomically writes `<config dir>/connection-layout.json`: the sidebar order of the
//! saved connections and the folders they are grouped in. The frontend owns the shape and
//! validates what it reads; the backend only checks that it is a version 1 object of bounded
//! size, so a broken file can never grow without limit or be mistaken for another format.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::fsutil::write_private_atomic;

const FILE_NAME: &str = "connection-layout.json";

/// The only format this build reads and writes.
pub const LAYOUT_VERSION: u64 = 1;

/// Upper bound of the encoded layout; thousands of connections and folders fit easily.
pub const MAX_LAYOUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ConnectionLayoutStore {
    path: PathBuf,
}

/// `Err` with the reason when `value` is not a version 1 layout object.
fn check(value: &Value) -> Result<(), String> {
    let obj = value.as_object().ok_or("not a JSON object")?;
    if obj.get("version").and_then(Value::as_u64) != Some(LAYOUT_VERSION) {
        return Err(format!("version is not {LAYOUT_VERSION}"));
    }
    Ok(())
}

impl ConnectionLayoutStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join(FILE_NAME) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The saved layout. A missing file is `None`; so is a corrupt or oversized one, after
    /// logging why (the file is left as is until the next save replaces it). A file that
    /// exists but cannot be read is an `io` error.
    pub fn load(&self) -> AppResult<Option<Value>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::Io(format!("could not read {FILE_NAME}: {e}"))),
        };
        let parsed = if text.len() > MAX_LAYOUT_BYTES {
            Err(format!("larger than {MAX_LAYOUT_BYTES} bytes"))
        } else {
            serde_json::from_str::<Value>(&text)
                .map_err(|e| e.to_string())
                .and_then(|value| check(&value).map(|()| value))
        };
        match parsed {
            Ok(layout) => Ok(Some(layout)),
            Err(reason) => {
                eprintln!("{FILE_NAME} is not valid ({reason}); using the default order");
                Ok(None)
            }
        }
    }

    /// Checks `input` (`invalid_input` when it is not a version 1 object or too large, nothing
    /// written) and replaces the file.
    pub fn save(&self, input: Value) -> AppResult<()> {
        check(&input).map_err(|reason| AppError::InvalidInput(format!("layout is {reason}")))?;
        let json = serde_json::to_vec_pretty(&input)
            .map_err(|e| AppError::Io(format!("could not encode the layout: {e}")))?;
        if json.len() > MAX_LAYOUT_BYTES {
            return Err(AppError::InvalidInput(format!(
                "layout is larger than {MAX_LAYOUT_BYTES} bytes"
            )));
        }
        write_private_atomic(&self.path, &json)
            .map_err(|e| AppError::Io(format!("could not write {FILE_NAME}: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "version": 1,
            "folders": [{ "id": "f1", "name": "Prod 한글", "collapsed": true }],
            "items": [
                { "type": "folder", "id": "f1", "children": ["c2"] },
                { "type": "connection", "id": "c1" }
            ]
        })
    }

    #[test]
    fn missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(ConnectionLayoutStore::new(dir.path()).load().unwrap(), None);
    }

    #[test]
    fn round_trips_through_a_new_store() {
        let dir = tempfile::tempdir().unwrap();
        ConnectionLayoutStore::new(dir.path()).save(sample()).unwrap();
        assert_eq!(ConnectionLayoutStore::new(dir.path()).load().unwrap(), Some(sample()));
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["connection-layout.json"]);
    }

    #[test]
    fn corrupt_or_oversized_file_is_none_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionLayoutStore::new(dir.path());
        let huge = format!(r#"{{"version":1,"pad":"{}"}}"#, "x".repeat(MAX_LAYOUT_BYTES));
        for bad in ["{nope", "[]", r#"{"version":2,"items":[]}"#, huge.as_str()] {
            std::fs::write(store.path(), bad).unwrap();
            assert_eq!(store.load().unwrap(), None);
            assert_eq!(std::fs::read_to_string(store.path()).unwrap(), bad);
        }
    }

    #[test]
    fn invalid_input_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionLayoutStore::new(dir.path());
        let huge = json!({ "version": 1, "pad": "x".repeat(MAX_LAYOUT_BYTES) });
        for bad in [json!("x"), json!([]), json!({ "version": 2 }), json!({ "items": [] }), huge] {
            assert_eq!(store.save(bad).unwrap_err().kind(), "invalid_input");
        }
        assert!(!store.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn layout_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionLayoutStore::new(dir.path());
        store.save(sample()).unwrap();
        let mode = std::fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
