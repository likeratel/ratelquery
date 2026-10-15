//! Shared helpers for tests that need a live MySQL (`DBCLIENT_TEST_MYSQL_URL`).
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use dbclient_lib::connections::MysqlConnectionConfig;
use dbclient_lib::mysql::{
    MysqlSession, MysqlSessions, QueryOptions, QueryResult, RecordingSink, RowsResult,
    connect_options,
};
use sqlx::{Connection, Executor};

pub const URL_VAR: &str = "DBCLIENT_TEST_MYSQL_URL";
const URL_EXAMPLE: &str = "mysql://dev:dev@127.0.0.1:3307/sample";

pub struct TestDb {
    pub config: MysqlConnectionConfig,
    pub password: Option<String>,
}

/// Parses `mysql://user:pass@host:port/db`. Returns `None` (test skipped) when the variable
/// is not set.
pub fn test_db() -> Option<TestDb> {
    let Ok(url) = std::env::var(URL_VAR) else {
        eprintln!(
            "SKIPPED live MySQL test: {URL_VAR} is not set. Run `pnpm db:up` and set \
             {URL_VAR}={URL_EXAMPLE} to run it."
        );
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
        tls: None,
        ca_cert_path: None,
        ssh: None,
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

impl TestDb {
    /// Database named in the URL; tests create their own tables there.
    pub fn database(&self) -> &str {
        self.config.database.as_deref().expect("the test URL must name a database")
    }
}

/// Drops the tables and routines a test created when it goes out of scope, including when an
/// assertion panics. Cleanup runs on its own connection and runtime (a `Drop` cannot await),
/// with foreign key checks off so the order does not matter.
pub struct Cleanup {
    config: MysqlConnectionConfig,
    password: Option<String>,
    statements: Mutex<Vec<String>>,
}

impl Cleanup {
    pub fn new(db: &TestDb) -> Self {
        Self {
            config: db.config.clone(),
            password: db.password.clone(),
            statements: Mutex::default(),
        }
    }

    fn push(&self, statement: String) {
        self.statements.lock().unwrap_or_else(|e| e.into_inner()).push(statement);
    }

    pub fn table(&self, name: &str) {
        self.push(format!("DROP TABLE IF EXISTS `{name}`"));
    }

    pub fn view(&self, name: &str) {
        self.push(format!("DROP VIEW IF EXISTS `{name}`"));
    }

    pub fn procedure(&self, name: &str) {
        self.push(format!("DROP PROCEDURE IF EXISTS `{name}`"));
    }

    /// Creates a uniquely named table from `columns` and `rows` (SQL fragments), registers it
    /// for cleanup and returns its name. Tests own their tables so they never depend on (or
    /// change) the seed data.
    pub async fn create_table(
        &self,
        session: &MysqlSession,
        prefix: &str,
        columns: &str,
        rows: &str,
    ) -> String {
        let table = unique(prefix);
        self.table(&table);
        let insert = if rows.is_empty() {
            String::new()
        } else {
            format!("; INSERT INTO `{table}` VALUES {rows}")
        };
        query(session, &format!("CREATE TABLE `{table}` ({columns}){insert}")).await;
        table
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let statements =
            std::mem::take(&mut *self.statements.lock().unwrap_or_else(|e| e.into_inner()));
        if statements.is_empty() {
            return;
        }
        let (config, password) = (self.config.clone(), self.password.clone());
        let sql = std::iter::once("SET FOREIGN_KEY_CHECKS = 0".to_string())
            .chain(statements.into_iter().rev())
            .collect::<Vec<_>>()
            .join("; ");
        let outcome = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            runtime.block_on(async {
                let options =
                    connect_options(&config, password.as_deref()).map_err(|e| e.to_string())?;
                let mut conn = sqlx::MySqlConnection::connect_with(&options)
                    .await
                    .map_err(|e| e.to_string())?;
                conn.execute(sqlx::raw_sql(&sql)).await.map_err(|e| e.to_string())?;
                conn.close().await.map_err(|e| e.to_string())
            })
        })
        .join();
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(err)) => eprintln!("test cleanup failed: {err}"),
            Err(_) => eprintln!("test cleanup panicked"),
        }
    }
}
