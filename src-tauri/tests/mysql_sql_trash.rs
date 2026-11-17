//! Live MySQL tests for DELETE statements run from the editor with a trash backup.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{Cleanup, connect, query, rows, test_db};
use ratelquery_lib::connections::MysqlConnectionConfig;
use ratelquery_lib::mysql::{
    BackupStoppedResult, Cell, DeleteBackupOptions, MysqlSession, QueryOptions, QueryResult,
    TrashTarget, backed_delete_on_connection, connect_options, run_query_with_trash,
};
use ratelquery_lib::trash::{TrashSource, TrashStatus, TrashStore};
use sqlx::{Connection, Executor};

const COLUMNS: &str = "id INT PRIMARY KEY, name VARCHAR(50), data BLOB";
const ROWS: &str = "(1, 'O''Brien', X'00FF'), (2, 'b\\\\c', NULL), (3, '한글', X'41')";

fn target(store: &Arc<TrashStore>, id: &str) -> TrashTarget {
    TrashTarget {
        store: Arc::clone(store),
        connection_id: id.to_string(),
        connection_name: "integration".into(),
    }
}

fn options(database: &str) -> QueryOptions {
    QueryOptions { database: Some(database.to_string()), ..QueryOptions::default() }
}

/// Continues `stop` without a backup for it (and `skip`).
fn resume(database: &str, stop: &BackupStoppedResult, skip: &[usize]) -> QueryOptions {
    let skip = skip.iter().copied().chain([stop.statement_index]).collect();
    QueryOptions {
        start_at: Some(stop.statement_index),
        resume_token: stop.resume_token.clone(),
        delete_backup: Some(DeleteBackupOptions { skip }),
        ..options(database)
    }
}

fn last_stop(results: &[QueryResult]) -> BackupStoppedResult {
    match results.last() {
        Some(QueryResult::BackupStopped(stop)) => stop.clone(),
        other => panic!("expected a backup stop, got {other:?}"),
    }
}

fn count(results: &[QueryResult]) -> Cell {
    rows(results.last().unwrap()).rows[0][0].clone()
}

async fn ids(session: &MysqlSession, table: &str) -> Vec<Vec<Cell>> {
    rows(&query(session, &format!("SELECT id FROM `{table}` ORDER BY id")).await[0]).rows.clone()
}

async fn run(
    session: &MysqlSession,
    sql: &str,
    options: &QueryOptions,
    trash: &TrashTarget,
) -> Vec<QueryResult> {
    run_query_with_trash(session, sql, options, Some(trash))
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

#[tokio::test]
async fn deletes_from_the_editor_are_backed_up_and_unsupported_ones_stop() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let t = cleanup.create_table(&c.session, "it_sqltrash", COLUMNS, ROWS).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let trash = target(&store, &c.id);
    let database = db.database();
    let before =
        query(&c.session, &format!("SELECT * FROM `{t}` WHERE id IN (1, 2) ORDER BY id")).await;

    // A plain DELETE is backed up; the entry holds exactly the deleted rows.
    let delete = format!("DELETE FROM `{t}` WHERE id IN (1, 2) ORDER BY id");
    let sql = format!("/* tidy */ {delete}; SELECT COUNT(*) FROM `{t}`");
    let results = run(&c.session, &sql, &options(database), &trash).await;
    let QueryResult::Exec(exec) = &results[0] else { panic!("{:?}", results[0]) };
    assert_eq!((exec.affected_rows, exec.trashed_rows), (2, Some(2)));
    let entry = store.get(exec.trash_id.as_deref().unwrap()).unwrap();
    assert_eq!(entry.status, TrashStatus::Committed);
    assert_eq!(entry.source, TrashSource::Sql);
    assert_eq!(entry.statement.as_deref(), Some(delete.as_str()), "leading comment dropped");
    assert_eq!((entry.database.as_str(), entry.table.as_str()), (database, t.as_str()));
    assert_eq!(entry.primary_key, ["id"]);
    assert_eq!(entry.rows, rows(&before[0]).rows);
    assert_eq!(count(&results), Cell::Int("1".into()));

    // A DELETE that deletes nothing writes no entry.
    let results =
        run(&c.session, &format!("DELETE FROM `{t}` WHERE id = 99"), &options(database), &trash)
            .await;
    let QueryResult::Exec(exec) = &results[0] else { panic!() };
    assert_eq!((exec.trashed_rows, exec.trash_id.as_deref()), (Some(0), None));
    assert_eq!(store.list().unwrap().len(), 1);

    // An unsupported DELETE doesn't run, and neither does anything after it.
    let sql = format!("SELECT 1; DELETE IGNORE FROM `{t}` WHERE id = 3; DELETE FROM `{t}`");
    let results = run(&c.session, &sql, &options(database), &trash).await;
    assert_eq!(results.len(), 2);
    let stop = last_stop(&results);
    assert_eq!(stop.statement_index, 1);
    assert!(stop.reason.contains("IGNORE"), "{}", stop.reason);
    assert!(stop.resume_token.is_some());
    assert_eq!(ids(&c.session, &t).await.len(), 1);

    // Without the token, continuing is refused.
    let mut no_token = resume(database, &stop, &[]);
    no_token.resume_token = None;
    let err = run_query_with_trash(&c.session, &sql, &no_token, Some(&trash)).await.unwrap_err();
    assert_eq!(err.kind(), "invalid_input");

    // With it, the run goes on from where it stopped, without a backup for that statement.
    let results = run(&c.session, &sql, &resume(database, &stop, &[]), &trash).await;
    assert_eq!(results.len(), 2);
    let QueryResult::Exec(exec) = &results[0] else { panic!() };
    assert_eq!((exec.affected_rows, exec.trashed_rows), (1, None));
    let QueryResult::Exec(exec) = &results[1] else { panic!() };
    assert_eq!((exec.affected_rows, exec.trashed_rows), (0, Some(0)));

    // A token works once.
    let err = run_query_with_trash(&c.session, &sql, &resume(database, &stop, &[]), Some(&trash))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
    assert!(err.to_string().contains("from the start"), "{err}");

    // A script that controls transactions backs up none of its deletes. (`SET autocommit = 1`
    // changes nothing here, but counts like BEGIN.)
    query(&c.session, &format!("INSERT INTO `{t}` (id) VALUES (7)")).await;
    let sql = format!("SELECT 1; SET autocommit = 1; DELETE FROM `{t}` WHERE id = 7");
    let stop = last_stop(&run(&c.session, &sql, &options(database), &trash).await);
    assert_eq!(stop.statement_index, 2);
    assert!(stop.reason.contains("transactions"), "{}", stop.reason);
    assert_eq!(ids(&c.session, &t).await, [[Cell::Int("7".into())]]);
}

#[tokio::test]
async fn continuing_keeps_the_session_state_of_the_stopped_run() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let t = cleanup.create_table(&c.session, "it_sqltrash_state", COLUMNS, ROWS).await;
    let dir = tempfile::tempdir().unwrap();
    let trash = target(&Arc::new(TrashStore::new(dir.path())), &c.id);
    let database = db.database();
    let sql = format!(
        "SET @v = 5; SET FOREIGN_KEY_CHECKS = 0; DELETE IGNORE FROM `{t}` WHERE id = 1; \
         SELECT @v, @@SESSION.foreign_key_checks"
    );
    let stop = last_stop(&run(&c.session, &sql, &options(database), &trash).await);
    assert_eq!(stop.statement_index, 2);
    // Other work meanwhile uses other connections.
    query(&c.session, "SELECT 1").await;
    let results = run(&c.session, &sql, &resume(database, &stop, &[]), &trash).await;
    assert_eq!(rows(&results[1]).rows[0], [Cell::Int("5".into()), Cell::Int("0".into())]);
}

#[tokio::test]
async fn an_oversized_backup_stops_early_and_the_rest_runs_once() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let database = db.database();
    let big = cleanup.create_table(&c.session, "it_sqltrash_big", "id INT PRIMARY KEY", "").await;
    let log = cleanup.create_table(&c.session, "it_sqltrash_log", "n INT", "").await;
    query(
        &c.session,
        &format!(
            "SET SESSION cte_max_recursion_depth = 200000; INSERT INTO `{big}` (id) WITH RECURSIVE \
             seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 100000) SELECT n FROM seq"
        ),
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let trash = target(&store, &c.id);
    let sql = format!(
        "INSERT INTO `{log}` VALUES (1); DELETE FROM `{big}`; SELECT COUNT(*) FROM `{log}`"
    );
    let started = Instant::now();
    let results = run(&c.session, &sql, &options(database), &trash).await;
    let elapsed = started.elapsed();
    assert_eq!(results.len(), 2);
    let stop = last_stop(&results);
    assert_eq!(stop.statement_index, 1);
    assert!(stop.reason.contains("10000"), "{}", stop.reason);
    assert!(elapsed < Duration::from_secs(5), "stopped without reading every row: {elapsed:?}");
    assert!(store.list().unwrap().is_empty());
    let left = query(&c.session, &format!("SELECT COUNT(*) FROM `{big}`")).await;
    assert_eq!(count(&left), Cell::Int("100000".into()), "nothing was deleted");

    let results = run(&c.session, &sql, &resume(database, &stop, &[]), &trash).await;
    let QueryResult::Exec(exec) = &results[0] else { panic!() };
    assert_eq!(exec.affected_rows, 100_000);
    assert_eq!(count(&results), Cell::Int("1".into()), "the INSERT before did not run again");

    // A LIMIT over the backup limit stops before anything is read.
    query(&c.session, &format!("INSERT INTO `{big}` (id) VALUES (1), (2)")).await;
    let sql = format!("DELETE FROM `{big}` ORDER BY id LIMIT 20000");
    let stop = last_stop(&run(&c.session, &sql, &options(database), &trash).await);
    assert!(stop.reason.contains("LIMIT"), "{}", stop.reason);

    let err = run_query_with_trash(
        &c.session,
        &sql,
        &QueryOptions { start_at: Some(3), ..options(database) },
        Some(&trash),
    )
    .await
    .unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
}

#[tokio::test]
async fn deleted_rows_must_be_the_backed_up_rows() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let database = db.database();
    let values: Vec<String> = (1..=50).map(|i| format!("({i}, 'n{i}', NULL)")).collect();
    let t = cleanup.create_table(&c.session, "it_sqltrash_set", COLUMNS, &values.join(", ")).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let trash = target(&store, &c.id);

    // Same count, other rows: the backup reads one random row, the delete removes another.
    let sql = format!("DELETE FROM `{t}` ORDER BY RAND() LIMIT 1");
    let mut caught = None;
    for _ in 0..20 {
        let results = run(&c.session, &sql, &options(database), &trash).await;
        if let Some(QueryResult::BackupStopped(stop)) = results.last() {
            caught = Some(stop.reason.clone());
            break;
        }
    }
    let reason = caught.expect("a different row was picked at least once");
    assert!(reason.contains("other rows"), "{reason}");
    let left = ids(&c.session, &t).await.len();

    let _ = left;
    // Another count: RAND() picks a different number of rows for the backup and the delete.
    let refill: Vec<String> = (1..=50).map(|i| format!("({i}, 'n{i}', NULL)")).collect();
    let refill = format!("INSERT IGNORE INTO `{t}` VALUES {}", refill.join(", "));
    let sql = format!("DELETE FROM `{t}` WHERE RAND() < 0.5");
    let mut counted = false;
    for _ in 0..30 {
        query(&c.session, &refill).await;
        let results = run(&c.session, &sql, &options(database), &trash).await;
        if let Some(QueryResult::BackupStopped(stop)) = results.last()
            && stop.reason.contains("backup read")
        {
            counted = true;
            break;
        }
    }
    assert!(counted, "a different count was picked at least once");
    assert_eq!(ids(&c.session, &t).await.len(), 50, "the mismatched delete was undone");

    // Assignments would run twice, so they are never backed up.
    let sql = format!("DELETE FROM `{t}` WHERE (@n := @n + 1) <= 2");
    let stop = last_stop(&run(&c.session, &sql, &options(database), &trash).await);
    assert!(stop.reason.contains(":="), "{}", stop.reason);
    assert!(store.list().unwrap().iter().all(|e| e.status == TrashStatus::Committed));
}

async fn raw_connection(
    config: &MysqlConnectionConfig,
    password: Option<&str>,
    database: &str,
) -> sqlx::MySqlConnection {
    let options = connect_options(config, password).unwrap();
    let mut conn = sqlx::MySqlConnection::connect_with(&options).await.unwrap();
    conn.execute(sqlx::raw_sql(&format!("USE `{database}`"))).await.unwrap();
    conn
}

#[tokio::test]
async fn session_and_table_conditions_that_stop_the_backup() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let database = db.database();
    let t = cleanup.create_table(&c.session, "it_sqltrash_tx", COLUMNS, ROWS).await;
    let nokey = cleanup.create_table(&c.session, "it_sqltrash_nokey", "a INT", "(1), (2)").await;
    let myisam = cleanup.table_with_engine(&c.session, "it_sqltrash_myisam", "MyISAM").await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let trash = target(&store, &c.id);
    let mut conn = raw_connection(&db.config, db.password.as_deref(), database).await;
    let stopped = async |conn: &mut sqlx::MySqlConnection, sql: &str| {
        backed_delete_on_connection(conn, sql, &trash).await.unwrap().unwrap_err()
    };
    let delete = format!("DELETE FROM `{t}` WHERE id = 1");

    conn.execute(sqlx::raw_sql("SET autocommit = 0")).await.unwrap();
    assert!(stopped(&mut conn, &delete).await.contains("autocommit"));
    conn.execute(sqlx::raw_sql("SET autocommit = 1")).await.unwrap();

    conn.execute(sqlx::raw_sql(&format!("BEGIN; INSERT INTO `{t}` (id) VALUES (50)")))
        .await
        .unwrap();
    assert!(stopped(&mut conn, &delete).await.contains("transaction is open"));
    conn.execute(sqlx::raw_sql("ROLLBACK")).await.unwrap();

    // Without a primary key, only deletes whose rows can't differ are backed up.
    let sub = format!("DELETE FROM `{nokey}` WHERE a IN (SELECT 1)");
    assert!(stopped(&mut conn, &sub).await.contains("no primary key"));
    let limited = format!("DELETE FROM `{nokey}` ORDER BY a LIMIT 1");
    assert!(stopped(&mut conn, &limited).await.contains("LIMIT"));
    let plain = format!("DELETE FROM `{nokey}` WHERE a = 2");
    let done = backed_delete_on_connection(&mut conn, &plain, &trash).await.unwrap().unwrap();
    assert_eq!(done.trashed_rows, Some(1));

    // Engines without transactions can't undo a failed delete.
    let reason = stopped(&mut conn, &format!("DELETE FROM `{myisam}`")).await;
    assert!(reason.contains("MyISAM"), "{reason}");

    // Temporary tables: not in the schema, or hiding the table of the same name.
    conn.execute(sqlx::raw_sql("CREATE TEMPORARY TABLE it_tmp_only (id INT)")).await.unwrap();
    let reason = stopped(&mut conn, "DELETE FROM it_tmp_only").await;
    assert!(reason.contains("temporary"), "{reason}");
    let done = conn.execute(sqlx::raw_sql("DELETE FROM it_tmp_only")).await.unwrap();
    assert_eq!(done.rows_affected(), 0, "without a backup it runs as usual");
    conn.execute(sqlx::raw_sql(&format!("CREATE TEMPORARY TABLE `{t}` (id INT)"))).await.unwrap();
    let reason = stopped(&mut conn, &delete).await;
    assert!(reason.contains("temporary table"), "{reason}");
    conn.execute(sqlx::raw_sql(&format!("DROP TEMPORARY TABLE `{t}`"))).await.unwrap();

    assert_eq!(ids(&c.session, &t).await.len(), 3, "nothing was deleted or committed");
    let done = backed_delete_on_connection(&mut conn, &delete, &trash).await.unwrap().unwrap();
    assert_eq!(done.trashed_rows, Some(1));
    conn.close().await.unwrap();
}

#[tokio::test]
async fn a_missing_table_stops_and_then_fails_with_the_server_error() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let dir = tempfile::tempdir().unwrap();
    let trash = target(&Arc::new(TrashStore::new(dir.path())), &c.id);
    let database = db.database();
    let sql = "DELETE FROM it_no_such_table WHERE id = 1";
    let stop = last_stop(&run(&c.session, sql, &options(database), &trash).await);
    assert!(stop.reason.contains("does not exist"), "{}", stop.reason);
    let err = run_query_with_trash(&c.session, sql, &resume(database, &stop, &[]), Some(&trash))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().contains("1146"), "{err}");
}

#[tokio::test]
async fn table_changes_in_the_script_are_seen_by_later_backups() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let database = db.database();
    let t = cleanup.create_table(&c.session, "it_sqltrash_ddl", COLUMNS, ROWS).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let trash = target(&store, &c.id);

    let sql = format!(
        "DELETE FROM `{t}` WHERE id = 1; ALTER TABLE `{t}` ADD COLUMN extra INT DEFAULT 7; \
         DELETE FROM `{t}` WHERE id = 2; ALTER TABLE `{t}` DROP COLUMN name; \
         DELETE FROM `{t}` WHERE id = 3"
    );
    let results = run(&c.session, &sql, &options(database), &trash).await;
    let ids: Vec<&str> = results
        .iter()
        .filter_map(|r| match r {
            QueryResult::Exec(e) => e.trash_id.as_deref(),
            _ => None,
        })
        .collect();
    assert_eq!(ids.len(), 3, "{results:?}");
    let names = |id: &str| -> Vec<String> {
        store.get(id).unwrap().columns.into_iter().map(|c| c.name).collect()
    };
    assert_eq!(names(ids[0]), ["id", "name", "data"]);
    assert_eq!(names(ids[1]), ["id", "name", "data", "extra"]);
    assert_eq!(store.get(ids[1]).unwrap().rows[0][3], Cell::Int("7".into()), "the new column");
    assert_eq!(names(ids[2]), ["id", "data", "extra"], "the dropped column is gone");
}

#[tokio::test]
async fn keys_that_cant_be_matched_and_risky_calls_stop() {
    let Some(db) = test_db() else { return };
    let c = connect(&db).await;
    let cleanup = Cleanup::new(&db);
    let database = db.database();
    let f = cleanup
        .create_table(&c.session, "it_sqltrash_float", "id FLOAT PRIMARY KEY", "(0.1)")
        .await;
    let t = cleanup.create_table(&c.session, "it_sqltrash_misc", COLUMNS, ROWS).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TrashStore::new(dir.path()));
    let trash = target(&store, &c.id);

    // A FLOAT key is read as its exact stored value, so its rows are matched and checked.
    let results = run(&c.session, &format!("DELETE FROM `{f}`"), &options(database), &trash).await;
    let QueryResult::Exec(exec) = &results[0] else { panic!("{results:?}") };
    assert_eq!(exec.trashed_rows, Some(1));
    let entry = store.get(exec.trash_id.as_deref().unwrap()).unwrap();
    assert_eq!(entry.columns[0].type_name, "FLOAT");
    assert_eq!(entry.rows[0][0], Cell::Float(f64::from(0.1f32)));

    // A call that could have side effects never runs twice.
    let sql = format!("DELETE FROM `{t}` WHERE SLEEP(0) = 0 AND id = 1");
    let stop = last_stop(&run(&c.session, &sql, &options(database), &trash).await);
    assert!(stop.reason.contains("side effects"), "{}", stop.reason);

    // A DELETE the server can't parse: the backup stops, and without it the server's own error.
    let sql = format!("DELETE FROM `{t}` WHERE");
    let stop = last_stop(&run(&c.session, &sql, &options(database), &trash).await);
    assert!(stop.reason.contains("syntax couldn't be checked"), "{}", stop.reason);
    let err = run_query_with_trash(&c.session, &sql, &resume(database, &stop, &[]), Some(&trash))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().contains("1064"), "{err}");

    // A token only continues the run and statement it was given for.
    let sql = format!("SELECT 1; DELETE IGNORE FROM `{t}` WHERE id = 1");
    let stop = last_stop(&run(&c.session, &sql, &options(database), &trash).await);
    let other = format!("{sql}; SELECT 2");
    let err = run_query_with_trash(&c.session, &other, &resume(database, &stop, &[]), Some(&trash))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
    assert!(err.to_string().contains("another script"), "{err}");
    let results = run(&c.session, &sql, &resume(database, &stop, &[]), &trash).await;
    assert!(matches!(&results[0], QueryResult::Exec(e) if e.affected_rows == 1), "still kept");
    assert_eq!(store.list().unwrap().len(), 1, "only the FLOAT delete was backed up");
}
