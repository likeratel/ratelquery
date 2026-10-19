//! Host key checks against OpenSSH `known_hosts` files: the user's `~/.ssh/known_hosts` (read
//! only) and the app's own `<app config dir>/known_hosts`, where `ssh_trust_host` appends.
//!
//! Supported entries: plain and hashed (`|1|salt|hash`) host names, `[host]:port` for other
//! ports, comma separated patterns with `*` / `?` wildcards and `!` negation, and `@revoked`
//! markers. `@cert-authority` lines are skipped (host certificates are checked by their plain
//! key only). Lines whose key cannot be parsed are skipped.

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};
use sha1::Sha1;

use crate::error::{AppError, AppResult};

pub const KNOWN_HOSTS_FILE: &str = "known_hosts";
const DEFAULT_PORT: u16 = 22;
const HASHED_PREFIX: &str = "|1|";
const REVOKED_MARKER: &str = "@revoked";

/// Where host keys are looked up. Cheap to clone.
#[derive(Debug, Clone, Default)]
pub struct KnownHosts {
    /// `~/.ssh/known_hosts`; read only.
    user: Option<PathBuf>,
    /// The app's file; trusted keys are appended here.
    app: Option<PathBuf>,
}

/// What the known_hosts files say about a presented host key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    Known,
    /// No entry with this key. `other_types` is set when the host has keys of other types on
    /// record.
    Unknown {
        other_types: bool,
    },
    /// The host has a different key of the same type on record (file and line given).
    Changed {
        location: String,
    },
    /// The key is listed under `@revoked`.
    Revoked {
        location: String,
    },
}

/// The host name as written in known_hosts: `host` for port 22, `[host]:port` otherwise.
pub fn host_token(host: &str, port: u16) -> String {
    let host = host.to_ascii_lowercase();
    if port == DEFAULT_PORT { host } else { format!("[{host}]:{port}") }
}

/// The known_hosts line that trusts `key` for `host:port`.
pub fn key_line(host: &str, port: u16, key: &PublicKey) -> AppResult<String> {
    let bare = PublicKey::new(key.key_data().clone(), "");
    let openssh = bare
        .to_openssh()
        .map_err(|e| AppError::Ssh(format!("could not encode the host key: {e}")))?;
    Ok(format!("{} {openssh}", host_token(host, port)))
}

/// `ssh-ed25519 SHA256:...`
pub fn describe_key(key: &PublicKey) -> String {
    format!("{} {}", key.algorithm().as_str(), key.fingerprint(HashAlg::Sha256))
}

/// `*` matches any run, `?` one character. Both sides are lower case.
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match (pattern.split_first(), text.split_first()) {
        (None, None) => true,
        (Some((b'*', rest)), _) => {
            glob(rest, text) || text.split_first().is_some_and(|(_, tail)| glob(pattern, tail))
        }
        (Some((b'?', rest)), Some((_, tail))) => glob(rest, tail),
        (Some((p, rest)), Some((t, tail))) if p == t => glob(rest, tail),
        _ => false,
    }
}

fn hashed_matches(entry: &str, token: &str) -> bool {
    let mut parts = entry.trim_start_matches(HASHED_PREFIX).splitn(2, '|');
    let decode = |part: Option<&str>| {
        part.and_then(|p| base64::engine::general_purpose::STANDARD.decode(p).ok())
    };
    let (Some(salt), Some(hash)) = (decode(parts.next()), decode(parts.next())) else {
        return false;
    };
    Hmac::<Sha1>::new_from_slice(&salt)
        .is_ok_and(|mac| mac.chain_update(token.as_bytes()).verify_slice(&hash).is_ok())
}

fn pattern_matches(pattern: &str, token: &str) -> bool {
    if pattern.starts_with(HASHED_PREFIX) {
        hashed_matches(pattern, token)
    } else {
        glob(pattern.to_ascii_lowercase().as_bytes(), token.as_bytes())
    }
}

/// OpenSSH semantics: any matching negated pattern excludes the line.
fn hosts_match(patterns: &str, token: &str) -> bool {
    let mut matched = false;
    for pattern in patterns.split(',') {
        match pattern.strip_prefix('!') {
            Some(negated) if pattern_matches(negated, token) => return false,
            Some(_) => {}
            None => matched |= pattern_matches(pattern, token),
        }
    }
    matched
}

struct Entry {
    marker: Option<String>,
    key: PublicKey,
}

/// The entry of `line` when it applies to `token`.
fn parse_line(line: &str, token: &str) -> Option<Entry> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut fields = line.split_whitespace();
    let first = fields.next()?;
    let (marker, hosts) = match first.strip_prefix('@') {
        Some(_) => (Some(first.to_string()), fields.next()?),
        None => (None, first),
    };
    let _key_type = fields.next()?;
    let key = parse_public_key_base64(fields.next()?).ok()?;
    hosts_match(hosts, token).then_some(Entry { marker, key })
}

#[derive(Default)]
struct Findings {
    known: bool,
    other_types: bool,
    changed: Option<String>,
    revoked: Option<String>,
}

fn scan(findings: Findings, text: &str, source: &Path, token: &str, key: &PublicKey) -> Findings {
    text.lines().enumerate().fold(findings, |found, (index, line)| {
        let Some(entry) = parse_line(line, token) else { return found };
        let location = || format!("{} line {}", source.display(), index + 1);
        let same_key = entry.key.key_data() == key.key_data();
        match entry.marker.as_deref() {
            Some(REVOKED_MARKER) if same_key => Findings { revoked: Some(location()), ..found },
            Some(_) => found,
            None if same_key => Findings { known: true, ..found },
            None if entry.key.algorithm() == key.algorithm() => {
                Findings { changed: found.changed.or_else(|| Some(location())), ..found }
            }
            None => Findings { other_types: true, ..found },
        }
    })
}

fn read_optional(path: &Path) -> AppResult<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(AppError::Io(format!("could not read {}: {err}", path.display()))),
    }
}

impl KnownHosts {
    pub fn new(user: Option<PathBuf>, app: Option<PathBuf>) -> Self {
        Self { user, app }
    }

    /// `~/.ssh/known_hosts` plus `<config_dir>/known_hosts`.
    pub fn for_app(config_dir: &Path) -> Self {
        let user = dirs::home_dir().map(|home| home.join(".ssh").join(KNOWN_HOSTS_FILE));
        Self::new(user, Some(config_dir.join(KNOWN_HOSTS_FILE)))
    }

    pub fn app_path(&self) -> Option<&Path> {
        self.app.as_deref()
    }

    fn files(&self) -> impl Iterator<Item = &Path> {
        self.user.iter().chain(self.app.iter()).map(PathBuf::as_path)
    }

    pub fn status(&self, host: &str, port: u16, key: &PublicKey) -> AppResult<HostKeyStatus> {
        let token = host_token(host, port);
        let mut findings = Findings::default();
        for path in self.files() {
            findings = scan(findings, &read_optional(path)?, path, &token, key);
        }
        Ok(match findings {
            Findings { revoked: Some(location), .. } => HostKeyStatus::Revoked { location },
            Findings { known: true, .. } => HostKeyStatus::Known,
            Findings { changed: Some(location), .. } => HostKeyStatus::Changed { location },
            Findings { other_types, .. } => HostKeyStatus::Unknown { other_types },
        })
    }

    /// `Ok` for a known key, otherwise `ssh_host_key`. The message starts with the key type and
    /// SHA256 fingerprint, and its last line is the known_hosts line for `ssh_trust_host`. A
    /// changed or revoked key says "changed" / "revoked" and is never trusted from the app
    /// (`ssh_trust_host` refuses it); an unknown key's message never contains "changed".
    pub fn verify(&self, host: &str, port: u16, key: &PublicKey) -> AppResult<()> {
        let described = describe_key(key);
        let target = format!("{host}:{port}");
        match self.status(host, port, key)? {
            HostKeyStatus::Known => Ok(()),
            HostKeyStatus::Unknown { other_types } => {
                let note = if other_types { " (a key of another type is on record)" } else { "" };
                Err(AppError::SshHostKey(format!(
                    "{described} is the host key of {target}, which is not in known_hosts{note}. \
                     Trust it only if the fingerprint matches the server's.\n{}",
                    key_line(host, port, key)?
                )))
            }
            HostKeyStatus::Changed { location } => Err(AppError::SshHostKey(format!(
                "{described}: the host key of {target} changed ({location} has a different key). \
                 Someone may be intercepting the connection. If the change is expected, remove \
                 the old entry by hand.\n{}",
                key_line(host, port, key)?
            ))),
            HostKeyStatus::Revoked { location } => Err(AppError::SshHostKey(format!(
                "{described}: the host key of {target} is revoked and must not be used; it \
                 changed to a key on the revoked list ({location}).\n{}",
                key_line(host, port, key)?
            ))),
        }
    }

    /// Appends `line` (as produced by [`key_line`]) to the app's known_hosts for `host:port`.
    /// A key already known is a no-op; a changed or revoked key is refused.
    pub fn trust(&self, host: &str, port: u16, line: &str) -> AppResult<()> {
        let key = parse_trust_line(host, port, line)?;
        match self.status(host, port, &key)? {
            HostKeyStatus::Known => Ok(()),
            HostKeyStatus::Unknown { .. } => self.append(&key_line(host, port, &key)?),
            HostKeyStatus::Changed { location } | HostKeyStatus::Revoked { location } => {
                Err(AppError::InvalidInput(format!(
                    "The host key of {host}:{port} changed or is revoked ({location}); it is not \
                     trusted from the app. Remove the old entry by hand if the change is expected."
                )))
            }
        }
    }

    fn append(&self, line: &str) -> AppResult<()> {
        let path = self
            .app
            .as_deref()
            .ok_or_else(|| AppError::Io("the app known_hosts file is not configured".into()))?;
        let existing = read_optional(path)?;
        let separator = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        file.write_all(format!("{separator}{line}\n").as_bytes())?;
        file.sync_all()?;
        Ok(())
    }
}

fn validate_host(host: &str) -> AppResult<()> {
    let valid = !host.is_empty()
        && !host.chars().any(|c| c.is_whitespace() || c.is_control() || ",#*?![]|".contains(c));
    if !valid {
        return Err(AppError::InvalidInput(format!("invalid SSH host {host:?}")));
    }
    Ok(())
}

/// The key of a single `host-token key-type base64` line for exactly `host:port`.
fn parse_trust_line(host: &str, port: u16, line: &str) -> AppResult<PublicKey> {
    validate_host(host)?;
    let invalid = |why: &str| AppError::InvalidInput(format!("invalid known_hosts line: {why}"));
    if line.contains(['\n', '\r']) {
        return Err(invalid("must be a single line"));
    }
    let fields: Vec<&str> = line.split_whitespace().collect();
    let [token, key_type, encoded] = fields.as_slice() else {
        return Err(invalid("expected `host key-type key`"));
    };
    let expected = host_token(host, port);
    if *token != expected {
        return Err(invalid(&format!("it is for {token}, not {expected}")));
    }
    let key = parse_public_key_base64(encoded).map_err(|e| invalid(&e.to_string()))?;
    if key.algorithm().as_str() != *key_type {
        return Err(invalid("the key type does not match the key"));
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const ED_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";
    const ECDSA: &str = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBGz1PqSXVqdpd3bNcaE6j05zCNzI8X7s+El36Io2rs0iVohOwnbKCjKhOv3BSGX+gfKwWTl4Z2qLPNl3wQhVeAo=";

    fn key(encoded: &str) -> PublicKey {
        parse_public_key_base64(encoded).unwrap()
    }

    fn with_files(user: &str, app: &str) -> (tempfile::TempDir, KnownHosts) {
        let dir = tempfile::tempdir().unwrap();
        let (user_path, app_path) = (dir.path().join("user"), dir.path().join("app"));
        std::fs::write(&user_path, user).unwrap();
        std::fs::write(&app_path, app).unwrap();
        (dir, KnownHosts::new(Some(user_path), Some(app_path)))
    }

    #[test]
    fn tokens_and_lines_follow_openssh() {
        assert_eq!(host_token("Bastion.Example", 22), "bastion.example");
        assert_eq!(host_token("10.0.0.1", 2222), "[10.0.0.1]:2222");
        let line = key_line("b", 2222, &key(ED_A)).unwrap();
        assert_eq!(line, format!("[b]:2222 ssh-ed25519 {ED_A}"));
        let described = describe_key(&key(ED_A));
        assert!(described.starts_with("ssh-ed25519 SHA256:"), "{described}");
        // `ssh-keygen -lf` of ED_A.
        assert_eq!(described, "ssh-ed25519 SHA256:T7SvZ2cslqpPj6nKzitCBHHlpVF3r3MvLwmFL0fk0IE");
    }

    #[test]
    fn matches_plain_hashed_and_wildcard_hosts() {
        assert!(hosts_match("pijul.org,37.120.161.53", "37.120.161.53"));
        assert!(!hosts_match("pijul.org", "[pijul.org]:2222"));
        assert!(hosts_match("[pijul.org]:2222", "[pijul.org]:2222"));
        assert!(hosts_match("*.example.com", "db.example.com"));
        assert!(hosts_match("10.0.0.?", "10.0.0.7"));
        assert!(!hosts_match("10.0.0.?", "10.0.0.77"));
        assert!(!hosts_match("*.example.com,!secret.example.com", "secret.example.com"));
        assert!(hosts_match("EXAMPLE.com", "example.com"));
        // From russh's own tests: hashed `example.com`.
        let hashed = "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak=";
        assert!(hosts_match(hashed, "example.com"));
        assert!(!hosts_match(hashed, "example.org"));
        assert!(!hosts_match("|1|bad|base64!", "example.com"));
    }

    #[test]
    fn status_reports_known_unknown_changed_and_revoked() {
        let user = format!(
            "# comment\n\nbastion ssh-ed25519 {ED_A}\n[bastion]:2222   ssh-ed25519\t{ED_B} c\n\
             garbage line\nother ssh-ed25519 not-base64\n"
        );
        let (_dir, hosts) = with_files(&user, "");
        assert_eq!(hosts.status("bastion", 22, &key(ED_A)).unwrap(), HostKeyStatus::Known);
        assert_eq!(hosts.status("BASTION", 22, &key(ED_A)).unwrap(), HostKeyStatus::Known);
        assert!(matches!(
            hosts.status("bastion", 22, &key(ED_B)).unwrap(),
            HostKeyStatus::Changed { location } if location.ends_with("user line 3")
        ));
        assert_eq!(
            hosts.status("bastion", 22, &key(ECDSA)).unwrap(),
            HostKeyStatus::Unknown { other_types: true }
        );
        assert_eq!(
            hosts.status("new", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Unknown { other_types: false }
        );
        assert_eq!(hosts.status("bastion", 2222, &key(ED_B)).unwrap(), HostKeyStatus::Known);

        let revoked =
            format!("@revoked * ssh-ed25519 {ED_A}\n@cert-authority * ssh-ed25519 {ED_B}\n");
        let (_dir, hosts) = with_files(&user, &revoked);
        assert!(matches!(
            hosts.status("bastion", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Revoked { .. }
        ));
        assert_eq!(
            hosts.status("new", 22, &key(ED_B)).unwrap(),
            HostKeyStatus::Unknown { other_types: false },
            "cert-authority lines are not host keys"
        );
    }

    #[test]
    fn missing_files_mean_unknown() {
        let hosts = KnownHosts::new(Some("/nonexistent/ratelquery/kh".into()), None);
        assert_eq!(
            hosts.status("b", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Unknown { other_types: false }
        );
    }

    #[test]
    fn verify_messages_start_with_the_fingerprint() {
        let (_dir, hosts) = with_files(&format!("b ssh-ed25519 {ED_A}\n"), "");
        hosts.verify("b", 22, &key(ED_A)).unwrap();
        let unknown = hosts.verify("c", 2222, &key(ED_A)).unwrap_err();
        assert_eq!(unknown.kind(), "ssh_host_key");
        let message = unknown.to_string();
        let (first, line) = message.split_once('\n').unwrap();
        assert!(first.starts_with(&describe_key(&key(ED_A))), "{first}");
        assert_eq!(line, format!("[c]:2222 ssh-ed25519 {ED_A}"));
        assert!(!first.contains("changed"), "{first}");
        let changed = hosts.verify("b", 22, &key(ED_B)).unwrap_err();
        assert_eq!(changed.kind(), "ssh_host_key");
        let message = changed.to_string();
        assert!(message.starts_with(&describe_key(&key(ED_B))), "{message}");
        assert!(message.contains("changed"), "{message}");
        assert!(message.ends_with(&format!("\nb ssh-ed25519 {ED_B}")), "{message}");
    }

    #[test]
    fn trust_appends_once_and_refuses_changed_keys() {
        let (dir, hosts) = with_files(&format!("b ssh-ed25519 {ED_A}\n"), "existing-no-newline");
        let line = key_line("c", 2222, &key(ED_B)).unwrap();
        hosts.trust("c", 2222, &line).unwrap();
        hosts.trust("c", 2222, &line).unwrap();
        let app = std::fs::read_to_string(dir.path().join("app")).unwrap();
        assert_eq!(app, format!("existing-no-newline\n{line}\n"));
        assert_eq!(hosts.status("c", 2222, &key(ED_B)).unwrap(), HostKeyStatus::Known);

        let changed = key_line("b", 22, &key(ED_B)).unwrap();
        assert_eq!(hosts.trust("b", 22, &changed).unwrap_err().kind(), "invalid_input");
        hosts.trust("b", 22, &key_line("b", 22, &key(ED_A)).unwrap()).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("app")).unwrap(), app, "no-op");
    }

    #[cfg(unix)]
    #[test]
    fn app_file_is_created_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(KNOWN_HOSTS_FILE);
        let hosts = KnownHosts::new(None, Some(path.clone()));
        hosts.trust("b", 22, &key_line("b", 22, &key(ED_A)).unwrap()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn trust_validates_the_line() {
        let dir = tempfile::tempdir().unwrap();
        let hosts = KnownHosts::new(None, Some(dir.path().join(KNOWN_HOSTS_FILE)));
        let good = key_line("b", 22, &key(ED_A)).unwrap();
        for (host, port, line) in [
            ("b", 22, format!("{good}\nevil ssh-ed25519 {ED_B}")),
            ("b", 2222, good.clone()),
            ("other", 22, good.clone()),
            ("b", 22, format!("b ssh-rsa {ED_A}")),
            ("b", 22, "b ssh-ed25519 not-a-key".to_string()),
            ("b", 22, "b".to_string()),
            ("*", 22, format!("* ssh-ed25519 {ED_A}")),
            ("b c", 22, good.clone()),
            ("", 22, good.clone()),
        ] {
            let err = hosts.trust(host, port, &line).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{host} {line}");
        }
        assert!(!dir.path().join(KNOWN_HOSTS_FILE).exists());
    }
}
