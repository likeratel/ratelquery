use std::sync::{Arc, Mutex, MutexGuard};

use super::model::ConnectionConfig;
use super::secrets::SecretStore;
use super::store::ConnectionStore;
use super::validate::{same_target, validate_config};
use crate::error::{AppError, AppResult};

/// Connection config CRUD plus secret handling. A mutex serializes read-modify-write cycles of
/// the JSON file.
pub struct ConnectionsService {
    store: ConnectionStore,
    secrets: Arc<dyn SecretStore>,
    lock: Mutex<()>,
}

fn require_id(id: &str) -> AppResult<&str> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("connection id must not be empty".into()));
    }
    Ok(trimmed)
}

fn retype_message(config: &ConnectionConfig) -> &'static str {
    match config {
        ConnectionConfig::Mysql(_) => "Enter the password again to test a different server",
        ConnectionConfig::Dynamodb(_) => {
            "Enter the secret access key again to test a different endpoint or key"
        }
    }
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

    /// Removes the secret, then the config. Deleting an unknown id is a no-op.
    ///
    /// The keyring is tried first so a failure is known before the config disappears; the
    /// config is removed either way, and a secret left behind is reported as `credential`.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let id = require_id(id)?;
        let _guard = self.guard()?;
        let secret_removed = self.secrets.delete(id);
        let existing = self.store.load()?;
        if existing.iter().any(|c| c.id() == id) {
            let remaining: Vec<ConnectionConfig> =
                existing.into_iter().filter(|c| c.id() != id).collect();
            self.store.save(&remaining)?;
        }
        secret_removed.map_err(|err| {
            AppError::Credential(format!(
                "The connection was removed, but its saved secret is still in the keychain: {err}"
            ))
        })
    }

    pub fn has_secret(&self, id: &str) -> AppResult<bool> {
        Ok(self.secrets.get(require_id(id)?)?.is_some())
    }

    /// Secret for `connections_test`. An explicit secret is used as is. Without one, the stored
    /// secret is only used when `config` (validated) still points at the server it was saved
    /// for, so a changed host, endpoint or user cannot receive it.
    pub fn resolve_test_secret(
        &self,
        config: &ConnectionConfig,
        secret: Option<&str>,
    ) -> AppResult<Option<String>> {
        if let Some(value) = secret {
            return Ok(Some(value.to_string()));
        }
        if config.id().is_empty() {
            return Ok(None);
        }
        let saved = match self.get(config.id()) {
            Ok(saved) => saved,
            Err(AppError::NotFound(_)) => return Ok(None),
            Err(err) => return Err(err),
        };
        let stored = self.secrets.get(config.id())?;
        if stored.is_some() && !same_target(&saved, config) {
            return Err(AppError::InvalidInput(retype_message(config).into()));
        }
        Ok(stored)
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
            tls: None,
            ca_cert_path: None,
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
    fn empty_ids_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        assert_eq!(svc.has_secret("").unwrap_err().kind(), "invalid_input");
        assert_eq!(svc.has_secret("  ").unwrap_err().kind(), "invalid_input");
        assert_eq!(svc.delete("").unwrap_err().kind(), "invalid_input");
    }

    /// Keyring whose delete always fails.
    #[derive(Default)]
    struct StuckSecrets(MemorySecretStore);

    impl SecretStore for StuckSecrets {
        fn get(&self, id: &str) -> AppResult<Option<String>> {
            self.0.get(id)
        }
        fn set(&self, id: &str, secret: &str) -> AppResult<()> {
            self.0.set(id, secret)
        }
        fn delete(&self, _id: &str) -> AppResult<()> {
            Err(AppError::Credential("keychain locked".into()))
        }
    }

    #[test]
    fn delete_removes_config_even_when_keyring_fails() {
        let dir = tempfile::tempdir().unwrap();
        let svc = ConnectionsService::new(
            ConnectionStore::new(dir.path()),
            Arc::new(StuckSecrets::default()),
        );
        let saved = svc.save(&config("", "a"), Some("pw")).unwrap();
        let err = svc.delete(saved.id()).unwrap_err();
        assert_eq!(err.kind(), "credential");
        assert!(err.to_string().contains("still in the keychain"), "{err}");
        assert!(svc.list().unwrap().is_empty(), "config removed despite the keyring error");
    }

    fn validated(config: &ConnectionConfig) -> ConnectionConfig {
        validate_config(config).unwrap()
    }

    #[test]
    fn test_secret_is_only_reused_for_the_saved_target() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let saved = svc.save(&config("", "a"), Some("stored")).unwrap();
        let resolve = |c: &ConnectionConfig| svc.resolve_test_secret(&validated(c), None);
        assert_eq!(resolve(&saved).unwrap().as_deref(), Some("stored"));
        let ConnectionConfig::Mysql(m) = &saved else { panic!() };
        let renamed = ConnectionConfig::Mysql(MysqlConnectionConfig {
            name: "renamed".into(),
            database: Some("other".into()),
            ..m.clone()
        });
        assert_eq!(resolve(&renamed).unwrap().as_deref(), Some("stored"));
        let elsewhere = ConnectionConfig::Mysql(MysqlConnectionConfig {
            host: "attacker.example".into(),
            ..m.clone()
        });
        let err = resolve(&elsewhere).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert_eq!(err.to_string(), "Enter the password again to test a different server");
        let explicit = svc.resolve_test_secret(&validated(&elsewhere), Some("typed")).unwrap();
        assert_eq!(explicit.as_deref(), Some("typed"));
        assert_eq!(resolve(&config("", "new")).unwrap(), None);
        assert_eq!(resolve(&config("unknown-id", "x")).unwrap(), None);
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
