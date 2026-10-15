//! Live MySQL tests for queries, type mapping, schema and reconnects.
//! Run with `DBCLIENT_TEST_MYSQL_URL=mysql://dev:dev@127.0.0.1:3307/sample`.

mod common;

use common::{connect, query, rows, test_db};
use dbclient_lib::connections::probe_mysql;
use dbclient_lib::mysql::{
    self, Cell, QueryOptions, QueryResult, SessionState, TableKind, run_query,
};

fn cell_text(cell: &Cell) -> &str {
    match cell {
        Cell::Str(v)
        | Cell::Int(v)
        | Cell::Decimal(v)
        | Cell::Date(v)
        | Cell::Time(v)
        | Cell::Datetime(v)
        | Cell::Json(v)
        | Cell::Bytes(v) => v,
        other => panic!("no text in {other:?}"),
    }
}

#[tokio::test]
async fn maps_seed_column_types() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let results = query(
        &c.session,
        "SELECT id, email, name, tier, balance, is_active, signed_up_at, profile \
         FROM customers WHERE id = 4",
    )
    .await;
    let r = rows(&results[0]);
    let types: Vec<&str> = r.columns.iter().map(|c| c.type_name.as_str()).collect();
    assert_eq!(
        types,
        ["INT UNSIGNED", "VARCHAR", "VARCHAR", "ENUM", "DECIMAL", "TINYINT", "DATETIME", "JSON"]
    );
    assert!(!r.columns[0].nullable && r.columns[7].nullable);
    let row = &r.rows[0];
    assert_eq!(row[0], Cell::Int("4".into()));
    assert_eq!(row[2], Cell::Str("Margaret Hamilton".into()));
    assert_eq!(row[3], Cell::Str("pro".into()));
    assert_eq!(row[4], Cell::Decimal("42.42".into()));
    assert_eq!(row[5], Cell::Bool(true));
    assert!(matches!(&row[6], Cell::Datetime(v) if v.len() == 19));
    let profile: serde_json::Value = serde_json::from_str(cell_text(&row[7])).unwrap();
    assert_eq!(profile["tags"][0], "apollo");

    let audit =
        query(&c.session, "SELECT created_at, payload FROM audit_log ORDER BY id LIMIT 1").await;
    let created = cell_text(&rows(&audit[0]).rows[0][0]).to_string();
    assert!(matches!(rows(&audit[0]).rows[0][0], Cell::Datetime(_)));
    assert_eq!(
        created.split('.').nth(1).map(str::len),
        Some(3),
        "DATETIME(3) keeps 3 digits: {created}"
    );

    let orders =
        query(&c.session, "SELECT id, total, placed_at, note FROM orders WHERE customer_id = 2")
            .await;
    let order = &rows(&orders[0]).rows[0];
    assert_eq!(rows(&orders[0]).columns[0].type_name, "BIGINT UNSIGNED");
    assert_eq!(order[1], Cell::Decimal("19.99".into()));
    assert!(matches!(order[2], Cell::Datetime(_)));
    assert_eq!(order[3], Cell::Str("gift".into()));
}

#[tokio::test]
async fn maps_other_types_and_literals() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let results = query(
        &c.session,
        "CREATE TEMPORARY TABLE tmp_types (b1 BIT(1), b8 BIT(10), bl BLOB, t TIME(6), d DATE, \
           y YEAR, f FLOAT, dbl DOUBLE, big BIGINT UNSIGNED, neg BIGINT, n INT NULL, \
           dec65 DECIMAL(65,30), ko VARCHAR(20));\n\
         INSERT INTO tmp_types VALUES (b'1', b'1000000001', x'00ff10', '-12:30:00.5', \
           '2024-02-29', 2024, 0.1, 0.1, 18446744073709551615, -9223372036854775808, NULL, \
           '12345678901234567890123456789012345.123456789012345678901234567890', '세종대왕 한글;');\n\
         SELECT * FROM tmp_types",
    )
    .await;
    assert_eq!(results.len(), 3);
    assert!(matches!(&results[1], QueryResult::Exec(e) if e.affected_rows == 1));
    let row = &rows(&results[2]).rows[0];
    assert_eq!(row[0], Cell::Bool(true));
    assert_eq!(row[1], Cell::Int("513".into()));
    assert_eq!(row[2], Cell::Bytes("AP8Q".into()));
    assert_eq!(row[3], Cell::Time("-12:30:00.500000".into()));
    assert_eq!(row[4], Cell::Date("2024-02-29".into()));
    assert_eq!(row[5], Cell::Int("2024".into()));
    assert_eq!(row[6], Cell::Float(0.1));
    assert_eq!(row[7], Cell::Float(0.1));
    assert_eq!(row[8], Cell::Int("18446744073709551615".into()));
    assert_eq!(row[9], Cell::Int("-9223372036854775808".into()));
    assert_eq!(row[10], Cell::Null);
    assert_eq!(
        row[11],
        Cell::Decimal("12345678901234567890123456789012345.123456789012345678901234567890".into())
    );
    assert_eq!(row[12], Cell::Str("세종대왕 한글;".into()));
    let literal = query(&c.session, "SELECT HEX('한'), '한글 메모'").await;
    assert_eq!(
        rows(&literal[0]).rows[0],
        vec![Cell::Str("ED959C".into()), Cell::Str("한글 메모".into())]
    );
}

#[tokio::test]
async fn splits_scripts_and_reports_exec_rows_truncation_and_errors() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let options = QueryOptions { database: Some("sample".into()), max_rows: Some(2) };
    let results = run_query(
        &c.session,
        "SELECT * FROM customers ORDER BY id; SELECT ';' AS semi -- ; comment\n; \
         SELECT * FROM customers WHERE 1 = 0; DO 1",
        &options,
    )
    .await
    .unwrap();
    assert_eq!(results.len(), 4);
    let first = rows(&results[0]);
    assert_eq!((first.row_count, first.truncated), (2, true));
    assert_eq!(first.statement, "SELECT * FROM customers ORDER BY id");
    assert_eq!(rows(&results[1]).rows[0][0], Cell::Str(";".into()));
    let empty = rows(&results[2]);
    assert_eq!((empty.columns.len(), empty.row_count, empty.truncated), (8, 0, false));
    assert!(matches!(&results[3], QueryResult::Exec(e) if e.statement == "DO 1"));
    assert!(results.iter().all(|r| !r.reconnected()));

    let used = query(&c.session, "USE information_schema; SELECT DATABASE()").await;
    assert_eq!(rows(&used[1]).rows[0][0], Cell::Str("information_schema".into()));

    let err = run_query(&c.session, "SELECT 1; SELECT * FROM nope", &QueryOptions::default())
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().starts_with("Table 'sample.nope' doesn't exist"), "{err}");
    assert_eq!(
        run_query(&c.session, " -- nothing ", &QueryOptions::default()).await.unwrap_err().kind(),
        "invalid_input"
    );
}

#[tokio::test]
async fn lists_databases_and_schema() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let names = mysql::databases(&c.session).await.unwrap();
    assert!(names.contains(&"sample".to_string()));
    assert!(!names.iter().any(|n| n == "mysql" || n == "information_schema"));

    let snapshot = mysql::schema(&c.session, "sample").await.unwrap();
    assert_eq!(snapshot.database, "sample");
    let customers = snapshot.tables.iter().find(|t| t.name == "customers").unwrap();
    assert_eq!(customers.kind, TableKind::Table);
    let id = &customers.columns[0];
    assert_eq!((id.name.as_str(), id.type_name.as_str()), ("id", "int unsigned"));
    assert!(id.is_primary && id.is_auto_increment && !id.nullable);
    let tier = customers.columns.iter().find(|c| c.name == "tier").unwrap();
    assert_eq!(tier.default_value.as_deref(), Some("free"));
    let no_pk = snapshot.tables.iter().find(|t| t.name == "no_primary_key").unwrap();
    assert!(no_pk.columns.iter().all(|c| !c.is_primary));
    assert_eq!(mysql::schema(&c.session, "no_such_db").await.unwrap_err().kind(), "not_found");
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
    let states: Vec<SessionState> = c.sink.events().iter().map(|e| e.state).collect();
    assert_eq!(states.first(), Some(&SessionState::Connecting));
    assert_eq!(states.last(), Some(&SessionState::Disconnected));
    assert!(!c.sessions.is_open(&c.id).await);
    assert_eq!(c.sessions.get(&c.id).await.err().map(|e| e.kind()), Some("not_found"));
}

#[tokio::test]
async fn retries_statement_once_when_connection_dies_mid_query() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let killer = connect(&db).await;
    let tag = common::unique("sleep");
    let sql = format!("SELECT 1; SELECT SLEEP(1) AS s, '{tag}' AS tag");
    let session = c.session.clone();
    let running = tokio::spawn(async move { query(&session, &sql).await });
    let find = format!(
        "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP(1) AS s, ''{tag}''%'"
    );
    let mut target = None;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        if let Some(row) = rows(&query(&killer.session, &find).await[0]).rows.first() {
            target = Some(row[0].clone());
            break;
        }
    }
    let Some(Cell::Int(id)) = target else { panic!("sleeping query not found") };
    query(&killer.session, &format!("KILL {id}")).await;
    let results = running.await.unwrap();
    assert_eq!(results.len(), 2);
    assert!(!results[0].reconnected());
    assert!(results[1].reconnected(), "retried statement reports reconnected");
    assert_eq!(rows(&results[1]).rows[0][1], Cell::Str(tag.clone()));
    let states: Vec<SessionState> = c.sink.events().iter().map(|e| e.state).collect();
    assert!(states.ends_with(&[SessionState::Reconnecting, SessionState::Connected]), "{states:?}");
}

#[tokio::test]
async fn probe_reports_version_and_bad_password() {
    let Some(db) = test_db() else { return };
    let ok = probe_mysql(&db.config, db.password.as_deref()).await.unwrap();
    assert!(ok.ok && ok.server_version.is_some_and(|v| !v.is_empty()));
    let err = probe_mysql(&db.config, Some("definitely-wrong")).await.unwrap_err();
    assert_eq!(err.kind(), "connection");
}
