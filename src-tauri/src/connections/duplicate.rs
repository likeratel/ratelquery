//! Naming of duplicated connections.

/// Name for a copy of `name` that no entry of `taken` uses (compared case-insensitively):
/// `"<name> copy"`, then `"<name> copy 2"`, `"<name> copy 3"`, …
pub fn copy_name<'a>(name: &str, taken: impl IntoIterator<Item = &'a str>) -> String {
    let taken: Vec<String> = taken.into_iter().map(str::to_lowercase).collect();
    let is_free = |candidate: &str| !taken.contains(&candidate.to_lowercase());
    let base = format!("{} copy", name.trim());
    if is_free(&base) {
        return base;
    }
    (2u64..).map(|n| format!("{base} {n}")).find(|candidate| is_free(candidate)).unwrap_or(base)
}

#[cfg(test)]
mod service_tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use crate::connections::{
        ConnectionConfig, ConnectionStore, ConnectionsService, MemorySecretStore,
        MysqlConnectionConfig, SSH_SECRET_SUFFIX, SecretSlot, SecretStore, SshAuth, SshConfig,
    };
    use crate::error::{AppError, AppResult};

    /// Memory store that remembers every key written and, once `fail_ssh` is set, refuses to
    /// write SSH secrets.
    #[derive(Default)]
    struct FlakySecrets {
        inner: MemorySecretStore,
        written: Mutex<Vec<String>>,
        fail_ssh: AtomicBool,
    }

    impl SecretStore for FlakySecrets {
        fn get(&self, id: &str) -> AppResult<Option<String>> {
            self.inner.get(id)
        }
        fn set(&self, id: &str, secret: &str) -> AppResult<()> {
            if self.fail_ssh.load(Ordering::SeqCst) && id.ends_with(SSH_SECRET_SUFFIX) {
                return Err(AppError::Credential("keychain locked".into()));
            }
            self.written.lock().unwrap().push(id.to_string());
            self.inner.set(id, secret)
        }
        fn delete(&self, id: &str) -> AppResult<()> {
            self.inner.delete(id)
        }
    }

    fn tunneled(name: &str) -> ConnectionConfig {
        ConnectionConfig::Mysql(MysqlConnectionConfig {
            id: String::new(),
            name: name.into(),
            host: "10.0.0.5".into(),
            port: 3306,
            user: "dev".into(),
            database: None,
            color: Some("#e5484d".into()),
            tls: None,
            ca_cert_path: None,
            ssh: Some(SshConfig {
                host: "bastion".into(),
                port: 22,
                user: "ec2-user".into(),
                auth: SshAuth::Password,
            }),
        })
    }

    fn service(secrets: Arc<dyn SecretStore>) -> (tempfile::TempDir, ConnectionsService) {
        let dir = tempfile::tempdir().unwrap();
        let svc = ConnectionsService::new(ConnectionStore::new(dir.path()), secrets);
        (dir, svc)
    }

    #[test]
    fn copies_the_config_and_both_secrets_under_a_new_id() {
        let (_dir, svc) = service(Arc::new(MemorySecretStore::default()));
        let source = svc.save_with_ssh(&tunneled("prod"), Some("db-pw"), Some("ssh-pw")).unwrap();
        let copy = svc.duplicate(source.id()).unwrap();
        assert_ne!(copy.id(), source.id());
        assert!(uuid::Uuid::parse_str(copy.id()).is_ok());
        assert_eq!(copy.name(), "prod copy");
        assert_eq!(copy.with_id(source.id()).with_name("prod"), source, "same settings");
        let secret = |slot| svc.resolve_secret_in(copy.id(), slot, None).unwrap();
        assert_eq!(secret(SecretSlot::Db).as_deref(), Some("db-pw"));
        assert_eq!(secret(SecretSlot::Ssh).as_deref(), Some("ssh-pw"));
        assert_eq!(svc.get(copy.id()).unwrap(), copy);

        let again = svc.duplicate(source.id()).unwrap();
        assert_eq!(again.name(), "prod copy 2");
        assert_eq!(svc.list().unwrap().len(), 3);
    }

    #[test]
    fn missing_secrets_are_not_created() {
        let (_dir, svc) = service(Arc::new(MemorySecretStore::default()));
        let source = svc.save(&tunneled("prod"), None).unwrap();
        let copy = svc.duplicate(source.id()).unwrap();
        assert!(!svc.has_secret(copy.id()).unwrap());
        assert!(!svc.has_secret_in(copy.id(), SecretSlot::Ssh).unwrap());
    }

    #[test]
    fn a_secret_that_cannot_be_copied_removes_the_copy() {
        let secrets = Arc::new(FlakySecrets::default());
        let (_dir, svc) = service(secrets.clone());
        let source = svc.save_with_ssh(&tunneled("prod"), Some("db-pw"), Some("ssh-pw")).unwrap();
        secrets.fail_ssh.store(true, Ordering::SeqCst);
        let err = svc.duplicate(source.id()).unwrap_err();
        assert_eq!(err.kind(), "credential");
        assert_eq!(svc.list().unwrap(), vec![source.clone()], "the copy was removed");
        let written = secrets.written.lock().unwrap().clone();
        assert_eq!(written.len(), 3, "the db secret of the copy was written: {written:?}");
        for key in written.iter().filter(|k| !k.starts_with(source.id())) {
            assert_eq!(secrets.get(key).unwrap(), None, "{key} was cleaned up");
        }
        assert_eq!(svc.resolve_secret(source.id(), None).unwrap().as_deref(), Some("db-pw"));
    }

    #[test]
    fn unknown_or_empty_ids_are_rejected() {
        let (_dir, svc) = service(Arc::new(MemorySecretStore::default()));
        assert_eq!(svc.duplicate("missing").unwrap_err().kind(), "not_found");
        assert_eq!(svc.duplicate(" ").unwrap_err().kind(), "invalid_input");
        assert!(svc.list().unwrap().is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_copy_appends_copy() {
        assert_eq!(copy_name("prod", ["prod"]), "prod copy");
    }

    #[test]
    fn later_copies_are_numbered_past_every_taken_name() {
        assert_eq!(copy_name("prod", ["prod", "prod copy"]), "prod copy 2");
        assert_eq!(copy_name("prod", ["prod", "Prod Copy", "PROD COPY 2"]), "prod copy 3");
        assert_eq!(copy_name("prod", ["prod copy", "prod copy 3"]), "prod copy 2");
    }

    #[test]
    fn copying_a_copy_stacks_the_suffix() {
        assert_eq!(copy_name("prod copy", ["prod", "prod copy"]), "prod copy copy");
    }

    #[test]
    fn surrounding_spaces_are_dropped() {
        assert_eq!(copy_name(" prod ", Vec::<&str>::new()), "prod copy");
    }
}
