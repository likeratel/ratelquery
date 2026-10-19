//! Live SSH tunnel tests against the compose `ssh` bastion (user dev / dev). Run with
//! `RATELQUERY_TEST_SSH=127.0.0.1:2222` plus `RATELQUERY_TEST_MYSQL_URL` (database user, password
//! and name). `RATELQUERY_TEST_SSH_MYSQL` is the MySQL address as seen from the bastion
//! (default `mysql:3306`).

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{TestDb, query, rows, test_db};
use ratelquery_lib::connections::{
    MysqlConnectionConfig, SshAuth, SshConfig, probe_mysql_via, validate_config,
};
use ratelquery_lib::mysql::{Cell, MysqlSessions, RecordingSink, SessionState};
use ratelquery_lib::ssh::{
    KNOWN_HOSTS_FILE, KnownHosts, PASSPHRASE_REQUIRED, SshTunnel, tunnel_request,
};

const SSH_VAR: &str = "RATELQUERY_TEST_SSH";
const SSH_MYSQL_VAR: &str = "RATELQUERY_TEST_SSH_MYSQL";
const SSH_USER: &str = "dev";
const SSH_PASSWORD: &str = "dev";

struct Bastion {
    host: String,
    port: i64,
    db: TestDb,
    /// The MySQL address as seen from the bastion.
    mysql_host: String,
    mysql_port: i64,
}

fn bastion() -> Option<Bastion> {
    let Ok(address) = std::env::var(SSH_VAR) else {
        eprintln!("SKIPPED live SSH test: {SSH_VAR} is not set (e.g. 127.0.0.1:2222).");
        return None;
    };
    let db = test_db()?;
    let (host, port) = address.rsplit_once(':').expect("host:port");
    let inner = std::env::var(SSH_MYSQL_VAR).unwrap_or_else(|_| "mysql:3306".into());
    let (mysql_host, mysql_port) = inner.rsplit_once(':').expect("host:port");
    Some(Bastion {
        host: host.into(),
        port: port.parse().expect("numeric port"),
        db,
        mysql_host: mysql_host.into(),
        mysql_port: mysql_port.parse().expect("numeric port"),
    })
}

impl Bastion {
    fn ssh(&self, auth: SshAuth) -> SshConfig {
        SshConfig { host: self.host.clone(), port: self.port, user: SSH_USER.into(), auth }
    }

    fn config(&self, auth: SshAuth) -> MysqlConnectionConfig {
        MysqlConnectionConfig {
            id: uuid::Uuid::new_v4().to_string(),
            host: self.mysql_host.clone(),
            port: self.mysql_port,
            ssh: Some(self.ssh(auth)),
            ..self.db.config.clone()
        }
    }

    fn password(&self) -> Option<&str> {
        self.db.password.as_deref()
    }
}

/// An app known_hosts in a temp dir (the user's file is not consulted).
fn empty_known_hosts() -> (tempfile::TempDir, KnownHosts) {
    let dir = tempfile::tempdir().unwrap();
    let hosts = KnownHosts::new(None, Some(dir.path().join(KNOWN_HOSTS_FILE)));
    (dir, hosts)
}

/// Runs the unknown-key flow once: the error's last line is trusted.
async fn trusted_known_hosts(b: &Bastion) -> (tempfile::TempDir, KnownHosts) {
    let (dir, hosts) = empty_known_hosts();
    let config = b.config(SshAuth::Password);
    let request = tunnel_request(&config, Some(SSH_PASSWORD.into()), &hosts).unwrap().unwrap();
    let Err(err) = SshTunnel::open(&request).await else { panic!("the key must be unknown") };
    assert_eq!(err.kind(), "ssh_host_key", "{err}");
    let message = err.to_string();
    let line = message.lines().last().unwrap();
    let port = u16::try_from(b.port).unwrap();
    hosts.trust(&b.host, port, line).expect("trust");
    (dir, hosts)
}

async fn current_user(session: &ratelquery_lib::mysql::MysqlSession) -> String {
    let result = query(session, "SELECT CURRENT_USER()").await;
    match &rows(&result[0]).rows[0][0] {
        Cell::Str(user) => user.clone(),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn unknown_host_key_then_trust_then_query_through_the_tunnel() {
    let Some(b) = bastion() else { return };
    let (_dir, hosts) = empty_known_hosts();
    let config = b.config(SshAuth::Password);
    let request = tunnel_request(&config, Some(SSH_PASSWORD.into()), &hosts).unwrap();
    let err = probe_mysql_via(&config, b.password(), request.as_ref()).await.unwrap_err();
    assert_eq!(err.kind(), "ssh_host_key");
    let message = err.to_string();
    assert!(message.starts_with("ssh-") || message.starts_with("ecdsa-"), "{message}");
    assert!(message.lines().next().unwrap().contains(" SHA256:"), "{message}");
    assert!(!message.contains("changed"), "{message}");
    let line = message.lines().last().unwrap();
    hosts.trust(&b.host, u16::try_from(b.port).unwrap(), line).unwrap();

    let ok = probe_mysql_via(&config, b.password(), request.as_ref()).await.unwrap();
    assert!(ok.server_version.is_some());

    let sink = Arc::new(RecordingSink::default());
    let sessions = MysqlSessions::new(sink.clone()).with_known_hosts(hosts.clone());
    sessions.connect_with_ssh(&config.id, &config, b.password(), Some(SSH_PASSWORD)).await.unwrap();
    let session = sessions.get(&config.id).await.unwrap();
    assert_eq!(session.tunnel_alive(), Some(true));
    assert!(current_user(&session).await.starts_with(&format!("{}@", b.db.config.user)));
    sessions.disconnect(&config.id).await;
    for _ in 0..100 {
        if session.tunnel_alive() == Some(false) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(session.tunnel_alive(), Some(false), "disconnect closes the tunnel");
}

#[tokio::test]
async fn ssh_failures_are_kind_ssh() {
    let Some(b) = bastion() else { return };
    let (_dir, hosts) = trusted_known_hosts(&b).await;
    let config = b.config(SshAuth::Password);
    let probe = |secret: Option<&str>, config: MysqlConnectionConfig| {
        let request = tunnel_request(&config, secret.map(str::to_string), &hosts).unwrap();
        let password = b.password().map(str::to_string);
        async move { probe_mysql_via(&config, password.as_deref(), request.as_ref()).await }
    };
    let wrong = probe(Some("wrong"), config.clone()).await.unwrap_err();
    assert_eq!(wrong.kind(), "ssh", "{wrong}");
    assert!(wrong.to_string().contains("rejected the password"), "{wrong}");
    let missing = probe(None, config.clone()).await.unwrap_err();
    assert_eq!(missing.kind(), "ssh", "{missing}");

    let nowhere = MysqlConnectionConfig { host: "no-such-host.invalid".into(), ..config.clone() };
    let refused = probe(Some(SSH_PASSWORD), nowhere).await.unwrap_err();
    assert_eq!(refused.kind(), "ssh", "{refused}");
    assert!(refused.to_string().contains("did not forward"), "{refused}");

    let mut closed_port = b.ssh(SshAuth::Password);
    closed_port.port = 1;
    let unreachable = MysqlConnectionConfig { ssh: Some(closed_port), ..config.clone() };
    let err = probe(Some(SSH_PASSWORD), unreachable).await.unwrap_err();
    assert_eq!(err.kind(), "ssh", "{err}");
}

/// Installs `public_key` for the dev user over a password-authenticated exec channel.
async fn authorize_key(b: &Bastion, hosts: &KnownHosts, public_key: &str) {
    struct Accept(KnownHosts, String, u16);
    impl russh::client::Handler for Accept {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            key: &russh::keys::PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            let russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } = key else {
                return Ok(false);
            };
            Ok(self.0.verify(&self.1, self.2, key).is_ok())
        }
    }
    let port = u16::try_from(b.port).unwrap();
    let handler = Accept(hosts.clone(), b.host.clone(), port);
    let config = Arc::new(russh::client::Config::default());
    let mut handle =
        russh::client::connect(config, (b.host.as_str(), port), handler).await.unwrap();
    assert!(handle.authenticate_password(SSH_USER, SSH_PASSWORD).await.unwrap().success());
    let mut channel = handle.channel_open_session().await.unwrap();
    let command = format!(
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '{}' >> ~/.ssh/authorized_keys && \
         chmod 600 ~/.ssh/authorized_keys",
        public_key.trim()
    );
    channel.exec(true, command).await.unwrap();
    let mut status = None;
    while let Some(message) = channel.wait().await {
        if let russh::ChannelMsg::ExitStatus { exit_status } = message {
            status = Some(exit_status);
        }
    }
    assert_eq!(status, Some(0), "authorized_keys updated");
}

#[tokio::test]
async fn key_auth_with_and_without_passphrase() {
    let Some(b) = bastion() else { return };
    let (dir, hosts) = trusted_known_hosts(&b).await;
    let keygen = |name: &str, passphrase: &str| {
        let path = dir.path().join(name);
        let status = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", passphrase, "-C", "ratelquery-test", "-f"])
            .arg(&path)
            .status()
            .expect("ssh-keygen is installed");
        assert!(status.success());
        let public = std::fs::read_to_string(path.with_extension("pub")).unwrap();
        (path.to_str().unwrap().to_string(), public)
    };
    let (locked, locked_pub) = keygen("locked", "s3cret");
    let (plain, plain_pub) = keygen("plain", "");
    authorize_key(&b, &hosts, &locked_pub).await;
    authorize_key(&b, &hosts, &plain_pub).await;

    let probe = |key_path: &str, secret: Option<&str>| {
        let config = validate_config(&ratelquery_lib::connections::ConnectionConfig::Mysql(
            b.config(SshAuth::Key { key_path: key_path.into() }),
        ))
        .expect("valid");
        let ratelquery_lib::connections::ConnectionConfig::Mysql(config) = config else {
            unreachable!()
        };
        let request = tunnel_request(&config, secret.map(str::to_string), &hosts).unwrap();
        let password = b.password().map(str::to_string);
        async move { probe_mysql_via(&config, password.as_deref(), request.as_ref()).await }
    };
    let missing = probe(&locked, None).await.unwrap_err();
    assert_eq!(missing.kind(), "ssh");
    assert!(missing.to_string().starts_with(PASSPHRASE_REQUIRED), "{missing}");
    let wrong = probe(&locked, Some("nope")).await.unwrap_err();
    assert_eq!(wrong.kind(), "ssh");
    probe(&locked, Some("s3cret")).await.expect("passphrase unlocks the key");
    probe(&plain, None).await.expect("unencrypted key needs no passphrase");
}

fn states(sink: &RecordingSink) -> Vec<SessionState> {
    sink.events().iter().map(|e| e.state).collect()
}

#[tokio::test]
async fn a_dropped_tunnel_is_reopened_by_the_next_query() {
    let Some(b) = bastion() else { return };
    let (_dir, hosts) = trusted_known_hosts(&b).await;
    let config = b.config(SshAuth::Password);
    let sink = Arc::new(RecordingSink::default());
    let sessions = MysqlSessions::new(sink.clone()).with_known_hosts(hosts);
    sessions.connect_with_ssh(&config.id, &config, b.password(), Some(SSH_PASSWORD)).await.unwrap();
    let session = sessions.get(&config.id).await.unwrap();
    assert!(!query(&session, "SELECT 1").await[0].reconnected());

    session.close_tunnel();
    assert_eq!(session.tunnel_alive(), Some(false));
    let before = sink.events().len();
    let after = query(&session, "SELECT 1").await;
    assert!(after[0].reconnected(), "the first result after the re-open says so");
    assert_eq!(session.tunnel_alive(), Some(true));
    let new_states: Vec<_> = states(&sink).into_iter().skip(before).collect();
    assert_eq!(new_states, vec![SessionState::Reconnecting, SessionState::Connected]);
    assert!(!query(&session, "SELECT 1").await[0].reconnected());

    // `session.run` paths (schema, edits, export) re-open it as well.
    session.close_tunnel();
    let databases = ratelquery_lib::mysql::databases(&session).await.unwrap();
    assert!(databases.iter().any(|d| d == b.db.database()));
    assert_eq!(session.tunnel_alive(), Some(true));
    sessions.disconnect(&config.id).await;
}

#[tokio::test]
async fn the_health_check_reopens_a_dropped_tunnel() {
    let Some(b) = bastion() else { return };
    let (_dir, hosts) = trusted_known_hosts(&b).await;
    let config = b.config(SshAuth::Password);
    let sink = Arc::new(RecordingSink::default());
    let sessions = MysqlSessions::with_ping_interval(sink.clone(), Duration::from_millis(100))
        .with_known_hosts(hosts);
    sessions.connect_with_ssh(&config.id, &config, b.password(), Some(SSH_PASSWORD)).await.unwrap();
    let session = sessions.get(&config.id).await.unwrap();
    session.close_tunnel();
    for _ in 0..100 {
        if session.tunnel_alive() == Some(true) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(session.tunnel_alive(), Some(true), "the ping re-opened it");
    assert!(states(&sink).contains(&SessionState::Reconnecting));
    assert_eq!(query(&session, "SELECT 1").await.len(), 1);
    sessions.disconnect(&config.id).await;
}

#[tokio::test]
async fn a_tunnel_that_cannot_be_reopened_reports_error() {
    let Some(b) = bastion() else { return };
    let (dir, hosts) = trusted_known_hosts(&b).await;
    let config = b.config(SshAuth::Password);
    let sink = Arc::new(RecordingSink::default());
    let sessions = MysqlSessions::new(sink.clone()).with_known_hosts(hosts);
    sessions.connect_with_ssh(&config.id, &config, b.password(), Some(SSH_PASSWORD)).await.unwrap();
    let session = sessions.get(&config.id).await.unwrap();
    // The host key is no longer trusted, so re-opening fails.
    std::fs::remove_file(dir.path().join(KNOWN_HOSTS_FILE)).unwrap();
    session.close_tunnel();
    let err = ratelquery_lib::mysql::run_query(&session, "SELECT 1", &Default::default())
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "ssh_host_key", "{err}");
    assert_eq!(states(&sink).last(), Some(&SessionState::Error));
    sessions.disconnect(&config.id).await;
}
