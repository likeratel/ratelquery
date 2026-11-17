//! Live MySQL tests for the trash backup of grid deletes, the change preview and the literal
//! formatter.

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use common::{Cleanup, connect, query, rows, test_db};
use ratelquery_lib::connections::MysqlConnectionConfig;
use ratelquery_lib::mysql::{
    Cell, MysqlSession, RowChange, TrashTarget, apply_changes, apply_changes_on_connection,
    cell_literal, connect_options, preview_changes, preview_changes_on_connection, string_literal,
};
use ratelquery_lib::trash::{TrashStatus, TrashStore};
use sqlx::{Connection, Executor, Row};

const COLUMNS: &str = "id INT PRIMARY KEY, name VARCHAR(100), price DECIMAL(20,4), \
     at DATETIME(3), doc JSON, data BLOB, note TEXT NULL, flag TINYINT(1), ratio DOUBLE";
const ROWS: &str = "(1, 'O''Brien \\\\ back\\nslash', 12345678901234.5678, \
     '2024-01-02 03:04:05.678', '{\"a\": \"b''c\\\\\\\\d\", \"n\": [1, 2]}', X'00FF10275C', NULL, 1, 1.5), \
     (2, '한글 ✓', -0.0001, '1999-12-31 23:59:59.000', '[]', X'', 'n''ote', 0, -2.25e-10), \
     (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)";

fn int(v: i64) -> Cell {
    Cell::Int(v.to_string())
}

fn key(id: i64) -> BTreeMap<String, Cell> {
    BTreeMap::from([("id".to_string(), int(id))])
}

fn delete(id: i64) -> RowChange {
    RowChange::Delete { key: key(id) }
}

fn target(store: &Arc<TrashStore>, id: &str) -> TrashTarget {
    TrashTarget {
        store: Arc::clone(store),
        connection_id: id.to_string(),
        connection_name: "integration".into(),
    }
}

async fn select_all(session: &MysqlSession, table: &str, filter: &str) -> Vec<Vec<Cell>> {
    let sql = format!("SELECT * FROM `{table}` {filter} ORDER BY id");
    rows(&query(session, &sql).await[0]).rows.clone()
}

#[tokio::test]
async fn grid_deletes_are_saved_to_the_trash_and_restore_exactly() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let t = cleanup.create_table(&c.session, "it_trash", COLUMNS, ROWS).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let before = query(&c.session, &format!("SELECT * FROM `{t}` ORDER BY id")).await;
    let before = rows(&before[0]).clone();

    let changes = vec![delete(1), delete(2), delete(3)];
    let applied =
        apply_changes(&c.session, db.database(), &t, &changes, Some(&target(&store, &c.id)))
            .await
            .unwrap();
    assert_eq!(applied.affected_rows, 3);
    assert!(select_all(&c.session, &t, "").await.is_empty());

    let list = store.list().unwrap();
    assert_eq!(list.len(), 1);
    let entry = store.get(&list[0].id).unwrap();
    assert_eq!(entry.status, TrashStatus::Committed);
    assert_eq!((entry.database.as_str(), entry.table.as_str()), (db.database(), t.as_str()));
    assert_eq!(entry.connection_id, c.id);
    assert_eq!(entry.primary_key, ["id"]);
    assert_eq!(list[0].row_count, 3);
    // Decoded exactly like a query result of the same rows.
    assert_eq!(entry.rows, before.rows);
    let names: Vec<(&str, &str)> =
        entry.columns.iter().map(|c| (c.name.as_str(), c.type_name.as_str())).collect();
    let expected: Vec<(&str, &str)> =
        before.columns.iter().map(|c| (c.name.as_str(), c.type_name.as_str())).collect();
    assert_eq!(names, expected);

    // The literals of the saved cells re-insert the same values.
    let values: Vec<String> = entry
        .rows
        .iter()
        .map(|row| {
            let cells: Vec<String> =
                row.iter().map(|cell| cell_literal(cell, true).unwrap()).collect();
            format!("({})", cells.join(", "))
        })
        .collect();
    query(&c.session, &format!("INSERT INTO `{t}` VALUES {}", values.join(", "))).await;
    assert_eq!(select_all(&c.session, &t, "").await, before.rows);
}

#[tokio::test]
async fn failed_applies_leave_no_trash_entry() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let t = cleanup.create_table(&c.session, "it_trash_fail", COLUMNS, ROWS).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let trash = target(&store, &c.id);

    // A row that is not there fails before anything is saved.
    let missing = vec![delete(1), delete(999)];
    let err =
        apply_changes(&c.session, db.database(), &t, &missing, Some(&trash)).await.unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().contains("change 2 matched 0 rows"), "{err}");
    assert!(store.list().unwrap().is_empty());

    // A later statement fails: the saved entry is discarded with the rollback.
    let later = vec![
        delete(1),
        RowChange::Update {
            key: key(999),
            set: BTreeMap::from([("name".to_string(), Cell::Str("x".into()))]),
        },
    ];
    let err = apply_changes(&c.session, db.database(), &t, &later, Some(&trash)).await.unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(store.list().unwrap().is_empty());
    let left: Vec<String> = std::fs::read_dir(store.dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|name| name != ".lock")
        .collect();
    assert!(left.is_empty(), "no entry or temp files left: {left:?}");
    assert_eq!(select_all(&c.session, &t, "").await.len(), 3, "rolled back");

    // The trash cannot be written: nothing is deleted.
    let blocked_dir = tempfile::tempdir().unwrap();
    let blocked = Arc::new(TrashStore::new(blocked_dir.path()));
    std::fs::write(blocked.dir(), "not a folder").unwrap();
    let err =
        apply_changes(&c.session, db.database(), &t, &[delete(1)], Some(&target(&blocked, &c.id)))
            .await
            .unwrap_err();
    assert_eq!(err.kind(), "backup_failed");
    assert_eq!(select_all(&c.session, &t, "").await.len(), 3);

    // Without a backup, deletes run as before and nothing is saved.
    let done = apply_changes(&c.session, db.database(), &t, &[delete(3)], None).await.unwrap();
    assert_eq!(done.affected_rows, 1);
    assert!(store.list().unwrap().is_empty());

    // Inserts and updates alone never write an entry.
    let edits = vec![
        RowChange::Insert { values: BTreeMap::from([("id".to_string(), int(10))]) },
        RowChange::Update {
            key: key(10),
            set: BTreeMap::from([("note".to_string(), Cell::Str("y".into()))]),
        },
    ];
    apply_changes(&c.session, db.database(), &t, &edits, Some(&trash)).await.unwrap();
    assert!(store.list().unwrap().is_empty());
}

#[tokio::test]
async fn preview_shows_the_statements_that_apply_runs() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let t = cleanup.create_table(&c.session, "it_preview", COLUMNS, ROWS).await;
    let database = db.database();
    let changes = vec![
        RowChange::Update {
            key: key(1),
            set: BTreeMap::from([
                ("name".to_string(), Cell::Str("it's a \\ ? test".into())),
                ("price".to_string(), Cell::Decimal("1.50".into())),
            ]),
        },
        delete(2),
        RowChange::Insert {
            values: BTreeMap::from([
                ("id".to_string(), int(4)),
                ("data".to_string(), Cell::Bytes("AP8=".into())),
            ]),
        },
    ];
    let preview = preview_changes(&c.session, database, &t, &changes).await.unwrap();
    assert_eq!(preview.warning, None);
    let preview = preview.statements;
    let target = format!("`{database}`.`{t}`");
    assert_eq!(
        preview,
        [
            format!(
                "UPDATE {target} SET `name` = 'it''s a \\\\ ? test', `price` = '1.50' \
                 WHERE `id` <=> 1 LIMIT 2"
            ),
            format!("DELETE FROM {target} WHERE `id` <=> 2 LIMIT 2"),
            format!("INSERT INTO {target} (`data`, `id`) VALUES (X'00ff', 4)"),
        ]
    );
    assert_eq!(select_all(&c.session, &t, "").await.len(), 3, "the preview runs nothing");

    // Running the previewed text gives the same table as applying the changes.
    query(&c.session, &preview.join(";\n")).await;
    let previewed = select_all(&c.session, &t, "").await;
    let copy = cleanup.create_table(&c.session, "it_preview_copy", COLUMNS, ROWS).await;
    apply_changes(&c.session, database, &copy, &changes, None).await.unwrap();
    assert_eq!(select_all(&c.session, &copy, "").await, previewed);
    assert!(preview_changes(&c.session, database, &t, &[]).await.unwrap().statements.is_empty());
}

async fn raw_connection(
    config: &MysqlConnectionConfig,
    password: Option<&str>,
) -> sqlx::MySqlConnection {
    let options = connect_options(config, password).unwrap();
    sqlx::MySqlConnection::connect_with(&options).await.unwrap()
}

#[tokio::test]
async fn string_literals_round_trip_in_both_sql_modes() {
    let Some(db) = test_db() else { return };
    let mut conn = raw_connection(&db.config, db.password.as_deref()).await;
    let values = [
        "'; DROP TABLE users; --",
        r"\'; DROP TABLE users; --",
        r"\\'; SELECT 1; --",
        "' OR '1'='1",
        "\\",
        "x\\",
        "a\0b\nc\rd\u{1a}e\tf",
        "한글 ✓ 😀",
        "",
    ];
    for mode in ["", "NO_BACKSLASH_ESCAPES"] {
        conn.execute(sqlx::raw_sql(&format!("SET SESSION sql_mode = '{mode}'"))).await.unwrap();
        let escapes = mode.is_empty();
        for value in values {
            let sql = format!("SELECT {}", string_literal(value, escapes));
            let row = conn.fetch_one(sqlx::raw_sql(&sql)).await.unwrap();
            let got: String = row.try_get_unchecked(0).unwrap();
            assert_eq!(got, value, "mode {mode:?}");
        }
    }
    conn.close().await.unwrap();
}

#[tokio::test]
async fn a_multi_byte_client_charset_refuses_the_backup_and_deletes_nothing() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let t = cleanup.create_table(&c.session, "it_trash_gbk", COLUMNS, ROWS).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let trash = target(&store, &c.id);
    let database = db.database();
    let mut conn = raw_connection(&db.config, db.password.as_deref()).await;

    // The default utf8mb4 session backs up on this connection too.
    let done =
        apply_changes_on_connection(&mut conn, database, &t, &[delete(3)], Some(&trash)).await;
    assert_eq!(done.unwrap(), 1);
    assert_eq!(store.list().unwrap().len(), 1);

    conn.execute(sqlx::raw_sql("SET NAMES gbk")).await.unwrap();
    let err = apply_changes_on_connection(&mut conn, database, &t, &[delete(1)], Some(&trash))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "backup_failed");
    assert!(err.to_string().contains("gbk"), "{err}");
    assert!(err.to_string().contains("without a backup"), "{err}");
    assert_eq!(select_all(&c.session, &t, "").await.len(), 2, "nothing was deleted");
    assert_eq!(store.list().unwrap().len(), 1, "no entry was added");

    let preview =
        preview_changes_on_connection(&mut conn, database, &t, &[delete(1)]).await.unwrap();
    assert!(preview.warning.as_deref().is_some_and(|w| w.contains("gbk")), "{preview:?}");
    assert!(preview.statements.is_empty(), "no SQL text in an unsafe character set");

    // Without a backup the delete runs with bound values, as before.
    let done = apply_changes_on_connection(&mut conn, database, &t, &[delete(1)], None).await;
    assert_eq!(done.unwrap(), 1);
    assert_eq!(select_all(&c.session, &t, "").await.len(), 1);
    conn.close().await.unwrap();
}

#[tokio::test]
async fn a_failed_grid_apply_on_myisam_keeps_its_backup_as_uncertain() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let t = cleanup.table_with_engine(&c.session, "it_trash_myisam", "MyISAM").await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let changes = vec![
        delete(1),
        RowChange::Update { key: key(999), set: BTreeMap::from([("id".to_string(), int(5))]) },
    ];
    let err = apply_changes(&c.session, db.database(), &t, &changes, Some(&target(&store, &c.id)))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "query");
    let message = err.to_string();
    assert!(message.contains("MyISAM") && !message.contains("rolled back"), "{message}");
    let list = store.list().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].status, TrashStatus::Uncertain);
    assert!(select_all(&c.session, &t, "").await.is_empty(), "MyISAM kept the delete");
}
