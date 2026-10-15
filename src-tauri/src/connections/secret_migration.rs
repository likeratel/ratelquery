//! `settings_set` with the secret store switch: secrets follow the new store.

use serde_json::Value;

use super::service::ConnectionsService;
use super::switchable_secrets::SwitchableSecretStore;
use crate::error::AppResult;
use crate::settings::{Settings, SettingsService};

/// Saves `patch` over the settings. When `secretStore` changed, every saved connection's
/// secret is moved from the old store to the new one, best effort: the outcome only shows up
/// in the log and never fails the call. Saves and deletes of connections wait meanwhile, so a
/// secret saved during the switch cannot be overwritten by the move.
pub fn update_settings(
    settings: &SettingsService,
    connections: &ConnectionsService,
    secrets: &SwitchableSecretStore,
    patch: &Value,
) -> AppResult<Settings> {
    connections.while_locked(|saved_ids| {
        let before = secrets.active_kind();
        let saved = settings.set(patch)?;
        if saved.secret_store != before {
            match saved_ids() {
                Ok(ids) => {
                    let report = secrets.migrate(&ids, before, saved.secret_store);
                    eprintln!(
                        "secret store switched: {} secrets moved, {} left in the old store",
                        report.moved, report.skipped
                    );
                }
                Err(err) => eprintln!("secret store switched, but no secrets were moved: {err}"),
            }
        }
        Ok(saved)
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::connections::model::{ConnectionConfig, MysqlConnectionConfig};
    use crate::connections::{ConnectionStore, FileSecretStore, MemorySecretStore, SecretStore};
    use crate::settings::{SecretStoreKind, SettingsStore};

    fn config(name: &str) -> ConnectionConfig {
        ConnectionConfig::Mysql(MysqlConnectionConfig {
            id: String::new(),
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

    #[test]
    fn switching_the_store_moves_saved_secrets_both_ways() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsService::new(SettingsStore::new(dir.path())));
        let keychain = Arc::new(MemorySecretStore::default());
        let file = Arc::new(FileSecretStore::new(dir.path()));
        let secrets =
            Arc::new(SwitchableSecretStore::new(settings.clone(), keychain.clone(), file.clone()));
        let connections =
            ConnectionsService::new(ConnectionStore::new(dir.path()), secrets.clone());
        let a = connections.save(&config("a"), Some("pa")).unwrap();
        let b = connections.save(&config("b"), None).unwrap();

        let saved =
            update_settings(&settings, &connections, &secrets, &json!({ "secretStore": "file" }))
                .unwrap();
        assert_eq!(saved.secret_store, SecretStoreKind::File);
        assert_eq!(file.get(a.id()).unwrap().as_deref(), Some("pa"));
        assert_eq!(keychain.get(a.id()).unwrap(), None, "moved, not copied");
        assert!(connections.has_secret(a.id()).unwrap());
        assert!(!connections.has_secret(b.id()).unwrap());

        // Other settings changes do not touch the secrets.
        keychain.set(b.id(), "stale").unwrap();
        update_settings(&settings, &connections, &secrets, &json!({ "theme": "dark" })).unwrap();
        assert_eq!(file.get(b.id()).unwrap(), None);

        update_settings(&settings, &connections, &secrets, &json!({ "secretStore": "keychain" }))
            .unwrap();
        assert_eq!(keychain.get(a.id()).unwrap().as_deref(), Some("pa"));
        assert_eq!(file.get(a.id()).unwrap(), None);
        assert_eq!(keychain.get(b.id()).unwrap().as_deref(), Some("stale"), "nothing to move");
    }

    #[test]
    fn a_store_that_refuses_keeps_its_secret_and_the_switch_still_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsService::new(SettingsStore::new(dir.path())));
        let keychain = Arc::new(MemorySecretStore::default());
        let file = Arc::new(FileSecretStore::new(dir.path()));
        let secrets =
            Arc::new(SwitchableSecretStore::new(settings.clone(), keychain.clone(), file.clone()));
        let connections =
            ConnectionsService::new(ConnectionStore::new(dir.path()), secrets.clone());
        settings.set(&json!({ "secretStore": "file" })).unwrap();
        let a = connections.save(&config("a"), Some("pa")).unwrap();
        // The old (file) store cannot be read any more.
        std::fs::write(file.path(), "{broken").unwrap();
        let saved = update_settings(
            &settings,
            &connections,
            &secrets,
            &json!({ "secretStore": "keychain" }),
        )
        .unwrap();
        assert_eq!(saved.secret_store, SecretStoreKind::Keychain);
        assert_eq!(keychain.get(a.id()).unwrap(), None);
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "{broken");
    }
}
