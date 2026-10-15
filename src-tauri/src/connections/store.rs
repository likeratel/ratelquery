use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::model::ConnectionConfig;
use crate::error::{AppError, AppResult};
use crate::fsutil::create_private;

const FILE_NAME: &str = "connections.json";
const FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct FileContents {
    version: u32,
    connections: Vec<ConnectionConfig>,
}

/// Reads and atomically writes `<dir>/connections.json`.
#[derive(Debug, Clone)]
pub struct ConnectionStore {
    path: PathBuf,
}

impl ConnectionStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join(FILE_NAME) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Loads all configs. A missing file means no connections; a corrupt file is an error so
    /// that a later save never silently overwrites the user's data.
    pub fn load(&self) -> AppResult<Vec<ConnectionConfig>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(AppError::Io(format!("could not read {FILE_NAME}: {e}"))),
        };
        let contents: FileContents = serde_json::from_str(&text)
            .map_err(|e| AppError::Io(format!("{FILE_NAME} is not valid: {e}")))?;
        if contents.version > FORMAT_VERSION {
            return Err(AppError::Io(format!(
                "{FILE_NAME} was written by a newer version (format {})",
                contents.version
            )));
        }
        Ok(contents.connections)
    }

    /// Writes all configs via a temp file in the same directory followed by a rename.
    pub fn save(&self, connections: &[ConnectionConfig]) -> AppResult<()> {
        let dir = self
            .path
            .parent()
            .ok_or_else(|| AppError::Io("connections file has no parent directory".into()))?;
        fs::create_dir_all(dir)?;
        let contents = FileContents { version: FORMAT_VERSION, connections: connections.to_vec() };
        let json = serde_json::to_vec_pretty(&contents)
            .map_err(|e| AppError::Io(format!("could not encode connections: {e}")))?;
        let tmp = dir.join(format!(".{FILE_NAME}.{}.tmp", uuid::Uuid::new_v4()));
        let written = write_synced(&tmp, &json).and_then(|()| fs::rename(&tmp, &self.path));
        if let Err(e) = written {
            // Best effort cleanup; the original file is untouched either way.
            let _ = fs::remove_file(&tmp);
            return Err(AppError::Io(format!("could not write {FILE_NAME}: {e}")));
        }
        Ok(())
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = create_private(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::MysqlConnectionConfig;

    fn sample(id: &str) -> ConnectionConfig {
        ConnectionConfig::Mysql(MysqlConnectionConfig {
            id: id.into(),
            name: format!("n-{id}"),
            host: "h".into(),
            port: 1,
            user: "u".into(),
            database: None,
            color: None,
            tls: None,
            ca_cert_path: None,
        })
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ConnectionStore::new(dir.path()).load().unwrap().is_empty());
    }

    #[test]
    fn save_then_load_round_trips_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionStore::new(&dir.path().join("nested"));
        store.save(&[sample("a"), sample("b")]).unwrap();
        assert_eq!(store.load().unwrap(), vec![sample("a"), sample("b")]);
        let names: Vec<_> = fs::read_dir(dir.path().join("nested"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![FILE_NAME.to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn connections_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionStore::new(dir.path());
        store.save(&[sample("a")]).unwrap();
        store.save(&[sample("b")]).unwrap();
        let mode = fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn corrupt_file_is_an_io_error() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), "{not json").unwrap();
        let err = ConnectionStore::new(dir.path()).load().unwrap_err();
        assert_eq!(err.kind(), "io");
    }
}
