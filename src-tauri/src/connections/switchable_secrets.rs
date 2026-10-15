//! Routes secret operations to the store chosen in settings (`secretStore`).

use std::sync::Arc;

use super::secrets::SecretStore;
use crate::error::AppResult;
use crate::settings::{SecretStoreKind, SettingsService};

/// Reads `secretStore` from settings on every call, so a switch takes effect at once. Secrets
/// are not migrated: each operation only sees the active store.
pub struct SwitchableSecretStore {
    settings: Arc<SettingsService>,
    keychain: Arc<dyn SecretStore>,
    file: Arc<dyn SecretStore>,
}

impl SwitchableSecretStore {
    pub fn new(
        settings: Arc<SettingsService>,
        keychain: Arc<dyn SecretStore>,
        file: Arc<dyn SecretStore>,
    ) -> Self {
        Self { settings, keychain, file }
    }

    fn active(&self) -> AppResult<&dyn SecretStore> {
        Ok(match self.settings.get()?.secret_store {
            SecretStoreKind::Keychain => self.keychain.as_ref(),
            SecretStoreKind::File => self.file.as_ref(),
        })
    }
}

impl SecretStore for SwitchableSecretStore {
    fn get(&self, id: &str) -> AppResult<Option<String>> {
        self.active()?.get(id)
    }

    fn set(&self, id: &str, secret: &str) -> AppResult<()> {
        self.active()?.set(id, secret)
    }

    fn delete(&self, id: &str) -> AppResult<()> {
        self.active()?.delete(id)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::connections::file_secrets::FileSecretStore;
    use crate::connections::secrets::MemorySecretStore;
    use crate::settings::SettingsStore;

    struct Fixture {
        dir: tempfile::TempDir,
        settings: Arc<SettingsService>,
        keychain: Arc<MemorySecretStore>,
        file: Arc<FileSecretStore>,
        store: SwitchableSecretStore,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsService::new(SettingsStore::new(dir.path())));
        let keychain = Arc::new(MemorySecretStore::default());
        let file = Arc::new(FileSecretStore::new(dir.path()));
        let store = SwitchableSecretStore::new(settings.clone(), keychain.clone(), file.clone());
        Fixture { dir, settings, keychain, file, store }
    }

    fn use_store(f: &Fixture, kind: &str) {
        f.settings.set(&json!({ "secretStore": kind })).unwrap();
    }

    #[test]
    fn defaults_to_the_keychain() {
        let f = fixture();
        f.store.set("a", "k").unwrap();
        assert_eq!(f.keychain.get("a").unwrap().as_deref(), Some("k"));
        assert!(!f.file.path().exists());
    }

    #[test]
    fn switching_changes_the_store_without_migrating() {
        let f = fixture();
        f.store.set("a", "from-keychain").unwrap();
        use_store(&f, "file");
        assert_eq!(f.store.get("a").unwrap(), None, "keychain secret is not visible");
        f.store.set("a", "from-file").unwrap();
        assert_eq!(f.file.get("a").unwrap().as_deref(), Some("from-file"));
        assert_eq!(f.keychain.get("a").unwrap().as_deref(), Some("from-keychain"));

        // Deleting removes the secret from the active store only.
        f.store.delete("a").unwrap();
        assert_eq!(f.file.get("a").unwrap(), None);
        assert_eq!(f.keychain.get("a").unwrap().as_deref(), Some("from-keychain"));

        use_store(&f, "keychain");
        assert_eq!(f.store.get("a").unwrap().as_deref(), Some("from-keychain"));
    }

    #[test]
    fn unreadable_settings_fail_the_call() {
        let f = fixture();
        std::fs::write(f.dir.path().join("settings.json"), "{nope").unwrap();
        assert_eq!(f.store.get("a").unwrap_err().kind(), "io");
    }
}
