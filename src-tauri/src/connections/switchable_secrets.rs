//! Routes secret operations to the store chosen in settings (`secretStore`).

use std::sync::Arc;

use super::secrets::{SecretStore, StuckSecret};
use crate::error::AppResult;
use crate::settings::{SecretStoreKind, SettingsService};

/// Reads `secretStore` from settings on every call, so a switch takes effect at once. When the
/// settings cannot be read the keychain (the default) is used.
pub struct SwitchableSecretStore {
    settings: Arc<SettingsService>,
    keychain: Arc<dyn SecretStore>,
    file: Arc<dyn SecretStore>,
}

/// Result of moving secrets between stores after a switch.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MigrationReport {
    /// Secrets now in the new store.
    pub moved: usize,
    /// Secrets the old store would not hand over or the new store would not take; they stay
    /// in the old store.
    pub skipped: usize,
}

fn other(kind: SecretStoreKind) -> SecretStoreKind {
    match kind {
        SecretStoreKind::Keychain => SecretStoreKind::File,
        SecretStoreKind::File => SecretStoreKind::Keychain,
    }
}

impl SwitchableSecretStore {
    pub fn new(
        settings: Arc<SettingsService>,
        keychain: Arc<dyn SecretStore>,
        file: Arc<dyn SecretStore>,
    ) -> Self {
        Self { settings, keychain, file }
    }

    /// The store in use. Unreadable settings fall back to the keychain.
    pub fn active_kind(&self) -> SecretStoreKind {
        match self.settings.get() {
            Ok(settings) => settings.secret_store,
            Err(err) => {
                eprintln!("could not read settings ({err}); using the keychain for secrets");
                SecretStoreKind::Keychain
            }
        }
    }

    fn store(&self, kind: SecretStoreKind) -> &dyn SecretStore {
        match kind {
            SecretStoreKind::Keychain => self.keychain.as_ref(),
            SecretStoreKind::File => self.file.as_ref(),
        }
    }

    fn active(&self) -> &dyn SecretStore {
        self.store(self.active_kind())
    }

    /// Moves the secret of every id from `from` to `to`, best effort: a secret is removed from
    /// `from` only after `to` stored it, and an id that fails is skipped (logged, never the
    /// secret itself).
    pub fn migrate(
        &self,
        ids: &[String],
        from: SecretStoreKind,
        to: SecretStoreKind,
    ) -> MigrationReport {
        if from == to {
            return MigrationReport::default();
        }
        let (source, target) = (self.store(from), self.store(to));
        ids.iter().fold(MigrationReport::default(), |report, id| {
            match move_secret(source, target, id) {
                Ok(true) => MigrationReport { moved: report.moved + 1, ..report },
                Ok(false) => report,
                Err(err) => {
                    eprintln!("secret of connection {id} stays in {}: {err}", source.location());
                    MigrationReport { skipped: report.skipped + 1, ..report }
                }
            }
        })
    }
}

/// `Ok(true)` when a secret was copied. A failed delete from the source leaves a stale copy
/// there, which is only logged: the target already has it.
fn move_secret(source: &dyn SecretStore, target: &dyn SecretStore, id: &str) -> AppResult<bool> {
    let Some(secret) = source.get(id)? else { return Ok(false) };
    target.set(id, &secret)?;
    if let Err(err) = source.delete(id) {
        eprintln!("moved the secret of connection {id}, but could not remove the old copy: {err}");
    }
    Ok(true)
}

impl SecretStore for SwitchableSecretStore {
    fn get(&self, id: &str) -> AppResult<Option<String>> {
        self.active().get(id)
    }

    fn set(&self, id: &str, secret: &str) -> AppResult<()> {
        self.active().set(id, secret)
    }

    fn delete(&self, id: &str) -> AppResult<()> {
        self.active().delete(id)
    }

    fn location(&self) -> &'static str {
        self.active().location()
    }

    /// Deletes from the active store (failure reported) and from the other one (failure only
    /// logged), so no copy outlives the connection after a switch.
    fn delete_everywhere(&self, id: &str) -> Result<(), StuckSecret> {
        let kind = self.active_kind();
        let (active, inactive) = (self.store(kind), self.store(other(kind)));
        if let Err(err) = inactive.delete(id) {
            eprintln!("could not remove the secret of {id} from {}: {err}", inactive.location());
        }
        active.delete(id).map_err(|error| StuckSecret { location: active.location(), error })
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
        assert_eq!(f.store.location(), "the keychain");
    }

    #[test]
    fn switching_changes_the_store_used_by_each_call() {
        let f = fixture();
        f.store.set("a", "from-keychain").unwrap();
        use_store(&f, "file");
        assert_eq!(f.store.location(), "secrets.json");
        assert_eq!(f.store.get("a").unwrap(), None, "keychain secret is not visible");
        f.store.set("a", "from-file").unwrap();
        assert_eq!(f.file.get("a").unwrap().as_deref(), Some("from-file"));
        assert_eq!(f.keychain.get("a").unwrap().as_deref(), Some("from-keychain"));

        // `delete` only touches the active store.
        f.store.delete("a").unwrap();
        assert_eq!(f.file.get("a").unwrap(), None);
        assert_eq!(f.keychain.get("a").unwrap().as_deref(), Some("from-keychain"));

        use_store(&f, "keychain");
        assert_eq!(f.store.get("a").unwrap().as_deref(), Some("from-keychain"));
    }

    #[test]
    fn unreadable_settings_fall_back_to_the_keychain() {
        let f = fixture();
        f.keychain.set("a", "k").unwrap();
        std::fs::write(f.dir.path().join("settings.json"), "{nope").unwrap();
        assert_eq!(f.store.get("a").unwrap().as_deref(), Some("k"));
        f.store.set("b", "x").unwrap();
        assert_eq!(f.keychain.get("b").unwrap().as_deref(), Some("x"));
        assert!(!f.file.path().exists());
    }

    #[test]
    fn delete_everywhere_cleans_both_stores() {
        let f = fixture();
        f.keychain.set("a", "k").unwrap();
        f.file.set("a", "f").unwrap();
        f.store.delete_everywhere("a").unwrap();
        assert_eq!(f.keychain.get("a").unwrap(), None);
        assert_eq!(f.file.get("a").unwrap(), None);
    }

    #[test]
    fn delete_everywhere_ignores_the_inactive_store_and_names_the_active_one() {
        let f = fixture();
        f.keychain.set("a", "k").unwrap();
        // The inactive file store is corrupt and refuses: still a success.
        std::fs::write(f.file.path(), "{broken").unwrap();
        f.store.delete_everywhere("a").unwrap();
        assert_eq!(f.keychain.get("a").unwrap(), None);

        // The active file store refuses: reported with its location.
        use_store(&f, "file");
        let stuck = f.store.delete_everywhere("a").unwrap_err();
        assert_eq!(stuck.location, "secrets.json");
        assert_eq!(stuck.error.kind(), "io");
    }

    #[test]
    fn migrate_moves_secrets_and_skips_failures() {
        let f = fixture();
        f.keychain.set("a", "pa").unwrap();
        f.keychain.set("b", "pb").unwrap();
        let ids: Vec<String> = ["a", "b", "none"].iter().map(|s| s.to_string()).collect();
        let report = f.store.migrate(&ids, SecretStoreKind::Keychain, SecretStoreKind::File);
        assert_eq!(report, MigrationReport { moved: 2, skipped: 0 });
        assert_eq!(f.file.get("a").unwrap().as_deref(), Some("pa"));
        assert_eq!(f.file.get("b").unwrap().as_deref(), Some("pb"));
        assert_eq!(f.keychain.get("a").unwrap(), None);

        // The target refuses: the secret stays where it was.
        std::fs::write(f.dir.path().join("blocker"), "").unwrap();
        let broken = Arc::new(FileSecretStore::new(&f.dir.path().join("blocker")));
        let store = SwitchableSecretStore::new(f.settings.clone(), f.keychain.clone(), broken);
        f.keychain.set("c", "pc").unwrap();
        let report =
            store.migrate(&["c".to_string()], SecretStoreKind::Keychain, SecretStoreKind::File);
        assert_eq!(report, MigrationReport { moved: 0, skipped: 1 });
        assert_eq!(f.keychain.get("c").unwrap().as_deref(), Some("pc"));
        let none = store.migrate(&ids, SecretStoreKind::File, SecretStoreKind::File);
        assert_eq!(none, MigrationReport::default());
    }
}
