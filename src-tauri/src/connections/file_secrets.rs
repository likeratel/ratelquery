//! Secrets kept in `<config dir>/secrets.json`, protected by file permissions only.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use super::secrets::SecretStore;
use crate::error::{AppError, AppResult};
use crate::fsutil::write_private_atomic;

const FILE_NAME: &str = "secrets.json";

type Secrets = BTreeMap<String, String>;

/// A JSON object of connection id to secret, written atomically with owner-only permissions.
/// A mutex serializes read-modify-write cycles.
#[derive(Debug)]
pub struct FileSecretStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileSecretStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join(FILE_NAME), lock: Mutex::new(()) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn guard(&self) -> AppResult<MutexGuard<'_, ()>> {
        self.lock.lock().map_err(|_| AppError::Io("secrets file lock poisoned".into()))
    }

    /// A missing file holds no secrets; a corrupt one is an error so it is never overwritten.
    fn load(&self) -> AppResult<Secrets> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Secrets::new()),
            Err(e) => return Err(AppError::Io(format!("could not read {FILE_NAME}: {e}"))),
        };
        serde_json::from_str(&text)
            .map_err(|e| AppError::Io(format!("{FILE_NAME} is not valid: {e}")))
    }

    fn save(&self, secrets: &Secrets) -> AppResult<()> {
        let json = serde_json::to_vec_pretty(secrets)
            .map_err(|e| AppError::Io(format!("could not encode {FILE_NAME}: {e}")))?;
        write_private_atomic(&self.path, &json)
            .map_err(|e| AppError::Io(format!("could not write {FILE_NAME}: {e}")))
    }
}

impl SecretStore for FileSecretStore {
    fn get(&self, id: &str) -> AppResult<Option<String>> {
        let _guard = self.guard()?;
        Ok(self.load()?.get(id).cloned())
    }

    fn set(&self, id: &str, secret: &str) -> AppResult<()> {
        let _guard = self.guard()?;
        let next: Secrets = self
            .load()?
            .into_iter()
            .filter(|(key, _)| key != id)
            .chain(std::iter::once((id.to_string(), secret.to_string())))
            .collect();
        self.save(&next)
    }

    fn delete(&self, id: &str) -> AppResult<()> {
        let _guard = self.guard()?;
        let current = self.load()?;
        if !current.contains_key(id) {
            return Ok(());
        }
        let next: Secrets = current.into_iter().filter(|(key, _)| key != id).collect();
        self.save(&next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_replaces_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(&dir.path().join("nested"));
        assert_eq!(store.get("a").unwrap(), None);
        store.set("a", "one").unwrap();
        store.set("b", "two").unwrap();
        store.set("a", "uno").unwrap();
        assert_eq!(store.get("a").unwrap().as_deref(), Some("uno"));
        // A fresh instance reads the same file.
        let reopened = FileSecretStore::new(&dir.path().join("nested"));
        assert_eq!(reopened.get("b").unwrap().as_deref(), Some("two"));
        store.delete("a").unwrap();
        store.delete("missing").unwrap();
        assert_eq!(store.get("a").unwrap(), None);
        assert_eq!(store.get("b").unwrap().as_deref(), Some("two"));
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
        assert_eq!(on_disk, serde_json::json!({ "b": "two" }));
        let names: Vec<_> = fs::read_dir(dir.path().join("nested"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![FILE_NAME.to_string()]);
    }

    #[test]
    fn deleting_without_a_file_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path());
        store.delete("a").unwrap();
        assert!(!store.path().exists());
    }

    #[test]
    fn corrupt_file_is_an_io_error_and_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path());
        for bad in ["{not json", "[]", r#"{"a": 1}"#] {
            fs::write(store.path(), bad).unwrap();
            assert_eq!(store.get("a").unwrap_err().kind(), "io", "{bad}");
            assert_eq!(store.set("a", "x").unwrap_err().kind(), "io", "{bad}");
            assert_eq!(store.delete("a").unwrap_err().kind(), "io", "{bad}");
            assert_eq!(fs::read_to_string(store.path()).unwrap(), bad);
        }
    }

    #[cfg(unix)]
    #[test]
    fn secrets_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path());
        fs::write(store.path(), "{}").unwrap();
        fs::set_permissions(store.path(), fs::Permissions::from_mode(0o644)).unwrap();
        store.set("a", "x").unwrap();
        store.set("b", "y").unwrap();
        let mode = fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
