//! Live MySQL tests for sessions: reconnects, the retry policy, state events, disconnect and
//! TLS. Run with `RATELQUERY_TEST_MYSQL_URL=mysql://dev:dev@127.0.0.1:3307/sample`.
//! `RATELQUERY_TEST_MYSQL_CA` (optional) points at the server's CA PEM to test `verify_ca`.

mod common;

use std::time::{Duration, Instant};

use common::{Cleanup, Connected, connect, query, rows, test_db, unique};
use std::sync::Arc;

use ratelquery_lib::connections::{
    ConnectionConfig, ConnectionStore, ConnectionsService, MemorySecretStore,
    MysqlConnectionConfig, MysqlTlsMode, SecretStore, probe_mysql,
};
use ratelquery_lib::mysql::{
    self, Cell, MysqlSessions, POOL_BUSY, QueryOptions, RecordingSink, SessionState,
    UNKNOWN_OUTCOME, run_query,
};

const CA_VAR: &str = "RATELQUERY_TEST_MYSQL_CA";

fn states(c: &Connected) -> Vec<SessionState> {
    c.sink.events().iter().map(|e| e.state).collect()
}

/// Waits until a statement containing `tag` shows up in the process list and kills its
/// connection from `killer`.
async fn kill_running(killer: &Connected, tag: &str) {
    let find = format!(
        "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE '%{tag}%' \
         AND INFO NOT LIKE '%PROCESSLIST%'"
    );
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        if let Some(row) = rows(&query(&killer.session, &find).await[0]).rows.first() {
            let Cell::Int(id) = &row[0] else { panic!("unexpected id {row:?}") };
            query(&killer.session, &format!("KILL {id}")).await;
            return;
        }
    }
    panic!("statement tagged {tag} not found");
}

#[tokio::test]
async fn reconnects_after_server_kills_the_connection() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    // The server drops the connection; this call itself may fail.
    let killed = run_query(&c.session, "KILL CONNECTION_ID()", &QueryOptions::default()).await;
    assert_eq!(killed.unwrap_err().kind(), "query");

    let after = query(&c.session, "SELECT CONNECTION_ID()").await;
    assert!(after[0].reconnected(), "first query after the kill reports reconnected");
    // Every pooled connection (the dead one is replaced) keeps working afterwards.
    for _ in 0..4 {
        let again = query(&c.session, "SELECT 1").await;
        assert!(!again[0].reconnected());
    }
    c.sessions.disconnect(&c.id).await;
    assert_eq!(states(&c).first(), Some(&SessionState::Connecting));
    assert_eq!(states(&c).last(), Some(&SessionState::Disconnected));
    assert!(!c.sessions.is_open(&c.id).await);
    assert_eq!(c.sessions.get(&c.id).await.err().map(|e| e.kind()), Some("not_found"));
}

#[tokio::test]
async fn retries_read_statement_once_when_connection_dies_mid_query() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let killer = connect(&db).await;
    let tag = unique("sleep");
    let sql = format!("SELECT 1; SELECT SLEEP(1) AS s, '{tag}' AS tag");
    let session = c.session.clone();
    let running = tokio::spawn(async move { query(&session, &sql).await });
    kill_running(&killer, &tag).await;
    let results = running.await.unwrap();
    assert_eq!(results.len(), 2);
    assert!(!results[0].reconnected());
    assert!(results[1].reconnected(), "retried statement reports reconnected");
    assert_eq!(rows(&results[1]).rows[0][1], Cell::Str(tag.clone()));
    assert!(
        states(&c).ends_with(&[SessionState::Reconnecting, SessionState::Connected]),
        "{:?}",
        states(&c)
    );
}

#[tokio::test]
async fn write_statement_lost_mid_run_is_not_retried() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let killer = connect(&db).await;
    let t =
        cleanup.create_table(&c.session, "it_once", "id INT PRIMARY KEY, n INT", "(1, 0)").await;
    let tag = unique("upd");
    let sql = format!("UPDATE `{t}` SET n = n + 1 WHERE id = 1 AND SLEEP(1) = 0 AND '{tag}' <> ''");
    let session = c.session.clone();
    let running =
        tokio::spawn(async move { run_query(&session, &sql, &QueryOptions::default()).await });
    kill_running(&killer, &tag).await;
    let err = running.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), "connection");
    assert!(err.to_string().starts_with(UNKNOWN_OUTCOME), "{err}");
    let after = query(&c.session, &format!("SELECT n FROM `{t}`")).await;
    assert!(after[0].reconnected(), "the next result reports the lost connection");
    let n = rows(&after[0]).rows[0][0].clone();
    assert!(matches!(&n, Cell::Int(v) if v == "0" || v == "1"), "applied at most once: {n:?}");
}

#[tokio::test]
async fn successful_query_clears_an_error_state() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    // As after a failed background ping.
    c.session.set_state(SessionState::Error, Some("ping timed out".into()));
    query(&c.session, "SELECT 1").await;
    assert_eq!(states(&c).last(), Some(&SessionState::Connected));

    c.session.set_state(SessionState::Error, Some("ping timed out".into()));
    mysql::databases(&c.session).await.unwrap();
    assert_eq!(states(&c).last(), Some(&SessionState::Connected));
    let connected = states(&c).iter().filter(|s| **s == SessionState::Connected).count();
    query(&c.session, "SELECT 1").await;
    let again = states(&c).iter().filter(|s| **s == SessionState::Connected).count();
    assert_eq!(connected, again, "no event when the state does not change");
}

#[tokio::test]
async fn disconnect_does_not_wait_for_running_queries() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let killer = connect(&db).await;
    let tag = unique("long");
    let sql = format!("SELECT SLEEP(2) AS s, '{tag}' AS tag");
    let session = c.session.clone();
    let running =
        tokio::spawn(async move { run_query(&session, &sql, &QueryOptions::default()).await });
    // Wait until the query is running.
    let find = format!(
        "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE '%{tag}%' \
         AND INFO NOT LIKE '%PROCESSLIST%'"
    );
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        if !rows(&query(&killer.session, &find).await[0]).rows.is_empty() {
            break;
        }
    }
    let start = Instant::now();
    c.sessions.disconnect(&c.id).await;
    assert!(start.elapsed() < Duration::from_millis(500), "took {:?}", start.elapsed());
    assert!(!c.sessions.is_open(&c.id).await);
    assert!(running.await.unwrap().is_ok(), "the running query still finishes");
    assert_eq!(states(&c).last(), Some(&SessionState::Disconnected), "no stale state after");
}

#[tokio::test]
async fn probe_reports_version_and_bad_password() {
    let Some(db) = test_db() else { return };
    let ok = probe_mysql(&db.config, db.password.as_deref()).await.unwrap();
    assert!(ok.ok && ok.server_version.is_some_and(|v| !v.is_empty()));
    let err = probe_mysql(&db.config, Some("definitely-wrong")).await.unwrap_err();
    assert_eq!(err.kind(), "connection");
}

fn with_tls(
    config: &MysqlConnectionConfig,
    tls: MysqlTlsMode,
    ca: Option<&str>,
) -> MysqlConnectionConfig {
    MysqlConnectionConfig { tls: Some(tls), ca_cert_path: ca.map(str::to_string), ..config.clone() }
}

/// The Docker server uses its auto-generated, self-signed certificate.
#[tokio::test]
async fn tls_modes_against_a_self_signed_server() {
    let Some(db) = test_db() else { return };
    let password = db.password.as_deref();
    let tls_on = probe_mysql(&with_tls(&db.config, MysqlTlsMode::Required, None), password).await;
    assert!(tls_on.is_ok(), "required encrypts without verifying: {:?}", tls_on.err());
    let ssl = query(&connect(&db).await.session, "SHOW SESSION STATUS LIKE 'Ssl_cipher'").await;
    assert!(
        matches!(&rows(&ssl[0]).rows[0][1], Cell::Str(c) if !c.is_empty()),
        "preferred (the default) negotiates TLS"
    );
    for mode in [MysqlTlsMode::VerifyCa, MysqlTlsMode::VerifyIdentity] {
        let err = probe_mysql(&with_tls(&db.config, mode, None), password).await.unwrap_err();
        assert_eq!(err.kind(), "connection", "{mode:?} must reject an unknown CA");
    }
    let Ok(ca) = std::env::var(CA_VAR) else {
        eprintln!("SKIPPED verify_ca with the server CA: {CA_VAR} is not set");
        return;
    };
    let verified =
        probe_mysql(&with_tls(&db.config, MysqlTlsMode::VerifyCa, Some(&ca)), password).await;
    // The CA is trusted, so the chain verifies. sqlx 0.8.6 only skips the host name check for
    // rustls' `NotValidForName`; rustls 0.23.46 reports `NotValidForNameContext`, so today
    // verify_ca also rejects a certificate that does not name the host (fails closed).
    match verified {
        Ok(_) => {}
        Err(err) => {
            assert_eq!(err.kind(), "connection");
            assert!(err.to_string().contains("not valid for name"), "chain must verify: {err}");
        }
    }
    let identity =
        probe_mysql(&with_tls(&db.config, MysqlTlsMode::VerifyIdentity, Some(&ca)), password).await;
    assert_eq!(
        identity.unwrap_err().kind(),
        "connection",
        "the auto-generated certificate does not name the host"
    );
}

#[tokio::test]
async fn shutdown_works_outside_a_tokio_context() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let session = c.session.clone();
    std::thread::spawn(move || session.shutdown()).join().expect("shutdown must not panic");
    for _ in 0..100 {
        if c.session.pool().is_closed() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(c.session.pool().is_closed());
}

#[tokio::test]
async fn shutdown_all_closes_every_pool() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let other = unique("second");
    c.sessions.connect(&other, &db.config, db.password.as_deref()).await.expect("connect");
    let second = c.sessions.get(&other).await.expect("session");
    let before = c.sink.events().len();
    tokio::time::timeout(Duration::from_secs(5), c.sessions.shutdown_all())
        .await
        .expect("shutdown_all finishes");
    assert!(c.session.pool().is_closed() && second.pool().is_closed());
    assert!(!c.sessions.is_open(&c.id).await && !c.sessions.is_open(&other).await);
    assert_eq!(c.sink.events().len(), before, "no state events on exit");
}

#[tokio::test]
async fn session_only_secret_is_used_but_never_stored() {
    let Some(db) = test_db() else { return };
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let connections =
        Arc::new(ConnectionsService::new(ConnectionStore::new(dir.path()), secrets.clone()));
    let sessions = MysqlSessions::new(Arc::new(RecordingSink::default()));
    let password = db.password.clone().unwrap_or_default();

    // No stored secret: the typed password opens the session and is not saved.
    let saved = connections.save(&ConnectionConfig::Mysql(db.config.clone()), None).unwrap();
    let id = saved.id().to_string();
    sessions.connect_saved(&connections, &id, Some(&password), None).await.expect("connect");
    assert!(sessions.is_open(&id).await);
    assert_eq!(secrets.get(&id).unwrap(), None);
    assert!(!connections.has_secret(&id).unwrap());
    let session = sessions.get(&id).await.unwrap();
    assert_eq!(query(&session, "SELECT 1").await.len(), 1);
    sessions.disconnect(&id).await;

    // A wrong stored secret stays as it is when the session uses a typed one.
    connections.save(&saved, Some("wrong-password")).unwrap();
    sessions.connect_saved(&connections, &id, Some(&password), None).await.expect("connect");
    assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("wrong-password"));
    sessions.disconnect(&id).await;

    // Without a typed secret the stored one is used.
    let err = sessions.connect_saved(&connections, &id, None, None).await.unwrap_err();
    assert_eq!(err.kind(), "connection");
    connections.save(&saved, Some(&password)).unwrap();
    sessions.connect_saved(&connections, &id, None, None).await.expect("stored secret");
    sessions.disconnect(&id).await;
}

fn ends_with(c: &Connected, tail: &[SessionState]) -> bool {
    states(c).ends_with(tail)
}

async fn wait_until_closed(pool: &sqlx::MySqlPool) -> bool {
    for _ in 0..100 {
        if pool.is_closed() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    pool.is_closed()
}

/// Waits until `count` statements containing `tag` run on the server.
async fn wait_running(killer: &Connected, tag: &str, count: usize) {
    let find = format!(
        "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE '%{tag}%' \
         AND INFO NOT LIKE '%PROCESSLIST%'"
    );
    for _ in 0..200 {
        if rows(&query(&killer.session, &find).await[0]).rows.len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{count} statements tagged {tag} did not start");
}

#[tokio::test]
async fn saturated_pool_is_busy_not_a_lost_connection() {
    let Some(db) = test_db() else { return };
    let sink = Arc::new(RecordingSink::default());
    let sessions =
        MysqlSessions::new(sink.clone()).with_acquire_timeout(Duration::from_millis(500));
    let id = db.config.id.clone();
    sessions.connect(&id, &db.config, db.password.as_deref()).await.expect("connect");
    let session = sessions.get(&id).await.unwrap();
    let killer = connect(&db).await;
    let tag = unique("busy");
    let running: Vec<_> = (0..mysql::MAX_CONNECTIONS)
        .map(|_| {
            let (session, sql) = (session.clone(), format!("SELECT SLEEP(3) AS s, '{tag}' AS tag"));
            tokio::spawn(async move { run_query(&session, &sql, &QueryOptions::default()).await })
        })
        .collect();
    wait_running(&killer, &tag, running.len()).await;
    let before = sink.events().len();

    let start = Instant::now();
    let err = run_query(&session, "SELECT 1", &QueryOptions::default()).await.unwrap_err();
    assert!(start.elapsed() < Duration::from_secs(2), "took {:?}", start.elapsed());
    assert_eq!((err.kind(), err.to_string().as_str()), ("connection", POOL_BUSY));
    // The background check skips a busy pool instead of reporting it.
    session.ping().await;
    assert_eq!(sink.events().len(), before, "no state events: {:?}", sink.events());

    for task in running {
        assert!(task.await.unwrap().is_ok(), "the running queries are unaffected");
    }
    let after = query(&session, "SELECT 1").await;
    assert!(!after[0].reconnected(), "nothing was lost");
    assert!(
        !sink
            .events()
            .iter()
            .any(|e| matches!(e.state, SessionState::Reconnecting | SessionState::Error)),
        "{:?}",
        sink.events()
    );
}

#[tokio::test]
async fn reconnecting_an_open_id_replaces_the_session() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    c.sessions.connect(&c.id, &db.config, db.password.as_deref()).await.expect("reconnect");
    assert!(ends_with(
        &c,
        &[SessionState::Disconnected, SessionState::Connecting, SessionState::Connected]
    ));
    assert!(wait_until_closed(&c.session.pool()).await, "the old pool is closed");
    let current = c.sessions.get(&c.id).await.unwrap();
    assert!(!Arc::ptr_eq(&current, &c.session));
    assert_eq!(query(&current, "SELECT 1").await.len(), 1);
}

#[tokio::test]
async fn failed_reconnect_leaves_no_session_behind() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let err = c.sessions.connect(&c.id, &db.config, Some("definitely-wrong")).await.unwrap_err();
    assert_eq!(err.kind(), "connection");
    assert!(ends_with(
        &c,
        &[SessionState::Disconnected, SessionState::Connecting, SessionState::Error]
    ));
    assert!(!c.sessions.is_open(&c.id).await, "error means no session");
    assert!(wait_until_closed(&c.session.pool()).await, "the old pool is closed");
    // A later connect works and owns the state again.
    c.sessions.connect(&c.id, &db.config, db.password.as_deref()).await.expect("connect");
    assert_eq!(states(&c).last(), Some(&SessionState::Connected));
}

#[tokio::test]
async fn background_ping_notices_a_killed_connection() {
    let Some(db) = test_db() else { return };
    let sink = Arc::new(RecordingSink::default());
    let sessions = MysqlSessions::with_ping_interval(sink.clone(), Duration::from_millis(100));
    let id = db.config.id.clone();
    sessions.connect(&id, &db.config, db.password.as_deref()).await.expect("connect");
    let session = sessions.get(&id).await.unwrap();
    let killer = connect(&db).await;
    let own = rows(&query(&session, "SELECT CONNECTION_ID()").await[0]).rows[0][0].clone();
    let Cell::Int(own) = own else { panic!("unexpected id {own:?}") };
    query(&killer.session, &format!("KILL {own}")).await;

    let mut noticed = false;
    for _ in 0..100 {
        if sink.events().iter().any(|e| e.state == SessionState::Error) {
            noticed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(noticed, "ping reports error: {:?}", sink.events());
    let after = query(&session, "SELECT 1").await;
    assert!(after[0].reconnected(), "the next result reports the lost connection");
    assert_eq!(sink.events().last().map(|e| e.state), Some(SessionState::Connected));
    sessions.disconnect(&id).await;
}
