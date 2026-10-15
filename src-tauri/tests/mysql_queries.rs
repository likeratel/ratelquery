//! Live MySQL tests for queries, type mapping and schema. Every test creates its own tables.
//! Run with `DBCLIENT_TEST_MYSQL_URL=mysql://dev:dev@127.0.0.1:3307/sample`.

mod common;

use common::{connect, create_table, drop_table, query, rows, test_db};
use dbclient_lib::mysql::{self, Cell, QueryOptions, QueryResult, TableKind, run_query};

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

fn type_names(result: &QueryResult) -> Vec<&str> {
    rows(result).columns.iter().map(|c| c.type_name.as_str()).collect()
}

const CUSTOMER_COLUMNS: &str = "id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT, \
     email VARCHAR(100) NOT NULL, name VARCHAR(100), tier ENUM('free','pro') DEFAULT 'free', \
     balance DECIMAL(12,2), is_active TINYINT(1), signed_up_at DATETIME, profile JSON, \
     created_at DATETIME(3), big BIGINT UNSIGNED";

#[tokio::test]
async fn maps_table_column_types() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let t = create_table(
        &c.session,
        "it_types",
        CUSTOMER_COLUMNS,
        "(4, 'mh@example.com', 'Margaret Hamilton', 'pro', 42.42, 1, '2024-01-02 03:04:05', \
          '{\"tags\": [\"apollo\"]}', '2024-01-02 03:04:05.120', 18446744073709551615)",
    )
    .await;
    let results = query(&c.session, &format!("SELECT * FROM `{t}` WHERE id = 4")).await;
    assert_eq!(
        type_names(&results[0]),
        [
            "INT UNSIGNED",
            "VARCHAR",
            "VARCHAR",
            "ENUM",
            "DECIMAL",
            "TINYINT",
            "DATETIME",
            "JSON",
            "DATETIME",
            "BIGINT UNSIGNED"
        ]
    );
    let r = rows(&results[0]);
    assert!(!r.columns[0].nullable && r.columns[7].nullable);
    let row = &r.rows[0];
    assert_eq!(row[0], Cell::Int("4".into()));
    assert_eq!(row[2], Cell::Str("Margaret Hamilton".into()));
    assert_eq!(row[3], Cell::Str("pro".into()));
    assert_eq!(row[4], Cell::Decimal("42.42".into()));
    assert_eq!(row[5], Cell::Bool(true));
    assert_eq!(row[6], Cell::Datetime("2024-01-02 03:04:05".into()));
    let profile: serde_json::Value = serde_json::from_str(cell_text(&row[7])).unwrap();
    assert_eq!(profile["tags"][0], "apollo");
    assert_eq!(row[8], Cell::Datetime("2024-01-02 03:04:05.120".into()), "DATETIME(3) keeps 3");
    assert_eq!(row[9], Cell::Int("18446744073709551615".into()));
    drop_table(&c.session, &t).await;
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
async fn binary_collation_text_is_text_and_binary_columns_stay_bytes() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let t = create_table(
        &c.session,
        "it_bin",
        "id INT PRIMARY KEY, v VARCHAR(10) COLLATE utf8mb4_bin, tx TEXT COLLATE utf8mb4_bin, \
         vb VARBINARY(10), bl BLOB, profile JSON",
        "(1, 'abc', '한글 텍스트', 'AB', x'00ff', '{\"lang\": \"ko\"}')",
    )
    .await;
    let results = query(
        &c.session,
        &format!("SELECT v, tx, vb, bl, profile->>'$.lang' AS lang, profile FROM `{t}`"),
    )
    .await;
    let types = type_names(&results[0]);
    assert_eq!(&types[..4], ["VARCHAR", "TEXT", "VARBINARY", "BLOB"]);
    assert!(types[4].ends_with("TEXT"), "->> result is text: {types:?}");
    assert_eq!(types[5], "JSON");
    let row = &rows(&results[0]).rows[0];
    assert_eq!(row[0], Cell::Str("abc".into()));
    assert_eq!(row[1], Cell::Str("한글 텍스트".into()));
    assert_eq!(row[2], Cell::Bytes("QUI=".into()), "UTF-8-looking VARBINARY stays bytes");
    assert_eq!(row[3], Cell::Bytes("AP8=".into()));
    assert_eq!(row[4], Cell::Str("ko".into()));

    // Without a single base table the values decide.
    let joined =
        query(&c.session, &format!("SELECT a.v, a.bl FROM `{t}` a JOIN `{t}` b ON a.id = b.id"))
            .await;
    assert_eq!(type_names(&joined[0]), ["VARCHAR", "BLOB"]);
    assert_eq!(rows(&joined[0]).rows[0], vec![Cell::Str("abc".into()), Cell::Bytes("AP8=".into())]);
    let unquoted = query(&c.session, "SELECT JSON_UNQUOTE('\"x\"') AS u, x'00ff' AS raw").await;
    assert_eq!(rows(&unquoted[0]).rows[0], vec![Cell::Str("x".into()), Cell::Bytes("AP8=".into())]);
    drop_table(&c.session, &t).await;
}

#[tokio::test]
async fn tinyint1_only_maps_zero_and_one_to_bool() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let t = create_table(
        &c.session,
        "it_tiny",
        "id INT PRIMARY KEY, flag TINYINT(1), uflag TINYINT(1) UNSIGNED",
        "(1, 0, 1), (2, 1, 0)",
    )
    .await;
    let bools = query(&c.session, &format!("SELECT flag, uflag FROM `{t}` ORDER BY id")).await;
    assert_eq!(type_names(&bools[0]), ["TINYINT", "TINYINT UNSIGNED"]);
    assert_eq!(rows(&bools[0]).rows[0], vec![Cell::Bool(false), Cell::Bool(true)]);

    query(&c.session, &format!("INSERT INTO `{t}` VALUES (3, 2, 255), (4, -1, NULL)")).await;
    let mixed = query(&c.session, &format!("SELECT flag, uflag FROM `{t}` ORDER BY id")).await;
    let values: Vec<Vec<Cell>> = rows(&mixed[0]).rows.clone();
    assert_eq!(values[0], vec![Cell::Int("0".into()), Cell::Int("1".into())]);
    assert_eq!(values[2], vec![Cell::Int("2".into()), Cell::Int("255".into())]);
    assert_eq!(values[3], vec![Cell::Int("-1".into()), Cell::Null]);
    drop_table(&c.session, &t).await;
}

#[tokio::test]
async fn splits_scripts_and_reports_exec_rows_truncation_and_errors() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let t = create_table(
        &c.session,
        "it_script",
        "id INT PRIMARY KEY, a VARCHAR(5), b INT",
        "(1, 'x', 1), (2, 'y', 2), (3, 'z', 3)",
    )
    .await;
    let options = QueryOptions { database: Some(db.database().into()), max_rows: Some(2) };
    let first_sql = format!("SELECT * FROM `{t}` ORDER BY id");
    let results = run_query(
        &c.session,
        &format!(
            "{first_sql}; SELECT ';' AS semi -- ; comment\n; \
             SELECT * FROM `{t}` WHERE 1 = 0; DO 1"
        ),
        &options,
    )
    .await
    .unwrap();
    assert_eq!(results.len(), 4);
    let first = rows(&results[0]);
    assert_eq!((first.row_count, first.truncated), (2, true));
    assert_eq!(first.statement, first_sql);
    assert_eq!(rows(&results[1]).rows[0][0], Cell::Str(";".into()));
    let empty = rows(&results[2]);
    assert_eq!((empty.columns.len(), empty.row_count, empty.truncated), (3, 0, false));
    assert!(matches!(&results[3], QueryResult::Exec(e) if e.statement == "DO 1"));
    assert!(results.iter().all(|r| !r.reconnected()));

    let used = query(&c.session, "USE information_schema; SELECT DATABASE()").await;
    assert_eq!(rows(&used[1]).rows[0][0], Cell::Str("information_schema".into()));

    let err = run_query(&c.session, "SELECT 1; SELECT * FROM nope", &QueryOptions::default())
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "query");
    let expected = format!("Table '{}.nope' doesn't exist", db.database());
    assert!(err.to_string().starts_with(&expected), "{err}");
    assert_eq!(
        run_query(&c.session, " -- nothing ", &QueryOptions::default()).await.unwrap_err().kind(),
        "invalid_input"
    );
    drop_table(&c.session, &t).await;
}

#[tokio::test]
async fn unknown_options_database_is_invalid_input() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let options = QueryOptions { database: Some("no_such_db_for_tests".into()), max_rows: None };
    let err = run_query(&c.session, "SELECT 1", &options).await.unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
    assert!(err.to_string().contains("no_such_db_for_tests"), "{err}");
}

#[tokio::test]
async fn connection_words_in_a_query_error_are_not_a_lost_connection() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let t = create_table(&c.session, "it_words", "id INT PRIMARY KEY", "(1)").await;
    let err = run_query(
        &c.session,
        &format!("SELECT `connection reset` FROM `{t}`"),
        &QueryOptions::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(err.kind(), "query", "{err}");
    let next = query(&c.session, "SELECT 1").await;
    assert!(!next[0].reconnected());
    drop_table(&c.session, &t).await;
}

#[tokio::test]
async fn lists_databases_and_schema() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let names = mysql::databases(&c.session).await.unwrap();
    assert!(names.contains(&db.database().to_string()));
    assert!(!names.iter().any(|n| n == "mysql" || n == "information_schema"));

    let with_pk = create_table(&c.session, "it_schema", CUSTOMER_COLUMNS, "").await;
    let no_pk = create_table(&c.session, "it_nopk", "a INT, b VARCHAR(5)", "").await;
    let snapshot = mysql::schema(&c.session, db.database()).await.unwrap();
    assert_eq!(snapshot.database, db.database());
    let table = snapshot.tables.iter().find(|t| t.name == with_pk).unwrap();
    assert_eq!(table.kind, TableKind::Table);
    let id = &table.columns[0];
    assert_eq!((id.name.as_str(), id.type_name.as_str()), ("id", "int unsigned"));
    assert!(id.is_primary && id.is_auto_increment && !id.nullable);
    let tier = table.columns.iter().find(|c| c.name == "tier").unwrap();
    assert_eq!(tier.default_value.as_deref(), Some("free"));
    let plain = snapshot.tables.iter().find(|t| t.name == no_pk).unwrap();
    assert!(plain.columns.iter().all(|c| !c.is_primary));
    assert_eq!(mysql::schema(&c.session, "no_such_db").await.unwrap_err().kind(), "not_found");
    drop_table(&c.session, &with_pk).await;
    drop_table(&c.session, &no_pk).await;
}
