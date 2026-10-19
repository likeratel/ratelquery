//! Reads and atomically writes `<config dir>/workspace.json`.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::model::Workspace;
use crate::error::{AppError, AppResult};
use crate::fsutil::write_private_atomic;

const FILE_NAME: &str = "workspace.json";

#[derive(Debug, Clone)]
pub struct WorkspaceStore {
    path: PathBuf,
}

impl WorkspaceStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join(FILE_NAME) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The saved workspace. A missing file is `None`; so is a corrupt one, after logging why
    /// (the file is left as is until the next save replaces it). A file that exists but
    /// cannot be read is an `io` error.
    pub fn load(&self) -> AppResult<Option<Workspace>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::Io(format!("could not read {FILE_NAME}: {e}"))),
        };
        let parsed = serde_json::from_str::<Value>(&text)
            .map_err(|e| e.to_string())
            .and_then(|value| Workspace::from_file_value(&value));
        match parsed {
            Ok(workspace) => Ok(Some(workspace)),
            Err(reason) => {
                eprintln!("{FILE_NAME} is not valid ({reason}); starting without saved tabs");
                Ok(None)
            }
        }
    }

    /// Validates `input` (`invalid_input` on any problem, nothing written) and replaces the file.
    pub fn save(&self, input: Value) -> AppResult<()> {
        let workspace = Workspace::from_value(input)?;
        let json = serde_json::to_vec_pretty(&workspace)
            .map_err(|e| AppError::Io(format!("could not encode workspace: {e}")))?;
        write_private_atomic(&self.path, &json)
            .map_err(|e| AppError::Io(format!("could not write {FILE_NAME}: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::model::{TabEngine, TabKind, WorkspaceTab};
    use serde_json::json;

    fn sample() -> Workspace {
        Workspace {
            version: 1,
            active_tab_id: Some("t2".into()),
            tabs: vec![
                WorkspaceTab {
                    id: "t1".into(),
                    kind: TabKind::Query,
                    connection_id: "c1".into(),
                    engine: TabEngine::Mysql,
                    title: "Query 1".into(),
                    sql: "select 1;\n-- 한글".into(),
                    database: Some("app".into()),
                },
                WorkspaceTab {
                    id: "t2".into(),
                    kind: TabKind::Query,
                    connection_id: "c2".into(),
                    engine: TabEngine::Athena,
                    title: "Query 2".into(),
                    sql: String::new(),
                    database: None,
                },
            ],
        }
    }

    #[test]
    fn missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(WorkspaceStore::new(dir.path()).load().unwrap(), None);
    }

    #[test]
    fn round_trips_through_a_new_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path());
        store.save(serde_json::to_value(sample()).unwrap()).unwrap();
        assert_eq!(WorkspaceStore::new(dir.path()).load().unwrap(), Some(sample()));
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["workspace.json"]);
    }

    #[test]
    fn corrupt_file_is_none_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path());
        for bad in ["{nope", "[]", r#"{"version":9,"tabs":[]}"#] {
            std::fs::write(store.path(), bad).unwrap();
            assert_eq!(store.load().unwrap(), None, "{bad}");
            assert_eq!(std::fs::read_to_string(store.path()).unwrap(), bad);
        }
    }

    #[test]
    fn invalid_input_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path());
        let err = store.save(json!({ "version": 1, "activeTabId": "x", "tabs": [] })).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(!store.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path());
        store.save(serde_json::to_value(sample()).unwrap()).unwrap();
        store.save(serde_json::to_value(sample()).unwrap()).unwrap();
        let mode = std::fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
