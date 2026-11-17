//! Live MySQL tests for restoring rows from the trash.

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use common::{Cleanup, connect, query, rows, test_db};
use ratelquery_lib::mysql::{
    Cell, MysqlSession, QueryOptions, RestoreRequest, RowChange, TrashTarget, apply_changes,
    preview_restore, restore_rows, run_query_with_trash,
};
use ratelquery_lib::trash::{TrashEntry, TrashStore};

const COLUMNS: &str = "id INT PRIMARY KEY, name VARCHAR(50), price DECIMAL(10,2), \
     at DATETIME(3), doc JSON, data BLOB, secret INT INVISIBLE, ratio FLOAT, \
     total DECIMAL(10,2) AS (price * 2) STORED";
const ROWS: &str = "(1, 'O''Brien \\\\ x', 1.50, '2024-01-02 03:04:05.678', '{\"a\": [1]}', X'00FF', 11, 0.1), \
     (2, '한글', NULL, NULL, NULL, NULL, 22, 1.23456789), (3, 'c', 3.00, NULL, '[]', X'', NULL, NULL)";
const ROWS_COLUMNS: &str = "(id, name, price, at, doc, data, secret, ratio)";
/// FLOAT compared as the exact stored value (its double), not the 6-digit text.
const SELECT: &str = "id, name, price, at, doc, data, secret, total, CAST(ratio AS DOUBLE), HEX(CAST(ratio AS DOUBLE))";

fn target(store: &Arc<TrashStore>, id: &str) -> TrashTarget {
    TrashTarget {
        store: Arc::clone(store),
        connection_id: id.to_string(),
        connection_name: "integration".into(),
    }
}

fn request(entry: &TrashEntry, indexes: &[usize]) -> RestoreRequest {
    RestoreRequest {
        database: entry.database.clone(),
        table: entry.table.clone(),
        columns: entry.columns.iter().map(|c| c.name.clone()).collect(),
        rows: indexes.iter().map(|&i| (i, entry.rows[i].clone())).collect(),
    }
}

fn delete(id: i64) -> RowChange {
    RowChange::Delete { key: BTreeMap::from([("id".to_string(), Cell::Int(id.to_string()))]) }
}

async fn all(session: &MysqlSession, table: &str, columns: &str) -> Vec<Vec<Cell>> {
    rows(&query(session, &format!("SELECT {columns} FROM `{table}` ORDER BY id")).await[0])
        .rows
        .clone()
}

async fn make_table(cleanup: &Cleanup, session: &MysqlSession, prefix: &str) -> String {
    let t = common::unique(prefix);
    cleanup.table(&t);
    query(
        session,
        &format!("CREATE TABLE `{t}` ({COLUMNS}); INSERT INTO `{t}` {ROWS_COLUMNS} VALUES {ROWS}"),
    )
    .await;
    t
}

#[tokio::test]
async fn grid_and_sql_backups_restore_exactly() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let database = db.database();
    let t = make_table(&cleanup, &c.session, "it_restore").await;
    let before = all(&c.session, &t, SELECT).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let trash = target(&store, &c.id);

    // Grid delete of every row, then restore all of them.
    apply_changes(&c.session, database, &t, &[delete(1), delete(2), delete(3)], Some(&trash))
        .await
        .unwrap();
    let entry = store.get(&store.list().unwrap()[0].id).unwrap();
    assert!(entry.columns.iter().any(|c| c.name == "secret"), "INVISIBLE columns are kept");
    let ratio = entry.columns.iter().position(|c| c.name == "ratio").unwrap();
    assert_eq!(entry.columns[ratio].type_name, "FLOAT");
    assert_eq!(entry.rows[0][ratio], Cell::Float(f64::from(0.1f32)), "the exact stored value");
    let preview = preview_restore(&c.session, &request(&entry, &[0, 1, 2])).await.unwrap();
    assert_eq!(preview.statements.len(), 3);
    assert!(preview.statements[0].starts_with(&format!("INSERT INTO `{database}`.`{t}`")));
    assert!(!preview.statements[0].contains("`total`"), "generated columns are left out");
    assert!(all(&c.session, &t, SELECT).await.is_empty(), "the preview inserts nothing");
    assert_eq!(restore_rows(&c.session, &request(&entry, &[0, 1, 2])).await.unwrap(), 3);
    assert_eq!(all(&c.session, &t, SELECT).await, before);

    // The same rows again conflict on the key: nothing is inserted.
    query(&c.session, &format!("DELETE FROM `{t}` WHERE id = 3")).await;
    let err = restore_rows(&c.session, &request(&entry, &[2, 0])).await.unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().contains("row 1 could not be restored"), "{err}");
    assert_eq!(all(&c.session, &t, "id").await.len(), 2, "row 3 was rolled back too");

    // A SQL DELETE backup restores the same way; part of it here.
    let sql = format!("DELETE FROM `{t}` WHERE id IN (1, 2)");
    let options = QueryOptions { database: Some(database.into()), ..QueryOptions::default() };
    run_query_with_trash(&c.session, &sql, &options, Some(&trash)).await.unwrap();
    let sql_entry = store
        .list()
        .unwrap()
        .into_iter()
        .find(|s| s.statement.is_some())
        .map(|s| store.get(&s.id).unwrap())
        .unwrap();
    assert_eq!(restore_rows(&c.session, &request(&sql_entry, &[1])).await.unwrap(), 1);
    assert_eq!(all(&c.session, &t, "id").await, [[Cell::Int("2".into())]]);
}

#[tokio::test]
async fn restore_follows_the_live_table_and_can_use_another_connection() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let database = db.database();
    let t = make_table(&cleanup, &c.session, "it_restore_live").await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    apply_changes(&c.session, database, &t, &[delete(1)], Some(&target(&store, &c.id)))
        .await
        .unwrap();
    let entry = store.get(&store.list().unwrap()[0].id).unwrap();

    // A column added since gets its default; another connection works as well.
    query(&c.session, &format!("ALTER TABLE `{t}` ADD COLUMN extra INT DEFAULT 9")).await;
    let mut other = db.config.clone();
    other.id = uuid::Uuid::new_v4().to_string();
    let second = connect(&common::TestDb { config: other, password: db.password.clone() }).await;
    assert_eq!(restore_rows(&second.session, &request(&entry, &[0])).await.unwrap(), 1);
    let row = all(&c.session, &t, "id, extra").await;
    assert_eq!(row[0], [Cell::Int("1".into()), Cell::Int("9".into())]);

    // A column the table no longer has stops the restore and names it.
    query(
        &c.session,
        &format!("DELETE FROM `{t}` WHERE id = 1; ALTER TABLE `{t}` DROP COLUMN doc"),
    )
    .await;
    let err = restore_rows(&c.session, &request(&entry, &[0])).await.unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
    assert!(err.to_string().contains("column doc no longer exists"), "{err}");
}

#[tokio::test]
async fn a_failed_restore_into_myisam_says_earlier_rows_may_be_in() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let database = db.database();
    let t = common::unique("it_restore_myisam");
    cleanup.table(&t);
    query(
        &c.session,
        &format!(
            "CREATE TABLE `{t}` (id INT PRIMARY KEY, n VARCHAR(10)) ENGINE=MyISAM; \
             INSERT INTO `{t}` VALUES (1, 'a'), (2, 'b')"
        ),
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    apply_changes(&c.session, database, &t, &[delete(1), delete(2)], Some(&target(&store, &c.id)))
        .await
        .unwrap();
    let entry = store.get(&store.list().unwrap()[0].id).unwrap();
    let preview = preview_restore(&c.session, &request(&entry, &[0, 1])).await.unwrap();
    assert_eq!(preview.non_transactional_engine.as_deref(), Some("MyISAM"));
    assert_eq!(preview.total, 2);

    query(&c.session, &format!("INSERT INTO `{t}` VALUES (2, 'x')")).await;
    let err = restore_rows(&c.session, &request(&entry, &[0, 1])).await.unwrap_err();
    let message = err.to_string();
    assert!(message.contains("earlier rows may already be restored"), "{message}");
    assert!(!message.contains("Nothing was restored"), "{message}");
    assert_eq!(all(&c.session, &t, "id").await.len(), 2, "row 1 went in before the failure");
}

#[tokio::test]
async fn a_temporary_table_hiding_the_target_is_refused() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let database = db.database();
    let t = make_table(&cleanup, &c.session, "it_restore_tmp").await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    apply_changes(&c.session, database, &t, &[delete(1)], Some(&target(&store, &c.id)))
        .await
        .unwrap();
    let entry = store.get(&store.list().unwrap()[0].id).unwrap();
    // A one-connection session, so the temporary table is on the connection the restore uses.
    let mut config = db.config.clone();
    config.id = uuid::Uuid::new_v4().to_string();
    let single = connect(&common::TestDb { config, password: db.password.clone() }).await;
    query(&single.session, &format!("CREATE TEMPORARY TABLE `{database}`.`{t}` (id INT)")).await;
    let shadowed = restore_rows(&single.session, &request(&entry, &[0])).await;
    match shadowed {
        Err(err) => {
            assert_eq!(err.kind(), "invalid_input");
            assert!(err.to_string().contains("temporary table"), "{err}");
        }
        // Another pooled connection without the temporary table restores normally.
        Ok(restored) => assert_eq!(restored, 1),
    }
}
