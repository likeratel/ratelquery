//! Live Amazon Athena tests against a real account. Run only with
//! `DBCLIENT_TEST_ATHENA_PROFILE=<~/.aws profile>` (and optionally
//! `DBCLIENT_TEST_ATHENA_REGION`, default `ap-northeast-2`, and
//! `DBCLIENT_TEST_ATHENA_WORKGROUP`, default `primary`).
//!
//! Everything here is read-only on the AWS side apart from the result files Athena itself
//! writes to the workgroup's result location: no bucket, table or database is created, and
//! every statement is a constant `SELECT` or a metadata statement that scans no data.

use dbclient_lib::athena::{self, AthenaClients, AthenaQueryOptions};
use dbclient_lib::connections::{AthenaConnectionConfig, AwsAuth, probe_athena};
use dbclient_lib::mysql::Cell;

struct Env {
    profile: String,
    region: String,
    workgroup: String,
}

fn env() -> Option<Env> {
    let Ok(profile) = std::env::var("DBCLIENT_TEST_ATHENA_PROFILE") else {
        eprintln!("skipping: DBCLIENT_TEST_ATHENA_PROFILE is not set");
        return None;
    };
    let region =
        std::env::var("DBCLIENT_TEST_ATHENA_REGION").unwrap_or_else(|_| "ap-northeast-2".into());
    let workgroup =
        std::env::var("DBCLIENT_TEST_ATHENA_WORKGROUP").unwrap_or_else(|_| "primary".into());
    Some(Env { profile, region, workgroup })
}

fn config(env: &Env) -> AthenaConnectionConfig {
    AthenaConnectionConfig {
        id: uuid::Uuid::new_v4().to_string(),
        name: "live".into(),
        region: env.region.clone(),
        auth: AwsAuth::Profile { profile: env.profile.clone() },
        workgroup: Some(env.workgroup.clone()),
        output_location: None,
        database: None,
        color: None,
    }
}

fn options(max_rows: Option<i64>) -> AthenaQueryOptions {
    AthenaQueryOptions { database: None, catalog: None, max_rows }
}

#[tokio::test]
async fn probe_reports_workgroup_and_output_location() {
    let Some(env) = env() else { return };
    let result = probe_athena(&config(&env), None).await.expect("probe");
    assert!(result.ok);
    let info = result.athena.expect("athena info");
    assert_eq!(info.workgroup, env.workgroup);
    assert!(
        info.output_location.is_some() || info.missing_bucket.is_some(),
        "either a location or the bucket that is missing: {info:?}"
    );
}

#[tokio::test]
async fn workgroups_databases_and_schema_are_listed() {
    let Some(env) = env() else { return };
    let config = config(&env);
    let (_, client) = athena::connect_sdk(&config, None).await.expect("sdk");
    let workgroups = athena::list_workgroups(&client, &config.auth).await.expect("workgroups");
    assert!(workgroups.contains(&env.workgroup), "{workgroups:?}");

    let clients = AthenaClients::new();
    let handle = clients.connect(&config, None).await.expect("handle");
    let databases = athena::list_databases(&handle).await.expect("databases");
    assert!(!databases.is_empty());
    let snapshot = athena::schema(&handle, &databases[0]).await.expect("schema");
    assert_eq!(snapshot.database, databases[0]);
    for table in &snapshot.tables {
        assert!(!table.name.is_empty());
        for column in &table.columns {
            assert!(!column.type_name.is_empty(), "{}.{}", table.name, column.name);
        }
    }

    let err = athena::schema(&handle, "dbclient-no-such-database-7f3a").await.unwrap_err();
    assert_eq!(err.kind(), "not_found", "{err}");
}

#[tokio::test]
async fn constant_select_is_typed_and_header_row_dropped() {
    let Some(env) = env() else { return };
    let clients = AthenaClients::new();
    let handle = clients.connect(&config(&env), None).await.expect("handle");
    let sql = "SELECT 1 AS one, 'text' AS s, CAST(1.5 AS DOUBLE) AS d, true AS b, \
               DATE '2024-01-02' AS dt, TIMESTAMP '2024-01-02 03:04:05' AS ts, \
               CAST(NULL AS VARCHAR) AS n, DECIMAL '12.30' AS dec, \
               CAST('ab' AS VARBINARY) AS bin";
    let started = athena::start(&handle, sql, &options(None)).await.expect("start");
    let result = athena::wait(&handle, &started.execution_id, None).await.expect("wait");
    let names: Vec<&str> = result.rows.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["one", "s", "d", "b", "dt", "ts", "n", "dec", "bin"]);
    assert_eq!(result.rows.row_count, 1, "header row must not count: {:?}", result.rows.rows);
    let row = &result.rows.rows[0];
    assert_eq!(row[0], Cell::Int("1".into()));
    assert_eq!(row[1], Cell::Str("text".into()));
    assert_eq!(row[2], Cell::Float(1.5));
    assert_eq!(row[3], Cell::Bool(true));
    assert_eq!(row[4], Cell::Date("2024-01-02".into()));
    assert!(
        matches!(&row[5], Cell::Datetime(v) if v.starts_with("2024-01-02 03:04:05")),
        "{row:?}"
    );
    assert_eq!(row[6], Cell::Null);
    assert_eq!(row[7], Cell::Decimal("12.30".into()));
    assert_eq!(row[8], Cell::Bytes("YWI=".into()));
    assert!(!result.rows.truncated);
    assert!(!result.rows.reconnected);
    assert_eq!(result.athena.execution_id, started.execution_id);
    assert_eq!(result.athena.data_scanned_bytes, 0);
    assert_eq!(result.rows.statement, sql);
}

#[tokio::test]
async fn max_rows_truncates_and_metadata_statements_return_text() {
    let Some(env) = env() else { return };
    let clients = AthenaClients::new();
    let handle = clients.connect(&config(&env), None).await.expect("handle");
    let sql = "SELECT * FROM (VALUES 1, 2, 3) AS t(x) ORDER BY x";
    let started = athena::start(&handle, sql, &options(Some(2))).await.expect("start");
    let result = athena::wait(&handle, &started.execution_id, Some(2)).await.expect("wait");
    assert_eq!(result.rows.row_count, 2);
    assert!(result.rows.truncated);

    let started = athena::start(&handle, "SHOW DATABASES", &options(None)).await.expect("start");
    let result = athena::wait(&handle, &started.execution_id, None).await.expect("wait");
    assert!(!result.rows.rows.is_empty());
    assert!(
        result.rows.rows.iter().all(|r| matches!(r[0], Cell::Str(_))),
        "{:?}",
        result.rows.rows
    );
}

#[tokio::test]
async fn failed_statement_is_a_query_error_and_cancel_is_accepted() {
    let Some(env) = env() else { return };
    let clients = AthenaClients::new();
    let handle = clients.connect(&config(&env), None).await.expect("handle");
    let started = athena::start(&handle, "SELECT * FROM no_such_table_7f3a", &options(None))
        .await
        .expect("start");
    let err = athena::wait(&handle, &started.execution_id, None).await.unwrap_err();
    assert_eq!(err.kind(), "query", "{err}");
    assert!(err.to_string().to_lowercase().contains("no_such_table_7f3a"), "{err}");

    let started = athena::start(&handle, "SELECT 1", &options(None)).await.expect("start");
    athena::cancel(&handle, &started.execution_id).await.expect("cancel");
    match athena::wait(&handle, &started.execution_id, None).await {
        Ok(result) => assert_eq!(result.rows.row_count, 1), // finished before the stop landed
        Err(err) => {
            assert_eq!(err.kind(), "query", "{err}");
            assert!(err.to_string().contains("cancelled"), "{err}");
        }
    }
    // Cancelling a finished execution is a no-op.
    athena::cancel(&handle, &started.execution_id).await.expect("cancel again");

    let err = athena::start(&handle, "   ", &options(None)).await.unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
}
