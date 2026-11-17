use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::mysql::{self, MysqlSession, MysqlSessions, RestorePreview, RestoreRequest};
use crate::state::AppState;
use crate::trash::{TrashEntry, TrashStatus, TrashStore, TrashSummary};
use crate::util::run_blocking;

/// Every readable entry without its rows, newest first.
#[tauri::command]
pub async fn trash_list(state: State<'_, AppState>) -> AppResult<Vec<TrashSummary>> {
    let store = Arc::clone(&state.trash);
    run_blocking(move || store.list()).await
}

#[tauri::command]
pub async fn trash_get(state: State<'_, AppState>, id: String) -> AppResult<TrashEntry> {
    let store = Arc::clone(&state.trash);
    run_blocking(move || store.get(&id)).await
}

#[tauri::command]
pub async fn trash_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let store = Arc::clone(&state.trash);
    run_blocking(move || store.delete(&id)).await
}

/// Removes every entry except deletes still running; returns how many were removed.
#[tauri::command]
pub async fn trash_empty(state: State<'_, AppState>) -> AppResult<usize> {
    let store = Arc::clone(&state.trash);
    run_blocking(move || store.empty()).await
}

/// Removes entries older than `query.trashRetentionDays`; returns how many were removed.
#[tauri::command]
pub async fn trash_purge(state: State<'_, AppState>) -> AppResult<usize> {
    let store = Arc::clone(&state.trash);
    let settings = Arc::clone(&state.settings);
    run_blocking(move || {
        let days = settings.get()?.query.trash_retention_days;
        store.purge(days, chrono::Utc::now())
    })
    .await
}

/// Which rows to restore and where. Without `rowIndexes` every row is restored; without
/// `connectionId` they go back through the entry's own connection.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    #[serde(default)]
    pub row_indexes: Option<Vec<usize>>,
    #[serde(default)]
    pub connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored_rows: u64,
    /// Rows still in the entry (0: the entry was removed).
    pub remaining_rows: usize,
    /// Set when the rows were restored but the entry could not be updated.
    pub warning: Option<String>,
}

/// The entry's rows at `indexes` (all when `None`), checked to be unique and in range.
fn selected_rows(entry: &TrashEntry, indexes: Option<&[usize]>) -> AppResult<Vec<usize>> {
    let Some(indexes) = indexes else { return Ok((0..entry.rows.len()).collect()) };
    let mut sorted = indexes.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.is_empty() || sorted.len() != indexes.len() {
        return Err(AppError::InvalidInput("rowIndexes must be distinct and not empty".into()));
    }
    if let Some(bad) = sorted.iter().find(|&&i| i >= entry.rows.len()) {
        return Err(AppError::InvalidInput(format!(
            "row {bad} is not in the entry, which has {} rows",
            entry.rows.len()
        )));
    }
    Ok(sorted)
}

struct Prepared {
    entry: TrashEntry,
    indexes: Vec<usize>,
    session: Arc<MysqlSession>,
    request: RestoreRequest,
}

/// A pending entry belongs to a delete that is still running.
fn check_restorable(entry: &TrashEntry) -> AppResult<()> {
    if entry.status == TrashStatus::Pending {
        return Err(AppError::InvalidInput(
            "this entry belongs to a delete that is still running; restore it once it finished"
                .into(),
        ));
    }
    Ok(())
}

async fn prepare_restore(
    store: &Arc<TrashStore>,
    sessions: &MysqlSessions,
    id: String,
    options: RestoreOptions,
) -> AppResult<Prepared> {
    let reader = Arc::clone(store);
    let entry = run_blocking(move || reader.get(&id)).await?;
    check_restorable(&entry)?;
    let indexes = selected_rows(&entry, options.row_indexes.as_deref())?;
    let connection_id = options.connection_id.unwrap_or_else(|| entry.connection_id.clone());
    let session = sessions.get(&connection_id).await.map_err(|_| {
        AppError::Connection(format!(
            "the MySQL connection {connection_id} is not open; connect to it, then restore again"
        ))
    })?;
    let request = RestoreRequest {
        database: entry.database.clone(),
        table: entry.table.clone(),
        columns: entry.columns.iter().map(|c| c.name.clone()).collect(),
        rows: indexes.iter().map(|&i| (i, entry.rows[i].clone())).collect(),
    };
    Ok(Prepared { entry, indexes, session, request })
}

/// After the rows were inserted: takes them out of the entry. An entry deleted or purged
/// meanwhile is fine (nothing is left to update); any other failure is a warning, because the
/// rows are in the table already.
fn finish_restore(
    store: &TrashStore,
    id: &str,
    indexes: &[usize],
    total: usize,
    restored: u64,
) -> RestoreResult {
    match store.remove_rows(id, indexes, total) {
        Ok(remaining_rows) => {
            RestoreResult { restored_rows: restored, remaining_rows, warning: None }
        }
        Err(AppError::NotFound(_)) => {
            RestoreResult { restored_rows: restored, remaining_rows: 0, warning: None }
        }
        Err(err) => {
            eprintln!("restored rows of trash entry {id} but could not update it: {err}");
            RestoreResult {
                restored_rows: restored,
                remaining_rows: total,
                warning: Some(format!(
                    "The rows were restored, but the trash entry could not be updated ({err}); \
                     restoring it again would add them twice."
                )),
            }
        }
    }
}

/// `trash_restore` without the Tauri state.
async fn restore_entry(
    store: &Arc<TrashStore>,
    sessions: &MysqlSessions,
    id: String,
    options: RestoreOptions,
) -> AppResult<RestoreResult> {
    let _claim = store.claim_restore(&id)?;
    let prepared = prepare_restore(store, sessions, id, options).await?;
    let restored = mysql::restore_rows(&prepared.session, &prepared.request).await?;
    let store = Arc::clone(store);
    let total = prepared.entry.rows.len();
    let (id, indexes) = (prepared.entry.id, prepared.indexes);
    run_blocking(move || Ok(finish_restore(&store, &id, &indexes, total, restored))).await
}

/// Puts the selected rows back in one transaction (nothing on any failure, unless the table's
/// engine can't roll back), then removes them from the entry (the entry itself when none are
/// left). One restore of an entry at a time.
#[tauri::command]
pub async fn trash_restore(
    state: State<'_, AppState>,
    id: String,
    options: Option<RestoreOptions>,
) -> AppResult<RestoreResult> {
    restore_entry(&state.trash, &state.mysql, id, options.unwrap_or_default()).await
}

/// The INSERTs `trash_restore` would run, as text (the first 200, with the total). Nothing is
/// inserted.
#[tauri::command]
pub async fn trash_restore_preview(
    state: State<'_, AppState>,
    id: String,
    options: Option<RestoreOptions>,
) -> AppResult<RestorePreview> {
    let prepared =
        prepare_restore(&state.trash, &state.mysql, id, options.unwrap_or_default()).await?;
    mysql::preview_restore(&prepared.session, &prepared.request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mysql::{Cell, RecordingSink};
    use crate::trash::{TrashColumn, TrashSource, new_id};

    fn entry(status: TrashStatus) -> TrashEntry {
        TrashEntry {
            id: new_id(),
            status,
            deleted_at: "2026-01-01T00:00:00.000Z".into(),
            connection_id: "c1".into(),
            connection_name: "Local".into(),
            database: "db".into(),
            table: "t".into(),
            source: TrashSource::Grid,
            statement: None,
            columns: vec![TrashColumn { name: "id".into(), type_name: "INT".into() }],
            primary_key: vec!["id".into()],
            rows: (1..=3).map(|i| vec![Cell::Int(i.to_string())]).collect(),
        }
    }

    #[test]
    fn selected_rows_must_be_distinct_and_in_range() {
        let e = entry(TrashStatus::Committed);
        assert_eq!(selected_rows(&e, None).unwrap(), [0, 1, 2]);
        assert_eq!(selected_rows(&e, Some(&[2, 0])).unwrap(), [0, 2]);
        for bad in [&[][..], &[1, 1], &[3]] {
            assert_eq!(
                selected_rows(&e, Some(bad)).unwrap_err().kind(),
                "invalid_input",
                "{bad:?}"
            );
        }
        assert_eq!(
            check_restorable(&entry(TrashStatus::Pending)).unwrap_err().kind(),
            "invalid_input"
        );
        assert!(check_restorable(&entry(TrashStatus::Uncertain)).is_ok());
    }

    fn setup() -> (tempfile::TempDir, Arc<TrashStore>, MysqlSessions, TrashEntry) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TrashStore::new(dir.path()));
        let e = entry(TrashStatus::Committed);
        store.begin(e.clone()).unwrap();
        store.commit(&e.id).unwrap();
        (dir, store, MysqlSessions::new(Arc::new(RecordingSink::default())), e)
    }

    #[tokio::test]
    async fn restore_needs_an_open_connection_and_one_restore_at_a_time() {
        let (_dir, store, sessions, e) = setup();
        let err = restore_entry(&store, &sessions, e.id.clone(), RestoreOptions::default())
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "connection");
        let _claim = store.claim_restore(&e.id).unwrap();
        let err = restore_entry(&store, &sessions, e.id.clone(), RestoreOptions::default())
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("already being restored"));
    }

    #[tokio::test]
    async fn pending_entries_are_not_restored() {
        let (_dir, store, sessions, _) = setup();
        let pending = entry(TrashStatus::Pending);
        store.begin(pending.clone()).unwrap();
        let err = restore_entry(&store, &sessions, pending.id, RestoreOptions::default())
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn finishing_updates_the_entry_or_warns() {
        let (_dir, store, _, e) = setup();
        let done = finish_restore(&store, &e.id, &[0], 3, 1);
        assert_eq!((done.remaining_rows, done.warning.as_deref()), (2, None));
        // The entry changed meanwhile (2 rows now, 3 read): warned, kept.
        let warned = finish_restore(&store, &e.id, &[0], 3, 1);
        assert!(warned.warning.unwrap().contains("could not be updated"));
        assert_eq!(store.get(&e.id).unwrap().rows.len(), 2);
        // Deleted meanwhile: nothing to update, no warning.
        store.delete(&e.id).unwrap();
        let gone = finish_restore(&store, &e.id, &[0, 1], 2, 2);
        assert_eq!((gone.remaining_rows, gone.warning), (0, None));
    }
}
