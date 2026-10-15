use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{AppError, AppResult};

const KEYRING_SERVICE: &str = "dbclient";

/// Secret storage keyed by connection id. The production implementation is the OS keyring;
/// tests use [`MemorySecretStore`] so they never touch the real keychain.
pub trait SecretStore: Send + Sync {
    fn get(&self, id: &str) -> AppResult<Option<String>>;
    fn set(&self, id: &str, secret: &str) -> AppResult<()>;
    /// Removes the secret. Removing a missing secret is not an error.
    fn delete(&self, id: &str) -> AppResult<()>;
}

#[derive(Debug, Default)]
pub struct KeyringSecretStore;

fn credential_error(action: &str, err: keyring::Error) -> AppError {
    AppError::Credential(format!("could not {action} the keyring entry: {err}"))
}

fn entry(id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| credential_error("open", e))
}

impl SecretStore for KeyringSecretStore {
    fn get(&self, id: &str) -> AppResult<Option<String>> {
        match entry(id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(credential_error("read", e)),
        }
    }

    fn set(&self, id: &str, secret: &str) -> AppResult<()> {
        entry(id)?.set_password(secret).map_err(|e| credential_error("write", e))
    }

    fn delete(&self, id: &str) -> AppResult<()> {
        match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(credential_error("delete", e)),
        }
    }
}

/// In-memory fake used by tests.
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    secrets: Mutex<HashMap<String, String>>,
}

impl MemorySecretStore {
    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, String>>> {
        self.secrets.lock().map_err(|_| AppError::Credential("secret store lock poisoned".into()))
    }
}

impl SecretStore for MemorySecretStore {
    fn get(&self, id: &str) -> AppResult<Option<String>> {
        Ok(self.lock()?.get(id).cloned())
    }

    fn set(&self, id: &str, secret: &str) -> AppResult<()> {
        self.lock()?.insert(id.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, id: &str) -> AppResult<()> {
        self.lock()?.remove(id);
        Ok(())
    }
}
