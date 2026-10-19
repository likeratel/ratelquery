use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{AppError, AppResult};

const KEYRING_SERVICE: &str = "ratelquery";
pub const KEYCHAIN_LOCATION: &str = "the keychain";
/// Suffix of the secret entry holding a connection's SSH password or key passphrase.
pub const SSH_SECRET_SUFFIX: &str = ":ssh";

/// Secret store key of the SSH password or passphrase of connection `id`.
pub fn ssh_secret_id(id: &str) -> String {
    format!("{id}{SSH_SECRET_SUFFIX}")
}

/// Which stored secret of a connection a call refers to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretSlot {
    /// The database password or secret access key, stored under the connection id.
    #[default]
    Db,
    /// The SSH password or key passphrase, stored under `<id>:ssh`.
    Ssh,
}

impl SecretSlot {
    /// Secret store key for connection `id`.
    pub fn key(self, id: &str) -> String {
        match self {
            SecretSlot::Db => id.to_string(),
            SecretSlot::Ssh => ssh_secret_id(id),
        }
    }
}

/// A secret that could not be removed, and where it is still kept.
#[derive(Debug)]
pub struct StuckSecret {
    pub location: &'static str,
    pub error: AppError,
}

/// Secret storage keyed by connection id. The production implementation is the OS keyring;
/// tests use [`MemorySecretStore`] so they never touch the real keychain.
pub trait SecretStore: Send + Sync {
    fn get(&self, id: &str) -> AppResult<Option<String>>;
    fn set(&self, id: &str, secret: &str) -> AppResult<()>;
    /// Removes the secret. Removing a missing secret is not an error.
    fn delete(&self, id: &str) -> AppResult<()>;

    /// Where the secrets are kept, for messages ("the keychain", "secrets.json").
    fn location(&self) -> &'static str {
        KEYCHAIN_LOCATION
    }

    /// Removes the secret from every store behind this one. Only a failure of the store in
    /// use is reported; other stores are cleaned up best effort.
    fn delete_everywhere(&self, id: &str) -> Result<(), StuckSecret> {
        self.delete(id).map_err(|error| StuckSecret { location: self.location(), error })
    }
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
