//! Live MySQL tests for grid edits and exports.

mod common;

use std::collections::BTreeMap;

use common::{Cleanup, connect, query, rows, test_db, unique};
use ratelquery_lib::export::{ExportFormat, ExportOptions};
use ratelquery_lib::mysql::{
    Cell, MysqlSession, QueryResult, RowChange, apply_changes, run_export,
};

fn cells(pairs: &[(&str, Cell)]) -> BTreeMap<String, Cell> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

fn int(v: i64) -> Cell {
    Cell::Int(v.to_string())
}

async fn count(session: &MysqlSession, table: &str) -> Cell {
    rows(&query(session, &format!("SELECT COUNT(*) FROM `{table}`")).await[0]).rows[0][0].clone()
}

#[tokio::test]
async fn applies_changes_atomically_with_single_row_guarantee() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let t = unique("it_edit");
    cleanup.table(&t);
    query(
        &c.session,
        &format!(
            "CREATE TABLE `{t}` (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), \
             price DECIMAL(10,2), grp INT); \
             INSERT INTO `{t}` (name, price, grp) VALUES ('a', 1.00, 1), ('b', 2.00, 1), ('c', 3.00, 2)"
        ),
    )
    .await;

    let ok = vec![
        RowChange::Insert {
            values: cells(&[
                ("name", Cell::Str("한글".into())),
                ("price", Cell::Decimal("9.99".into())),
            ]),
        },
        RowChange::Update {
            key: cells(&[("id", int(1))]),
            set: cells(&[("price", Cell::Decimal("1.50".into()))]),
        },
        // Same value: still counts as one matched row.
        RowChange::Update {
            key: cells(&[("id", int(2))]),
            set: cells(&[("name", Cell::Str("b".into()))]),
        },
        RowChange::Delete { key: cells(&[("id", int(3))]) },
    ];
    let result = apply_changes(&c.session, db.database(), &t, &ok).await.unwrap();
    assert_eq!(result.affected_rows, 4);
    let after = query(&c.session, &format!("SELECT price FROM `{t}` WHERE id = 1")).await;
    assert_eq!(rows(&after[0]).rows[0][0], Cell::Decimal("1.50".into()));
    assert_eq!(count(&c.session, &t).await, int(3));

    let missing = vec![
        RowChange::Insert { values: cells(&[("name", Cell::Str("rolled back".into()))]) },
        RowChange::Delete { key: cells(&[("id", int(999))]) },
    ];
    let err = apply_changes(&c.session, db.database(), &t, &missing).await.unwrap_err();
    assert_eq!(err.kind(), "query");
    assert_eq!(count(&c.session, &t).await, int(3), "insert was rolled back");

    let many = vec![RowChange::Update {
        key: cells(&[("grp", int(1))]),
        set: cells(&[("name", Cell::Str("x".into()))]),
    }];
    assert_eq!(
        apply_changes(&c.session, db.database(), &t, &many).await.unwrap_err().kind(),
        "query"
    );
    let names = query(&c.session, &format!("SELECT name FROM `{t}` WHERE id = 1")).await;
    assert_eq!(rows(&names[0]).rows[0][0], Cell::Str("a".into()), "multi-row update rolled back");

    let bad_column = vec![RowChange::Delete { key: cells(&[("nope", int(1))]) }];
    assert_eq!(
        apply_changes(&c.session, db.database(), &t, &bad_column).await.unwrap_err().kind(),
        "invalid_input"
    );
    assert_eq!(
        apply_changes(&c.session, db.database(), "no_table", &ok).await.unwrap_err().kind(),
        "invalid_input"
    );
    assert_eq!(
        apply_changes(&c.session, "no_db", &t, &ok).await.unwrap_err().kind(),
        "invalid_input"
    );
}

fn export_options(format: ExportFormat, path: &std::path::Path) -> ExportOptions {
    ExportOptions {
        format,
        path: path.to_string_lossy().into_owned(),
        table_name: None,
        include_header: None,
        database: None,
    }
}

const PEOPLE_COLUMNS: &str = "id INT UNSIGNED PRIMARY KEY, name VARCHAR(50), \
     balance DECIMAL(10,2), is_active TINYINT(1), profile JSON";
const PEOPLE_ROWS: &str = "(1, 'Ada Lovelace', 1200.50, 1, '{\"tags\": [\"math\"]}'), \
     (2, 'Grace Hopper', 7.00, 0, '{}'), (3, 'Linus Torvalds', 0.00, 1, NULL), \
     (4, 'Margaret Hamilton', 42.42, 1, '{\"tags\": [\"apollo\"]}'), \
     (5, '세종대왕', -3.10, 0, '[]')";

#[tokio::test]
async fn exports_csv_json_and_sql() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let people = cleanup.create_table(&c.session, "it_people", PEOPLE_COLUMNS, PEOPLE_ROWS).await;
    let dir = tempfile::tempdir().unwrap();
    let sql = format!("SELECT id, name, balance, is_active, profile FROM `{people}` ORDER BY id");

    let csv_path = dir.path().join("c.csv");
    let csv =
        run_export(&c.session, &sql, &export_options(ExportFormat::Csv, &csv_path)).await.unwrap();
    let text = std::fs::read_to_string(&csv_path).unwrap();
    assert_eq!(csv.rows, 5);
    assert_eq!(csv.bytes, text.len() as u64);
    assert!(text.starts_with("id,name,balance,is_active,profile\n1,Ada Lovelace,1200.50,1,"));
    assert!(text.contains("4,Margaret Hamilton,42.42,1,"));
    assert!(text.contains("3,Linus Torvalds,0.00,1,\n"));
    assert!(text.contains("5,세종대왕,-3.10,0,[]\n"));

    let json_path = dir.path().join("c.json");
    run_export(&c.session, &sql, &export_options(ExportFormat::Json, &json_path)).await.unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap()).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 5);
    assert_eq!(parsed[0]["id"], 1);
    assert_eq!(parsed[0]["balance"], "1200.50");
    assert_eq!(parsed[0]["is_active"], true);
    assert_eq!(parsed[3]["profile"]["tags"][0], "apollo");
    assert_eq!(parsed[2]["profile"], serde_json::Value::Null);

    // Korean text, quotes and NULL survive CSV.
    let ko_path = dir.path().join("ko.csv");
    run_export(
        &c.session,
        "SELECT '세종대왕' AS 이름, 'a\"b' AS q, NULL AS n",
        &export_options(ExportFormat::Csv, &ko_path),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(&ko_path).unwrap(), "이름,q,n\n세종대왕,\"a\"\"b\",\n");

    let copy = unique("it_copy");
    cleanup.table(&copy);
    let sql_path = dir.path().join("c.sql");
    let options = ExportOptions {
        table_name: Some(copy.clone()),
        ..export_options(ExportFormat::Sql, &sql_path)
    };
    run_export(&c.session, &format!("SELECT * FROM `{people}` ORDER BY id"), &options)
        .await
        .unwrap();
    let inserts = std::fs::read_to_string(&sql_path).unwrap();
    assert_eq!(inserts.lines().count(), 5);
    assert!(inserts.lines().all(|l| l.starts_with(&format!("INSERT INTO `{copy}` ("))));
    // Round trip: the generated statements load back into an identical table.
    query(&c.session, &format!("CREATE TABLE `{copy}` LIKE `{people}`; {inserts}")).await;
    let diff = query(
        &c.session,
        &format!(
            "SELECT COUNT(*) FROM `{people}` p JOIN `{copy}` k \
             USING (id, name, balance, is_active)"
        ),
    )
    .await;
    assert_eq!(rows(&diff[0]).rows[0][0], Cell::Int("5".into()));
}

#[tokio::test]
async fn exports_binary_collation_text_as_text() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let t = cleanup
        .create_table(
            &c.session,
            "it_binexp",
            "id INT PRIMARY KEY, v VARCHAR(10) COLLATE utf8mb4_bin, vb VARBINARY(10), j JSON",
            "(1, 'abc', 'AB', '{\"lang\": \"ko\"}')",
        )
        .await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bin.csv");
    let sql = format!("SELECT v, vb, j->>'$.lang' AS lang FROM `{t}`");
    run_export(&c.session, &sql, &export_options(ExportFormat::Csv, &path)).await.unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "v,vb,lang\nabc,QUI=,ko\n");
    let dup = dir.path().join("dup.json");
    run_export(
        &c.session,
        &format!("SELECT id, id FROM `{t}`"),
        &export_options(ExportFormat::Json, &dup),
    )
    .await
    .unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&dup).unwrap()).unwrap();
    assert_eq!(parsed, serde_json::json!([{ "id": 1, "id_2": 1 }]));
}

#[tokio::test]
async fn export_streams_past_max_rows_and_validates_input() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.csv");
    let sql = "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 900) \
               SELECT a.n FROM s a JOIN s b ON b.n <= 3";
    let result =
        run_export(&c.session, sql, &export_options(ExportFormat::Csv, &path)).await.unwrap();
    assert_eq!(result.rows, 2700);
    assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 2701);

    let empty_path = dir.path().join("empty.csv");
    let t = cleanup
        .create_table(&c.session, "it_empty", "id INT PRIMARY KEY, name VARCHAR(5)", "")
        .await;
    run_export(
        &c.session,
        &format!("SELECT id, name FROM `{t}` WHERE 1 = 0"),
        &export_options(ExportFormat::Csv, &empty_path),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(&empty_path).unwrap(), "id,name\n");

    let options = ExportOptions {
        database: Some("information_schema".into()),
        ..export_options(ExportFormat::Csv, &path)
    };
    let in_db = run_export(&c.session, "SELECT DATABASE() AS db", &options).await.unwrap();
    assert_eq!(in_db.rows, 1);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "db\ninformation_schema\n");

    let two =
        run_export(&c.session, "SELECT 1; SELECT 2", &export_options(ExportFormat::Csv, &path))
            .await;
    assert_eq!(two.unwrap_err().kind(), "invalid_input");
    let relative =
        ExportOptions { path: "relative.csv".into(), ..export_options(ExportFormat::Csv, &path) };
    assert_eq!(
        run_export(&c.session, "SELECT 1", &relative).await.unwrap_err().kind(),
        "invalid_input"
    );
    let failing = dir.path().join("fail.csv");
    let err =
        run_export(&c.session, "SELECT * FROM nope", &export_options(ExportFormat::Csv, &failing))
            .await;
    assert_eq!(err.unwrap_err().kind(), "query");
    assert!(!failing.exists());
    let options = ExportOptions {
        database: Some("no_such_db_for_tests".into()),
        ..export_options(ExportFormat::Csv, &failing)
    };
    let missing_db = run_export(&c.session, "SELECT 1", &options).await;
    assert_eq!(missing_db.unwrap_err().kind(), "invalid_input");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2, "no temp files left");
}

/// Rows are written in blocking batches of 1024; exact multiples and order must survive.
#[tokio::test]
async fn export_batches_keep_every_row_in_order() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let dir = tempfile::tempdir().unwrap();
    for total in [1024u64, 2048, 2049] {
        let path = dir.path().join(format!("rows_{total}.json"));
        let sql = format!(
            "WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 99) \
             SELECT a.n * 100 + b.n + 1 AS n FROM s a JOIN s b \
             WHERE a.n * 100 + b.n < {total} ORDER BY n"
        );
        let result =
            run_export(&c.session, &sql, &export_options(ExportFormat::Json, &path)).await.unwrap();
        assert_eq!(result.rows, total);
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let numbers: Vec<u64> = parsed.iter().map(|v| v["n"].as_u64().unwrap()).collect();
        assert_eq!(numbers, (1..=total).collect::<Vec<_>>());
    }
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3, "no temp files left");
}

/// A `CALL` whose first result set is empty must not pick up the rows of a later set.
#[tokio::test]
async fn call_with_an_empty_first_set_keeps_later_sets_out() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let procedure = unique("it_proc");
    cleanup.procedure(&procedure);
    // Created directly: the statement splitter would cut the body at its `;`.
    sqlx::raw_sql(&format!(
        "CREATE PROCEDURE `{procedure}`() BEGIN \
         SELECT 1 AS a FROM DUAL WHERE 1 = 0; SELECT 2 AS b; END"
    ))
    .execute(&c.session.pool())
    .await
    .expect("create procedure");
    let call = format!("CALL `{procedure}`()");

    let results = query(&c.session, &call).await;
    assert_eq!(results.len(), 1);
    if let QueryResult::Rows(r) = &results[0] {
        assert!(r.rows.is_empty(), "{:?}", r.rows);
        assert!(r.columns.iter().all(|col| col.name != "b"), "{:?}", r.columns);
    }

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("call.csv");
    let exported =
        run_export(&c.session, &call, &export_options(ExportFormat::Csv, &path)).await.unwrap();
    assert_eq!(exported.rows, 0);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.lines().any(|l| l == "2" || l == "b"), "{text:?}");
}
