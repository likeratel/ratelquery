//! Shared helpers for tests that need a live MySQL (`DBCLIENT_TEST_MYSQL_URL`).
#![allow(dead_code)]

use std::sync::Arc;

use dbclient_lib::connections::MysqlConnectionConfig;
use dbclient_lib::mysql::{
    MysqlSession, MysqlSessions, QueryOptions, QueryResult, RecordingSink, RowsResult,
};

pub const URL_VAR: &str = "DBCLIENT_TEST_MYSQL_URL";

pub struct TestDb {
    pub config: MysqlConnectionConfig,
    pub password: Option<String>,
}

/// Parses `mysql://user:pass@host:port/db`. Returns `None` (test skipped) when the variable
/// is not set.
pub fn test_db() -> Option<TestDb> {
    let Ok(url) = std::env::var(URL_VAR) else {
        eprintln!("skipping: {URL_VAR} is not set");
        return None;
    };
    let rest = url.strip_prefix("mysql://").expect("URL must start with mysql://");
    let (userinfo, location) = rest.split_once('@').expect("URL needs user@host");
    let (user, password) = match userinfo.split_once(':') {
        Some((u, p)) => (u.to_string(), Some(p.to_string())),
        None => (userinfo.to_string(), None),
    };
    let (hostport, database) = match location.split_once('/') {
        Some((h, d)) if !d.is_empty() => (h, Some(d.to_string())),
        Some((h, _)) => (h, None),
        None => (location, None),
    };
    let (host, port) = hostport.split_once(':').unwrap_or((hostport, "3306"));
    let config = MysqlConnectionConfig {
        id: uuid::Uuid::new_v4().to_string(),
        name: "integration".into(),
        host: host.into(),
        port: port.parse().expect("numeric port"),
        user,
        database,
        color: None,
    };
    Some(TestDb { config, password })
}

pub struct Connected {
    pub sessions: MysqlSessions,
    pub sink: Arc<RecordingSink>,
    pub session: Arc<MysqlSession>,
    pub id: String,
}

pub async fn connect(db: &TestDb) -> Connected {
    let sink = Arc::new(RecordingSink::default());
    let sessions = MysqlSessions::new(sink.clone());
    let id = db.config.id.clone();
    sessions.connect(&id, &db.config, db.password.as_deref()).await.expect("connect");
    let session = sessions.get(&id).await.expect("session");
    Connected { sessions, sink, session, id }
}

pub async fn query(session: &MysqlSession, sql: &str) -> Vec<QueryResult> {
    dbclient_lib::mysql::run_query(session, sql, &QueryOptions::default())
        .await
        .unwrap_or_else(|e| panic!("query {sql:?} failed: {e}"))
}

pub fn rows(result: &QueryResult) -> &RowsResult {
    match result {
        QueryResult::Rows(r) => r,
        QueryResult::Exec(_) => panic!("expected rows, got exec"),
    }
}

pub fn unique(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}
