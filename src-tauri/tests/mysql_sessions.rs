//! Live MySQL tests for sessions: reconnects, the retry policy, state events, disconnect and
//! TLS. Run with `DBCLIENT_TEST_MYSQL_URL=mysql://dev:dev@127.0.0.1:3307/sample`.
//! `DBCLIENT_TEST_MYSQL_CA` (optional) points at the server's CA PEM to test `verify_ca`.

mod common;

use std::time::{Duration, Instant};

use common::{Connected, connect, create_table, drop_table, query, rows, test_db, unique};
use dbclient_lib::connections::{MysqlConnectionConfig, MysqlTlsMode, probe_mysql};
use dbclient_lib::mysql::{self, Cell, QueryOptions, SessionState, UNKNOWN_OUTCOME, run_query};

const CA_VAR: &str = "DBCLIENT_TEST_MYSQL_CA";

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
    let killer = connect(&db).await;
    let t = create_table(&c.session, "it_once", "id INT PRIMARY KEY, n INT", "(1, 0)").await;
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
    drop_table(&c.session, &t).await;
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
