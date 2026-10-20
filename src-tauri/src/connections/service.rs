use std::sync::{Arc, Mutex, MutexGuard};

use super::duplicate::copy_name;
use super::model::ConnectionConfig;
use super::secrets::{SecretSlot, SecretStore, StuckSecret};
use super::store::ConnectionStore;
use super::validate::{same_ssh_target, same_target, validate_config};
use crate::error::{AppError, AppResult};

/// Connection config CRUD plus secret handling. A mutex serializes read-modify-write cycles of
/// the JSON file.
pub struct ConnectionsService {
    store: ConnectionStore,
    secrets: Arc<dyn SecretStore>,
    lock: Mutex<()>,
}

/// Ids are compared trimmed everywhere, like `validate_config` stores them.
fn normalize_id(id: &str) -> &str {
    id.trim()
}

fn require_id(id: &str) -> AppResult<&str> {
    let trimmed = normalize_id(id);
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("connection id must not be empty".into()));
    }
    Ok(trimmed)
}

fn retarget_message(config: &ConnectionConfig) -> &'static str {
    match config {
        ConnectionConfig::Mysql(_) => "Enter the password again for the new server",
        ConnectionConfig::Dynamodb(_) | ConnectionConfig::Athena(_) => {
            "Enter the secret access key again for the new endpoint or key"
        }
    }
}

fn retype_message(config: &ConnectionConfig) -> &'static str {
    match config {
        ConnectionConfig::Mysql(_) => "Enter the password again to test a different server",
        ConnectionConfig::Dynamodb(_) | ConnectionConfig::Athena(_) => {
            "Enter the secret access key again to test a different endpoint or key"
        }
    }
}

const SSH_RETARGET_MESSAGE: &str =
    "Enter the SSH password or key passphrase again for the new SSH server or key";
const SSH_RETYPE_MESSAGE: &str =
    "Enter the SSH password or key passphrase again to test a different SSH server or key";

fn has_ssh(config: &ConnectionConfig) -> bool {
    matches!(config, ConnectionConfig::Mysql(c) if c.ssh.is_some())
}

/// What to do with the stored SSH secret on save: `None` keeps it, `Some("")` clears it,
/// otherwise replaces it. A config without SSH keeps no SSH secret: it is cleared when the
/// previous config had SSH, and a given value is ignored.
fn ssh_secret_action<'a>(
    previous: Option<&ConnectionConfig>,
    saved: &ConnectionConfig,
    ssh_secret: Option<&'a str>,
) -> Option<&'a str> {
    if has_ssh(saved) {
        ssh_secret
    } else if previous.is_some_and(has_ssh) {
        Some("")
    } else {
        None
    }
}

/// One stored secret entry (db or SSH) and the rules that guard its reuse.
struct Slot {
    key: String,
    same: fn(&ConnectionConfig, &ConnectionConfig) -> bool,
}

impl Slot {
    fn db(id: &str) -> Self {
        Slot { key: SecretSlot::Db.key(id), same: same_target }
    }

    fn ssh(id: &str) -> Self {
        Slot { key: SecretSlot::Ssh.key(id), same: same_ssh_target }
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
        let id = normalize_id(id);
        let _guard = self.guard()?;
        self.store
            .load()?
            .into_iter()
            .find(|c| c.id() == id)
            .ok_or_else(|| AppError::NotFound(format!("connection {id} does not exist")))
    }

    /// Runs `work` while no config is saved or deleted. `work` gets a loader for the saved
    /// connection ids (read only when called).
    pub fn while_locked<T>(
        &self,
        work: impl FnOnce(&dyn Fn() -> AppResult<Vec<String>>) -> AppResult<T>,
    ) -> AppResult<T> {
        let _guard = self.guard()?;
        let ids = || Ok(self.store.load()?.iter().map(|c| c.id().to_string()).collect());
        work(&ids)
    }

    /// A kept secret (`secret == None`) must not follow the config to another server: when the
    /// saved config had a stored secret in `slot` and its destination changed, the secret is
    /// asked for again.
    fn check_kept_secret(
        &self,
        previous: Option<&ConnectionConfig>,
        saved: &ConnectionConfig,
        slot: &Slot,
        secret: Option<&str>,
    ) -> AppResult<bool> {
        let Some(previous) = previous.filter(|_| secret.is_none()) else { return Ok(true) };
        let previous = validate_config(previous).unwrap_or_else(|_| previous.clone());
        Ok((slot.same)(&previous, saved) || self.secrets.get(&slot.key)?.is_none())
    }

    /// [`ConnectionsService::save_with_ssh`] keeping the stored SSH secret.
    pub fn save(
        &self,
        config: &ConnectionConfig,
        secret: Option<&str>,
    ) -> AppResult<ConnectionConfig> {
        self.save_with_ssh(config, secret, None)
    }

    /// Validates and stores `config`, generating an id when it is empty.
    /// `secret` / `ssh_secret`: `None` keeps the stored secret, `Some("")` clears it, otherwise
    /// replaces it. Keeping a stored secret while pointing the config at another server (or
    /// another SSH bastion or key) is rejected. A config without SSH keeps no SSH secret.
    pub fn save_with_ssh(
        &self,
        config: &ConnectionConfig,
        secret: Option<&str>,
        ssh_secret: Option<&str>,
    ) -> AppResult<ConnectionConfig> {
        let normalized = validate_config(config)?;
        let saved = if normalized.id().is_empty() {
            normalized.with_id(&uuid::Uuid::new_v4().to_string())
        } else {
            normalized
        };
        let _guard = self.guard()?;
        let existing = self.store.load()?;
        let previous = existing.iter().find(|c| c.id() == saved.id());
        let ssh_secret = ssh_secret_action(previous, &saved, ssh_secret);
        let (db, ssh) = (Slot::db(saved.id()), Slot::ssh(saved.id()));
        if !self.check_kept_secret(previous, &saved, &db, secret)? {
            return Err(AppError::InvalidInput(retarget_message(&saved).into()));
        }
        if has_ssh(&saved) && !self.check_kept_secret(previous, &saved, &ssh, ssh_secret)? {
            return Err(AppError::InvalidInput(SSH_RETARGET_MESSAGE.into()));
        }
        let is_new = previous.is_none();
        self.store.save(&upsert(&existing, &saved))?;
        let applied = self
            .apply_secret(&db.key, secret)
            .and_then(|()| self.apply_secret(&ssh.key, ssh_secret));
        if let Err(err) = applied {
            if is_new {
                // Do not leave a new connection behind whose secrets could not be stored.
                self.store.save(&existing)?;
                if secret.is_some_and(|s| !s.is_empty())
                    && let Err(cleanup) = self.secrets.delete(&db.key)
                {
                    eprintln!("could not remove the secret of {}: {cleanup}", saved.id());
                }
            }
            return Err(err);
        }
        Ok(saved)
    }

    /// Saves a copy of connection `id` under a new id and a free "<name> copy" name, with its
    /// stored secrets (database and SSH) copied inside the backend. When a secret cannot be
    /// copied the copy is removed again, secrets included, and the error returned.
    pub fn duplicate(&self, id: &str) -> AppResult<ConnectionConfig> {
        let id = require_id(id)?;
        let _guard = self.guard()?;
        let existing = self.store.load()?;
        let source = existing
            .iter()
            .find(|c| c.id() == id)
            .ok_or_else(|| AppError::NotFound(format!("connection {id} does not exist")))?;
        let name = copy_name(source.name(), existing.iter().map(ConnectionConfig::name));
        let copy = source.with_id(&uuid::Uuid::new_v4().to_string()).with_name(&name);
        let slots: Vec<SecretSlot> = if has_ssh(source) {
            vec![SecretSlot::Db, SecretSlot::Ssh]
        } else {
            vec![SecretSlot::Db]
        };
        self.store.save(&upsert(&existing, &copy))?;
        let copied = slots.iter().try_for_each(|slot| self.copy_secret(*slot, id, copy.id()));
        if let Err(err) = copied {
            // Do not leave a copy behind that is missing secrets the original has. The copied
            // secrets are removed even when restoring the list fails, and that failure is
            // reported over the copy error.
            let restored = self.store.save(&existing);
            for slot in &slots {
                if let Err(cleanup) = self.secrets.delete(&slot.key(copy.id())) {
                    eprintln!("could not remove the copied secret of {}: {cleanup}", copy.id());
                }
            }
            if let Err(restore) = restored {
                eprintln!("could not copy the secrets of {id}: {err}");
                return Err(restore);
            }
            return Err(err);
        }
        Ok(copy)
    }

    fn copy_secret(&self, slot: SecretSlot, from: &str, to: &str) -> AppResult<()> {
        match self.secrets.get(&slot.key(from))? {
            Some(secret) => self.secrets.set(&slot.key(to), &secret),
            None => Ok(()),
        }
    }

    fn apply_secret(&self, key: &str, secret: Option<&str>) -> AppResult<()> {
        match secret {
            None => Ok(()),
            Some("") => self.secrets.delete(key),
            Some(value) => self.secrets.set(key, value),
        }
    }

    /// Removes the secrets (database and SSH, from every secret store), then the config.
    /// Deleting an unknown id is a no-op.
    ///
    /// The secrets are removed first so a failure is known before the config disappears; the
    /// config is removed either way, and a secret left in the active store is reported as
    /// `credential`.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let id = require_id(id)?;
        let _guard = self.guard()?;
        let db_removed = self.secrets.delete_everywhere(id);
        let ssh_removed = self.secrets.delete_everywhere(&SecretSlot::Ssh.key(id));
        let existing = self.store.load()?;
        if existing.iter().any(|c| c.id() == id) {
            let remaining: Vec<ConnectionConfig> =
                existing.into_iter().filter(|c| c.id() != id).collect();
            self.store.save(&remaining)?;
        }
        db_removed.and(ssh_removed).map_err(|stuck: StuckSecret| {
            AppError::Credential(format!(
                "The connection was removed, but its saved secret is still in {}: {}",
                stuck.location, stuck.error
            ))
        })
    }

    /// Whether the database secret of `id` is stored.
    pub fn has_secret(&self, id: &str) -> AppResult<bool> {
        self.has_secret_in(id, SecretSlot::Db)
    }

    pub fn has_secret_in(&self, id: &str, slot: SecretSlot) -> AppResult<bool> {
        Ok(self.secrets.get(&slot.key(require_id(id)?))?.is_some())
    }

    /// Secret for `connections_test`. An explicit secret is used as is. Without one, the stored
    /// secret is only used when `config` (validated) still points at the server it was saved
    /// for, so a changed host, endpoint or user cannot receive it.
    pub fn resolve_test_secret(
        &self,
        config: &ConnectionConfig,
        secret: Option<&str>,
    ) -> AppResult<Option<String>> {
        self.resolve_test(config, secret, &Slot::db(config.id()), retype_message(config))
    }

    /// Like [`ConnectionsService::resolve_test_secret`] for the SSH secret: the stored one is
    /// only used for the bastion, user and key it was saved for. `None` for configs without
    /// SSH.
    pub fn resolve_test_ssh_secret(
        &self,
        config: &ConnectionConfig,
        ssh_secret: Option<&str>,
    ) -> AppResult<Option<String>> {
        if !has_ssh(config) {
            return Ok(None);
        }
        self.resolve_test(config, ssh_secret, &Slot::ssh(config.id()), SSH_RETYPE_MESSAGE)
    }

    fn resolve_test(
        &self,
        config: &ConnectionConfig,
        secret: Option<&str>,
        slot: &Slot,
        retype: &str,
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
        let stored = self.secrets.get(&slot.key)?;
        if stored.is_some() && !(slot.same)(&saved, config) {
            return Err(AppError::InvalidInput(retype.into()));
        }
        Ok(stored)
    }

    /// The explicitly passed secret, or the stored database secret for `id` when `secret` is
    /// `None`.
    pub fn resolve_secret(&self, id: &str, secret: Option<&str>) -> AppResult<Option<String>> {
        self.resolve_secret_in(id, SecretSlot::Db, secret)
    }

    /// The explicitly passed secret, or the one stored in `slot` of `id` when `secret` is
    /// `None`.
    pub fn resolve_secret_in(
        &self,
        id: &str,
        slot: SecretSlot,
        secret: Option<&str>,
    ) -> AppResult<Option<String>> {
        let id = normalize_id(id);
        match secret {
            Some(value) => Ok(Some(value.to_string())),
            None if id.is_empty() => Ok(None),
            None => self.secrets.get(&slot.key(id)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::{MysqlConnectionConfig, SshAuth, SshConfig};
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
            ssh: None,
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

    #[test]
    fn delete_names_the_file_store_when_it_keeps_the_secret() {
        #[derive(Default)]
        struct StuckFile(MemorySecretStore);
        impl SecretStore for StuckFile {
            fn get(&self, id: &str) -> AppResult<Option<String>> {
                self.0.get(id)
            }
            fn set(&self, id: &str, secret: &str) -> AppResult<()> {
                self.0.set(id, secret)
            }
            fn delete(&self, _id: &str) -> AppResult<()> {
                Err(AppError::Io("disk full".into()))
            }
            fn location(&self) -> &'static str {
                "secrets.json"
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let svc = ConnectionsService::new(
            ConnectionStore::new(dir.path()),
            Arc::new(StuckFile::default()),
        );
        let saved = svc.save(&config("", "a"), Some("pw")).unwrap();
        let err = svc.delete(saved.id()).unwrap_err();
        assert_eq!(err.kind(), "credential");
        assert!(err.to_string().contains("still in secrets.json"), "{err}");
    }

    #[test]
    fn keeping_the_secret_for_a_new_server_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let saved = svc.save(&config("", "a"), Some("stored")).unwrap();
        let ConnectionConfig::Mysql(m) = &saved else { panic!() };
        let moved = ConnectionConfig::Mysql(MysqlConnectionConfig {
            host: "attacker.example".into(),
            ..m.clone()
        });
        let err = svc.save(&moved, None).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert_eq!(err.to_string(), "Enter the password again for the new server");
        assert_eq!(svc.get(saved.id()).unwrap(), saved, "nothing was saved");

        // Same server with other cosmetic changes, a new secret or a cleared one are fine.
        let renamed =
            ConnectionConfig::Mysql(MysqlConnectionConfig { name: "b".into(), ..m.clone() });
        svc.save(&renamed, None).unwrap();
        svc.save(&moved, Some("typed")).unwrap();
        assert_eq!(svc.resolve_secret(saved.id(), None).unwrap().as_deref(), Some("typed"));
        let back = svc.save(&saved, Some("")).unwrap();
        // No stored secret: moving needs nothing.
        svc.save(&moved, None).unwrap();
        assert!(!svc.has_secret(back.id()).unwrap());
    }

    #[test]
    fn ids_are_trimmed_consistently() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let saved = svc.save(&config("", "a"), Some("pw")).unwrap();
        let padded = format!(" {} ", saved.id());
        assert_eq!(svc.get(&padded).unwrap(), saved);
        assert_eq!(svc.resolve_secret(&padded, None).unwrap().as_deref(), Some("pw"));
        assert!(svc.has_secret(&padded).unwrap());
        assert_eq!(svc.resolve_secret("  ", None).unwrap(), None);
        svc.delete(&padded).unwrap();
        assert!(svc.list().unwrap().is_empty());
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

    fn ssh_config(id: &str, ssh: Option<SshConfig>) -> ConnectionConfig {
        let ConnectionConfig::Mysql(m) = config(id, "tunneled") else { unreachable!() };
        ConnectionConfig::Mysql(MysqlConnectionConfig { ssh, ..m })
    }

    fn bastion(host: &str, auth: SshAuth) -> SshConfig {
        SshConfig { host: host.into(), port: 22, user: "ec2-user".into(), auth }
    }

    #[test]
    fn ssh_secret_is_stored_beside_the_db_secret() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let tunneled = ssh_config("", Some(bastion("b", SshAuth::Password)));
        let saved = svc.save_with_ssh(&tunneled, Some("db-pw"), Some("ssh-pw")).unwrap();
        let id = saved.id();
        assert!(svc.has_secret(id).unwrap());
        assert!(svc.has_secret_in(id, SecretSlot::Ssh).unwrap());
        let ssh = svc.resolve_secret_in(id, SecretSlot::Ssh, None).unwrap();
        assert_eq!(ssh.as_deref(), Some("ssh-pw"));
        assert_eq!(svc.resolve_secret(id, None).unwrap().as_deref(), Some("db-pw"));

        // null keeps, "" clears, only the SSH entry.
        svc.save_with_ssh(&saved, None, None).unwrap();
        assert!(svc.has_secret_in(id, SecretSlot::Ssh).unwrap());
        svc.save_with_ssh(&saved, None, Some("")).unwrap();
        assert!(!svc.has_secret_in(id, SecretSlot::Ssh).unwrap());
        assert!(svc.has_secret(id).unwrap());

        svc.save_with_ssh(&saved, None, Some("again")).unwrap();
        svc.delete(id).unwrap();
        assert!(!svc.has_secret(id).unwrap());
        assert!(!svc.has_secret_in(id, SecretSlot::Ssh).unwrap());
    }

    #[test]
    fn removing_ssh_clears_the_ssh_secret() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let tunneled = ssh_config("", Some(bastion("b", SshAuth::Password)));
        let saved = svc.save_with_ssh(&tunneled, Some("db"), Some("ssh")).unwrap();
        let direct = ssh_config(saved.id(), None);
        // The MySQL target changed too (no bastion), so the db password must be retyped.
        let err = svc.save_with_ssh(&direct, None, None).unwrap_err();
        assert_eq!(err.to_string(), "Enter the password again for the new server");
        svc.save_with_ssh(&direct, Some("db"), Some("ignored")).unwrap();
        assert!(!svc.has_secret_in(saved.id(), SecretSlot::Ssh).unwrap());
    }

    #[test]
    fn kept_ssh_secret_cannot_follow_a_new_bastion_or_key() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let first = ssh_config("", Some(bastion("b", SshAuth::Password)));
        let saved = svc.save_with_ssh(&first, None, Some("ssh-pw")).unwrap();
        let moved = ssh_config(saved.id(), Some(bastion("evil", SshAuth::Password)));
        let err = svc.save_with_ssh(&moved, None, None).unwrap_err();
        assert_eq!((err.kind(), err.to_string().as_str()), ("invalid_input", SSH_RETARGET_MESSAGE));
        assert_eq!(svc.get(saved.id()).unwrap(), saved, "nothing was saved");
        svc.save_with_ssh(&moved, None, Some("new")).unwrap();
        // Without a stored SSH secret, switching to the agent needs nothing.
        svc.save_with_ssh(&moved, None, Some("")).unwrap();
        let agent = ssh_config(saved.id(), Some(bastion("evil", SshAuth::Agent)));
        svc.save_with_ssh(&agent, None, None).unwrap();
    }

    #[test]
    fn test_ssh_secret_is_only_reused_for_the_saved_bastion() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let first = ssh_config("", Some(bastion("b", SshAuth::Password)));
        let saved = svc.save_with_ssh(&first, Some("db"), Some("ssh-pw")).unwrap();
        let resolve = |c: &ConnectionConfig| svc.resolve_test_ssh_secret(&validated(c), None);
        assert_eq!(resolve(&saved).unwrap().as_deref(), Some("ssh-pw"));
        let ConnectionConfig::Mysql(m) = &saved else { panic!() };
        let other_db =
            ConnectionConfig::Mysql(MysqlConnectionConfig { host: "10.0.0.7".into(), ..m.clone() });
        assert_eq!(resolve(&other_db).unwrap().as_deref(), Some("ssh-pw"));
        assert_eq!(
            svc.resolve_test_secret(&validated(&other_db), None).unwrap_err().kind(),
            "invalid_input"
        );
        let moved = ssh_config(saved.id(), Some(bastion("evil", SshAuth::Password)));
        let err = resolve(&moved).unwrap_err();
        assert_eq!(err.to_string(), SSH_RETYPE_MESSAGE);
        assert_eq!(
            svc.resolve_test_secret(&validated(&moved), None).unwrap_err().kind(),
            "invalid_input"
        );
        let typed = svc.resolve_test_ssh_secret(&validated(&moved), Some("typed")).unwrap();
        assert_eq!(typed.as_deref(), Some("typed"));
        assert_eq!(resolve(&ssh_config(saved.id(), None)).unwrap(), None, "no SSH, no secret");
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
