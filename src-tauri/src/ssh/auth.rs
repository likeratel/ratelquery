//! SSH user authentication: agent keys, a private key file, or a password.

use std::sync::Arc;

use russh::client::{AuthResult, Handle, Handler};
use russh::keys::{
    Error as KeyError, HashAlg, PrivateKey, PrivateKeyWithHashAlg, decode_secret_key,
};

use crate::connections::{SshAuth, SshConfig};
use crate::error::{AppError, AppResult};

/// Start of the message when a key file is encrypted and no passphrase was given. The frontend
/// prompts for the passphrase on it.
pub const PASSPHRASE_REQUIRED: &str = "Key passphrase required";

fn failed(step: &str, err: impl std::fmt::Display) -> AppError {
    AppError::Ssh(format!("SSH {step} failed: {err}"))
}

fn given(secret: Option<&str>) -> Option<&str> {
    secret.filter(|s| !s.is_empty())
}

/// Authenticates `ssh.user` with the configured method. `secret` is the password or the key
/// passphrase.
pub async fn authenticate<H: Handler>(
    handle: &mut Handle<H>,
    ssh: &SshConfig,
    secret: Option<&str>,
) -> AppResult<()> {
    let who = format!("{}@{}", ssh.user, ssh.host);
    match &ssh.auth {
        SshAuth::Password => {
            let password = given(secret)
                .ok_or_else(|| AppError::Ssh(format!("The SSH password for {who} is not set")))?;
            let result = handle
                .authenticate_password(ssh.user.as_str(), password)
                .await
                .map_err(|e| failed("password authentication", e))?;
            accepted(result, || format!("The SSH server rejected the password for {who}"))
        }
        SshAuth::Key { key_path } => {
            let key = load_key(key_path, given(secret)).await?;
            let hash = rsa_hash(handle).await?;
            let result = handle
                .authenticate_publickey(
                    ssh.user.as_str(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|e| failed("key authentication", e))?;
            accepted(result, || format!("The SSH server rejected the key {key_path} for {who}"))
        }
        SshAuth::Agent => agent::authenticate(handle, &ssh.user, &who).await,
    }
}

fn accepted(result: AuthResult, message: impl FnOnce() -> String) -> AppResult<()> {
    if result.success() { Ok(()) } else { Err(AppError::Ssh(message())) }
}

async fn rsa_hash<H: Handler>(handle: &Handle<H>) -> AppResult<Option<HashAlg>> {
    Ok(handle.best_supported_rsa_hash().await.map_err(|e| failed("negotiation", e))?.flatten())
}

/// Reads and decrypts an OpenSSH (or PuTTY) private key.
pub async fn load_key(path: &str, passphrase: Option<&str>) -> AppResult<PrivateKey> {
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| AppError::Ssh(format!("could not read the SSH key {path}: {e}")))?;
    decode_key(&text, path, passphrase)
}

fn decode_key(text: &str, path: &str, passphrase: Option<&str>) -> AppResult<PrivateKey> {
    match decode_secret_key(text, passphrase) {
        Ok(key) if key.is_encrypted() && passphrase.is_none() => Err(passphrase_required(path)),
        Ok(key) => Ok(key),
        Err(KeyError::KeyIsEncrypted) if passphrase.is_none() => Err(passphrase_required(path)),
        Err(err) if passphrase.is_some() => Err(AppError::Ssh(format!(
            "could not decrypt the SSH key {path} (wrong passphrase?): {err}"
        ))),
        Err(err) => Err(AppError::Ssh(format!("could not load the SSH key {path}: {err}"))),
    }
}

fn passphrase_required(path: &str) -> AppError {
    AppError::Ssh(format!("{PASSPHRASE_REQUIRED}: the SSH key {path} is encrypted"))
}

#[cfg(unix)]
mod agent {
    use russh::client::{Handle, Handler};
    use russh::keys::agent::client::AgentClient;

    use super::{failed, rsa_hash};
    use crate::error::{AppError, AppResult};

    /// Tries every identity of the agent at `SSH_AUTH_SOCK` until the server accepts one.
    pub async fn authenticate<H: Handler>(
        handle: &mut Handle<H>,
        user: &str,
        who: &str,
    ) -> AppResult<()> {
        let mut agent = AgentClient::connect_env().await.map_err(|e| {
            AppError::Ssh(format!("could not reach the SSH agent (SSH_AUTH_SOCK): {e}"))
        })?;
        let identities =
            agent.request_identities().await.map_err(|e| failed("agent key listing", e))?;
        if identities.is_empty() {
            return Err(AppError::Ssh("The SSH agent has no keys; add one with ssh-add".into()));
        }
        let hash = rsa_hash(handle).await?;
        let mut last_error = None;
        for identity in identities {
            let key = identity.public_key().into_owned();
            let hash = if key.algorithm().is_rsa() { hash } else { None };
            match handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
                Ok(result) if result.success() => return Ok(()),
                Ok(_) => {}
                Err(err) => last_error = Some(err.to_string()),
            }
        }
        let detail = last_error.map(|e| format!(" (last error: {e})")).unwrap_or_default();
        Err(AppError::Ssh(format!(
            "The SSH server rejected every key of the SSH agent for {who}{detail}"
        )))
    }
}

#[cfg(not(unix))]
mod agent {
    use russh::client::{Handle, Handler};

    use crate::error::{AppError, AppResult};

    pub async fn authenticate<H: Handler>(
        _handle: &mut Handle<H>,
        _user: &str,
        _who: &str,
    ) -> AppResult<()> {
        Err(AppError::Ssh(
            "SSH agent authentication is only supported on macOS and Linux; use a key file".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keygen(dir: &std::path::Path, name: &str, passphrase: &str) -> String {
        let path = dir.join(name);
        let status = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", passphrase, "-C", "", "-f"])
            .arg(&path)
            .status()
            .expect("ssh-keygen is installed");
        assert!(status.success());
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn decodes_plain_and_encrypted_keys() {
        let dir = tempfile::tempdir().unwrap();
        let plain = keygen(dir.path(), "plain", "");
        assert!(decode_key(&plain, "plain", None).is_ok(), "no passphrase needed");
        assert!(decode_key(&plain, "plain", Some("ignored")).is_ok());

        let locked = keygen(dir.path(), "locked", "s3cret");
        let missing = decode_key(&locked, "/k/locked", None).unwrap_err();
        assert_eq!(missing.kind(), "ssh");
        assert!(missing.to_string().starts_with(PASSPHRASE_REQUIRED), "{missing}");
        let wrong = decode_key(&locked, "/k/locked", Some("nope")).unwrap_err();
        assert_eq!(wrong.kind(), "ssh");
        assert!(!wrong.to_string().starts_with(PASSPHRASE_REQUIRED), "{wrong}");
        let key = decode_key(&locked, "/k/locked", Some("s3cret")).unwrap();
        assert!(!key.is_encrypted());
        let junk = decode_key("not a key", "/k/junk", None).unwrap_err();
        assert_eq!(junk.kind(), "ssh");
    }
}
