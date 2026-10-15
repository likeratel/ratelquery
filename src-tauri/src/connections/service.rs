use std::sync::{Arc, Mutex, MutexGuard};

use super::model::ConnectionConfig;
use super::secrets::SecretStore;
use super::store::ConnectionStore;
use super::validate::validate_config;
use crate::error::{AppError, AppResult};

/// Connection config CRUD plus secret handling. A mutex serializes read-modify-write cycles of
/// the JSON file.
pub struct ConnectionsService {
    store: ConnectionStore,
    secrets: Arc<dyn SecretStore>,
    lock: Mutex<()>,
}

fn sorted_by_name(configs: Vec<ConnectionConfig>) -> Vec<ConnectionConfig> {
    let mut sorted = configs;
    sorted.sort_by(|a, b| {
        a.name()
            .to_lowercase()
            .cmp(&b.name().to_lowercase())
            .then_with(|| a.name().cmp(b.name()))
            .then_with(|| a.id().cmp(b.id()))
    });
    sorted
}

fn upsert(configs: &[ConnectionConfig], config: &ConnectionConfig) -> Vec<ConnectionConfig> {
    let replaced: Vec<ConnectionConfig> = configs
        .iter()
        .map(|c| if c.id() == config.id() { config.clone() } else { c.clone() })
        .collect();
    if configs.iter().any(|c| c.id() == config.id()) {
        replaced
    } else {
        replaced.into_iter().chain(std::iter::once(config.clone())).collect()
    }
}

impl ConnectionsService {
    pub fn new(store: ConnectionStore, secrets: Arc<dyn SecretStore>) -> Self {
        Self { store, secrets, lock: Mutex::new(()) }
    }

    fn guard(&self) -> AppResult<MutexGuard<'_, ()>> {
        self.lock.lock().map_err(|_| AppError::Io("connections lock poisoned".into()))
    }

    pub fn list(&self) -> AppResult<Vec<ConnectionConfig>> {
        let _guard = self.guard()?;
        Ok(sorted_by_name(self.store.load()?))
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionConfig> {
        let _guard = self.guard()?;
        self.store
            .load()?
            .into_iter()
            .find(|c| c.id() == id)
            .ok_or_else(|| AppError::NotFound(format!("connection {id} does not exist")))
    }

    /// Validates and stores `config`, generating an id when it is empty.
    /// `secret`: `None` keeps the stored secret, `Some("")` clears it, otherwise replaces it.
    pub fn save(
        &self,
        config: &ConnectionConfig,
        secret: Option<&str>,
    ) -> AppResult<ConnectionConfig> {
        let normalized = validate_config(config)?;
        let saved = if normalized.id().is_empty() {
            normalized.with_id(&uuid::Uuid::new_v4().to_string())
        } else {
            normalized
        };
        let _guard = self.guard()?;
        let existing = self.store.load()?;
        let is_new = !existing.iter().any(|c| c.id() == saved.id());
        self.store.save(&upsert(&existing, &saved))?;
        if let Err(err) = self.apply_secret(saved.id(), secret) {
            if is_new {
                // Do not leave a new connection behind whose secret could not be stored.
                self.store.save(&existing)?;
            }
            return Err(err);
        }
        Ok(saved)
    }

    fn apply_secret(&self, id: &str, secret: Option<&str>) -> AppResult<()> {
        match secret {
            None => Ok(()),
            Some("") => self.secrets.delete(id),
            Some(value) => self.secrets.set(id, value),
        }
    }

    /// Removes the config and its secret. Deleting an unknown id is a no-op.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let _guard = self.guard()?;
        let existing = self.store.load()?;
        if existing.iter().any(|c| c.id() == id) {
            let remaining: Vec<ConnectionConfig> =
                existing.into_iter().filter(|c| c.id() != id).collect();
            self.store.save(&remaining)?;
        }
        self.secrets.delete(id)
    }

    pub fn has_secret(&self, id: &str) -> AppResult<bool> {
        Ok(self.secrets.get(id)?.is_some())
    }

    /// The explicitly passed secret, or the stored one for `id` when `secret` is `None`.
    pub fn resolve_secret(&self, id: &str, secret: Option<&str>) -> AppResult<Option<String>> {
        match secret {
            Some(value) => Ok(Some(value.to_string())),
            None if id.is_empty() => Ok(None),
            None => self.secrets.get(id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::MysqlConnectionConfig;
    use crate::connections::secrets::MemorySecretStore;

    fn config(id: &str, name: &str) -> ConnectionConfig {
        ConnectionConfig::Mysql(MysqlConnectionConfig {
            id: id.into(),
            name: name.into(),
            host: "127.0.0.1".into(),
            port: 3306,
            user: "dev".into(),
            database: None,
            color: None,
        })
    }

    fn service(dir: &std::path::Path) -> ConnectionsService {
        ConnectionsService::new(ConnectionStore::new(dir), Arc::new(MemorySecretStore::default()))
    }

    #[test]
    fn save_generates_id_and_lists_sorted() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let b = svc.save(&config("", "beta"), None).unwrap();
        let a = svc.save(&config("", "Alpha"), Some("pw")).unwrap();
        assert!(uuid::Uuid::parse_str(b.id()).is_ok());
        let names: Vec<_> = svc.list().unwrap().iter().map(|c| c.name().to_string()).collect();
        assert_eq!(names, vec!["Alpha", "beta"]);
        assert!(svc.has_secret(a.id()).unwrap());
        assert!(!svc.has_secret(b.id()).unwrap());
    }

    #[test]
    fn secret_null_keeps_and_empty_clears() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let saved = svc.save(&config("", "a"), Some("pw")).unwrap();
        svc.save(&saved, None).unwrap();
        assert_eq!(svc.resolve_secret(saved.id(), None).unwrap().as_deref(), Some("pw"));
        svc.save(&saved, Some("")).unwrap();
        assert!(!svc.has_secret(saved.id()).unwrap());
        assert_eq!(svc.list().unwrap().len(), 1);
    }

    #[test]
    fn delete_removes_config_and_secret() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let saved = svc.save(&config("", "a"), Some("pw")).unwrap();
        svc.delete(saved.id()).unwrap();
        assert!(svc.list().unwrap().is_empty());
        assert!(!svc.has_secret(saved.id()).unwrap());
        assert_eq!(svc.get(saved.id()).unwrap_err().kind(), "not_found");
        svc.delete("missing").unwrap();
    }

    #[test]
    fn invalid_config_is_not_saved() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        assert_eq!(svc.save(&config("", " "), None).unwrap_err().kind(), "invalid_input");
        assert!(svc.list().unwrap().is_empty());
    }

    #[test]
    fn explicit_secret_wins_over_stored() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let saved = svc.save(&config("", "a"), Some("stored")).unwrap();
        assert_eq!(svc.resolve_secret(saved.id(), Some("new")).unwrap().as_deref(), Some("new"));
        assert_eq!(svc.resolve_secret("", None).unwrap(), None);
    }
}
