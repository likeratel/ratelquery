//! `<config dir>/trash/<id>.json`: one owner-only file per entry, replaced atomically.
//!
//! Every operation holds an in-process mutex and an advisory lock on `trash/.lock`, so a status
//! change can never resurrect an entry that was deleted meanwhile and two writers (threads or
//! app instances) never interleave. The folder must be a real folder, and only regular entry
//! files are read, up to a size limit.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use chrono::{DateTime, Duration, Utc};

use super::model::{
    MAX_BACKUP_BYTES, MAX_BACKUP_ROWS, SummaryFile, TrashEntry, TrashStatus, TrashSummary, check_id,
};
use crate::error::{AppError, AppResult};
use crate::fsutil::write_private_atomic;

const DIR_NAME: &str = "trash";
const EXTENSION: &str = "json";
/// The advisory lock file; not an entry (its name is no id).
const LOCK_NAME: &str = ".lock";
/// Held by the first running app instance for its lifetime; not an entry either.
const INSTANCE_NAME: &str = ".instance";
/// Temp files `write_private_atomic` leaves behind when the app stops mid-write.
const TEMP_SUFFIX: &str = ".tmp";
/// Largest entry file read: the backup limit plus room for a longer status after a rewrite.
const READ_LIMIT: u64 = MAX_BACKUP_BYTES as u64 + 1024;

#[cfg(unix)]
const PRIVATE_DIR_MODE: u32 = 0o700;
#[cfg(unix)]
const PRIVATE_FILE_MODE: u32 = 0o600;

#[derive(Debug)]
pub struct TrashStore {
    dir: PathBuf,
    lock: Mutex<()>,
    /// Entries being restored now, so the same rows are never inserted twice at once.
    restoring: Mutex<std::collections::HashSet<String>>,
    /// `trash/.instance`, locked for the life of the process once claimed.
    instance: Mutex<Option<File>>,
}

/// Held for the length of one store operation.
struct Locked<'a> {
    _thread: MutexGuard<'a, ()>,
    /// Dropping the file releases the advisory lock.
    _file: File,
}

/// Why a file could not be written, in words a user can act on.
fn describe_write_error(err: &std::io::Error) -> String {
    match err.kind() {
        ErrorKind::StorageFull => format!("the disk is full ({err})"),
        ErrorKind::PermissionDenied => format!("permission was denied ({err})"),
        ErrorKind::ReadOnlyFilesystem => format!("the disk is read-only ({err})"),
        _ => err.to_string(),
    }
}

/// Where a JSON file stopped parsing, without any of its content (which may be row data).
fn describe_json_error(err: &serde_json::Error) -> String {
    let category = match err.classify() {
        serde_json::error::Category::Io => "read error",
        serde_json::error::Category::Syntax => "syntax error",
        serde_json::error::Category::Data => "unexpected data",
        serde_json::error::Category::Eof => "unexpected end",
    };
    format!("{category} at line {}, column {}", err.line(), err.column())
}

/// `backup_failed` with `reason` (what went wrong) in a message that says nothing changed.
pub fn backup_failed(reason: impl std::fmt::Display) -> AppError {
    AppError::BackupFailed(format!(
        "The deleted rows could not be saved to the trash, so nothing was changed: {reason}. \
         You can apply without a backup."
    ))
}

fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc))
}

impl TrashStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            dir: config_dir.join(DIR_NAME),
            lock: Mutex::new(()),
            restoring: Mutex::new(std::collections::HashSet::new()),
            instance: Mutex::new(None),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.{EXTENSION}"))
    }

    /// Creates the folder owner-only, and makes an existing one owner-only. A symbolic link or
    /// a file in its place is refused.
    fn ensure_dir(&self) -> std::io::Result<()> {
        match fs::symlink_metadata(&self.dir) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(std::io::Error::other("the trash folder is a symbolic link"));
            }
            Ok(meta) if !meta.is_dir() => {
                return Err(std::io::Error::other("the trash folder is not a folder"));
            }
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {
                let mut builder = fs::DirBuilder::new();
                builder.recursive(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(PRIVATE_DIR_MODE);
                }
                builder.create(&self.dir)?;
            }
            Err(e) => return Err(e),
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.dir, fs::Permissions::from_mode(PRIVATE_DIR_MODE))?;
        }
        Ok(())
    }

    /// Takes the in-process mutex, then the advisory lock on `trash/.lock` (blocking while
    /// another app instance holds it). Creates the folder.
    fn lock_io(&self) -> std::io::Result<Locked<'_>> {
        let thread = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_dir()?;
        let file = self.open_private(LOCK_NAME)?;
        file.lock()?;
        Ok(Locked { _thread: thread, _file: file })
    }

    fn open_private(&self, name: &str) -> std::io::Result<File> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(PRIVATE_FILE_MODE);
        }
        options.open(self.dir.join(name))
    }

    /// Tries to become the instance that owns the trash: locks `trash/.instance` without waiting
    /// and keeps it locked until the process exits. Only the owner may [`TrashStore::recover`],
    /// since a `pending` entry of another running instance belongs to a delete still in
    /// progress. `false` when another instance owns it or the lock could not be taken (logged).
    pub fn claim_instance(&self) -> bool {
        let mut held = self.instance.lock().unwrap_or_else(|e| e.into_inner());
        if held.is_some() {
            return true;
        }
        let claimed = {
            let _locked = match self.lock_io() {
                Ok(locked) => locked,
                Err(err) => {
                    eprintln!("trash: could not open the trash folder: {err}");
                    return false;
                }
            };
            self.open_private(INSTANCE_NAME)
                .map_err(std::fs::TryLockError::Error)
                .and_then(|file| file.try_lock().map(|()| file))
        };
        match claimed {
            Ok(file) => {
                *held = Some(file);
                true
            }
            Err(std::fs::TryLockError::WouldBlock) => false,
            Err(std::fs::TryLockError::Error(err)) => {
                eprintln!("trash: could not lock {INSTANCE_NAME}: {err}");
                false
            }
        }
    }

    fn lock(&self) -> AppResult<Locked<'_>> {
        self.lock_io().map_err(|e| AppError::Io(format!("could not open the trash folder: {e}")))
    }

    /// Writes `entry` as `pending` before its delete runs. Over [`MAX_BACKUP_ROWS`] rows or
    /// [`MAX_BACKUP_BYTES`] encoded, or when the file cannot be written, this is
    /// `backup_failed` and nothing is left on disk.
    pub fn begin(&self, entry: TrashEntry) -> AppResult<()> {
        check_id(&entry.id)?;
        if entry.rows.len() > MAX_BACKUP_ROWS {
            return Err(backup_failed(format!(
                "{} rows are more than the {MAX_BACKUP_ROWS} one backup can hold",
                entry.rows.len()
            )));
        }
        let entry = TrashEntry { status: TrashStatus::Pending, ..entry };
        let json =
            serde_json::to_vec(&entry).map_err(|e| backup_failed(describe_json_error(&e)))?;
        if json.len() > MAX_BACKUP_BYTES {
            return Err(backup_failed(too_large_reason(json.len())));
        }
        let _locked = self.lock_io().map_err(|e| {
            backup_failed(format!(
                "the trash folder could not be opened ({})",
                describe_write_error(&e)
            ))
        })?;
        write_private_atomic(&self.path(&entry.id), &json)
            .map_err(|e| backup_failed(describe_write_error(&e)))
    }

    /// The delete was committed.
    pub fn commit(&self, id: &str) -> AppResult<()> {
        self.set_status(id, TrashStatus::Committed)
    }

    /// The outcome of the delete is unknown (connection lost during COMMIT).
    pub fn mark_uncertain(&self, id: &str) -> AppResult<()> {
        self.set_status(id, TrashStatus::Uncertain)
    }

    fn set_status(&self, id: &str, status: TrashStatus) -> AppResult<()> {
        check_id(id)?;
        let _locked = self.lock()?;
        let entry = self.read_entry(id)?;
        self.write(&TrashEntry { status, ..entry })
    }

    fn write(&self, entry: &TrashEntry) -> AppResult<()> {
        let json = serde_json::to_vec(entry).map_err(|e| {
            AppError::Io(format!(
                "could not encode trash entry {}: {}",
                entry.id,
                describe_json_error(&e)
            ))
        })?;
        write_private_atomic(&self.path(&entry.id), &json).map_err(|e| {
            AppError::Io(format!(
                "could not write trash entry {}: {}",
                entry.id,
                describe_write_error(&e)
            ))
        })
    }

    /// Removes the entry of a delete that was rolled back. A missing file is fine.
    pub fn discard(&self, id: &str) -> AppResult<()> {
        check_id(id)?;
        let _locked = self.lock()?;
        match self.remove(id) {
            Err(AppError::NotFound(_)) => Ok(()),
            other => other,
        }
    }

    fn remove(&self, id: &str) -> AppResult<()> {
        match fs::remove_file(self.path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Err(not_found(id)),
            Err(e) => Err(AppError::Io(format!("could not remove trash entry {id}: {e}"))),
        }
    }

    /// Ids of the entry files, in no particular order. Other files are ignored.
    fn ids(&self) -> AppResult<Vec<String>> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(AppError::Io(format!("could not read the trash folder: {e}"))),
        };
        let mut ids = Vec::new();
        for entry in entries {
            let entry =
                entry.map_err(|e| AppError::Io(format!("could not read the trash folder: {e}")))?;
            let name = entry.file_name();
            let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue };
            if check_id(id).is_ok() {
                ids.push(id.to_string());
            }
        }
        Ok(ids)
    }

    /// The text of a regular entry file (never through a symbolic link) of at most
    /// [`READ_LIMIT`] bytes.
    fn read_text(&self, id: &str) -> AppResult<String> {
        let path = self.path(id);
        let unreadable = |e: std::io::Error| match e.kind() {
            ErrorKind::NotFound => not_found(id),
            _ => AppError::Io(format!("could not read trash entry {id}: {e}")),
        };
        let meta = fs::symlink_metadata(&path).map_err(unreadable)?;
        if !meta.file_type().is_file() {
            return Err(AppError::Io(format!("trash entry {id} is not a regular file")));
        }
        if meta.len() > READ_LIMIT {
            return Err(AppError::Io(format!(
                "trash entry {id} is larger than {READ_LIMIT} bytes"
            )));
        }
        let mut text = String::new();
        File::open(&path)
            .and_then(|file| file.take(READ_LIMIT + 1).read_to_string(&mut text))
            .map_err(unreadable)?;
        if u64::try_from(text.len()).unwrap_or(u64::MAX) > READ_LIMIT {
            return Err(AppError::Io(format!(
                "trash entry {id} is larger than {READ_LIMIT} bytes"
            )));
        }
        Ok(text)
    }

    /// An entry whose file does not parse, or whose id differs from its file name, is `io`.
    fn read_entry(&self, id: &str) -> AppResult<TrashEntry> {
        let entry: TrashEntry = serde_json::from_str(&self.read_text(id)?).map_err(|e| {
            AppError::Io(format!("trash entry {id} is not valid: {}", describe_json_error(&e)))
        })?;
        if entry.id != id {
            return Err(AppError::Io(format!("trash entry {id} names another id")));
        }
        Ok(entry)
    }

    fn read_summary(&self, id: &str) -> AppResult<TrashSummary> {
        let file: SummaryFile = serde_json::from_str(&self.read_text(id)?).map_err(|e| {
            AppError::Io(format!("trash entry {id} is not valid: {}", describe_json_error(&e)))
        })?;
        let summary = file.into_summary();
        if summary.id != id {
            return Err(AppError::Io(format!("trash entry {id} names another id")));
        }
        Ok(summary)
    }

    /// The summaries of every readable entry, newest first. Unreadable files are logged and
    /// skipped (and left alone).
    fn summaries(&self) -> AppResult<Vec<TrashSummary>> {
        let mut summaries: Vec<TrashSummary> = self
            .ids()?
            .iter()
            .filter_map(|id| match self.read_summary(id) {
                Ok(summary) => Some(summary),
                Err(AppError::NotFound(_)) => None,
                Err(err) => {
                    eprintln!("skipping trash entry {id}: {err}");
                    None
                }
            })
            .collect();
        summaries.sort_by(|a, b| {
            let key = |s: &TrashSummary| parse_time(&s.deleted_at);
            key(b)
                .cmp(&key(a))
                .then_with(|| b.deleted_at.cmp(&a.deleted_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(summaries)
    }

    /// Every readable entry without its rows, newest first.
    pub fn list(&self) -> AppResult<Vec<TrashSummary>> {
        let _locked = self.lock()?;
        self.summaries()
    }

    /// The whole entry. A missing one is `not_found`.
    pub fn get(&self, id: &str) -> AppResult<TrashEntry> {
        check_id(id)?;
        let _locked = self.lock()?;
        self.read_entry(id)
    }

    /// Removes one entry. A missing one is `not_found`; a `pending` one (its delete is still
    /// running) is `invalid_input`. A file that does not parse is removed.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        check_id(id)?;
        let _locked = self.lock()?;
        match self.read_summary(id) {
            Ok(summary) if summary.status == TrashStatus::Pending => {
                return Err(AppError::InvalidInput(format!(
                    "trash entry {id} belongs to a delete that is still running"
                )));
            }
            Err(err @ AppError::NotFound(_)) => return Err(err),
            _ => {}
        }
        self.remove(id)
    }

    /// Marks `id` as being restored until the claim is dropped. A second restore of the same
    /// entry meanwhile is `invalid_input`.
    pub fn claim_restore(self: &std::sync::Arc<Self>, id: &str) -> AppResult<RestoreClaim> {
        check_id(id)?;
        let mut restoring = self.restoring.lock().unwrap_or_else(|e| e.into_inner());
        if !restoring.insert(id.to_string()) {
            return Err(AppError::InvalidInput(
                "this entry is already being restored; wait for that to finish".into(),
            ));
        }
        Ok(RestoreClaim { store: std::sync::Arc::clone(self), id: id.to_string() })
    }

    /// After a restore: removes the rows at `indexes` from the entry, or the whole entry when
    /// none are left. Returns how many rows are left. `expected_rows` is the row count the
    /// restore read; if the entry changed since, nothing is touched and this is `io`.
    pub fn remove_rows(
        &self,
        id: &str,
        indexes: &[usize],
        expected_rows: usize,
    ) -> AppResult<usize> {
        check_id(id)?;
        let _locked = self.lock()?;
        let entry = self.read_entry(id)?;
        if entry.rows.len() != expected_rows {
            return Err(AppError::Io(format!(
                "trash entry {id} changed while its rows were restored; it was left as it is"
            )));
        }
        let restored: std::collections::HashSet<usize> = indexes.iter().copied().collect();
        let rows: Vec<_> = entry
            .rows
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !restored.contains(i))
            .map(|(_, row)| row)
            .collect();
        if rows.is_empty() {
            self.remove(id)?;
            return Ok(0);
        }
        let left = rows.len();
        self.write(&TrashEntry { rows, ..entry })?;
        Ok(left)
    }

    /// Removes every entry except `pending` ones (a delete still running), including files that
    /// no longer parse. Returns how many were removed.
    pub fn empty(&self) -> AppResult<usize> {
        let _locked = self.lock()?;
        let mut removed = 0;
        for id in self.ids()? {
            match self.read_summary(&id) {
                Ok(summary) if summary.status == TrashStatus::Pending => continue,
                Err(AppError::NotFound(_)) => continue,
                _ => {}
            }
            match self.remove(&id) {
                Ok(()) => removed += 1,
                Err(AppError::NotFound(_)) => {}
                Err(err) => return Err(err),
            }
        }
        Ok(removed)
    }

    /// Removes the entries deleted more than `retention_days` days before `now`, except
    /// `pending` ones. Unreadable files, and entries that cannot be removed, are logged and
    /// kept. Returns how many were removed.
    pub fn purge(&self, retention_days: u32, now: DateTime<Utc>) -> AppResult<usize> {
        let cutoff = now - Duration::days(i64::from(retention_days));
        let _locked = self.lock()?;
        let mut removed = 0;
        for summary in self.summaries()? {
            if summary.status == TrashStatus::Pending {
                continue;
            }
            let Some(deleted_at) = parse_time(&summary.deleted_at) else {
                eprintln!("keeping trash entry {}: deletedAt is not a valid time", summary.id);
                continue;
            };
            if deleted_at >= cutoff {
                continue;
            }
            match self.remove(&summary.id) {
                Ok(()) => removed += 1,
                Err(AppError::NotFound(_)) => {}
                Err(err) => eprintln!("could not purge trash entry {}: {err}", summary.id),
            }
        }
        Ok(removed)
    }

    /// At startup: an entry still `pending` belongs to a delete the app never saw finish, so it
    /// becomes `uncertain`. Leftover temp files are removed. An entry that cannot be changed is
    /// logged and skipped. Returns how many entries changed.
    pub fn recover(&self) -> AppResult<usize> {
        let _locked = self.lock()?;
        self.remove_temp_files();
        let mut changed = 0;
        for summary in self.summaries()? {
            if summary.status != TrashStatus::Pending {
                continue;
            }
            let rewritten = self.read_entry(&summary.id).and_then(|entry| {
                self.write(&TrashEntry { status: TrashStatus::Uncertain, ..entry })
            });
            match rewritten {
                Ok(()) => changed += 1,
                Err(err) => eprintln!("could not mark trash entry {} uncertain: {err}", summary.id),
            }
        }
        Ok(changed)
    }

    fn remove_temp_files(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.')
                && name.ends_with(TEMP_SUFFIX)
                && let Err(err) = fs::remove_file(entry.path())
            {
                eprintln!("could not remove trash temp file {name}: {err}");
            }
        }
    }
}

/// An entry being restored; released when dropped.
#[derive(Debug)]
pub struct RestoreClaim {
    store: std::sync::Arc<TrashStore>,
    id: String,
}

impl Drop for RestoreClaim {
    fn drop(&mut self) {
        self.store.restoring.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
    }
}

fn not_found(id: &str) -> AppError {
    AppError::NotFound(format!("trash entry {id} does not exist"))
}

/// The `backup_failed` reason for rows that take `bytes`, more than [`MAX_BACKUP_BYTES`].
pub fn too_large_reason(bytes: usize) -> String {
    format!(
        "the rows take {} MiB, more than the {} MiB one backup can hold",
        bytes.div_ceil(1024 * 1024),
        MAX_BACKUP_BYTES / (1024 * 1024)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mysql::Cell;
    use crate::trash::model::{TrashColumn, TrashSource, new_id};

    fn entry(deleted_at: &str) -> TrashEntry {
        TrashEntry {
            id: new_id(),
            status: TrashStatus::Committed,
            deleted_at: deleted_at.into(),
            connection_id: "c1".into(),
            connection_name: "Local".into(),
            database: "sample".into(),
            table: "people".into(),
            source: TrashSource::Grid,
            statement: None,
            columns: vec![
                TrashColumn { name: "id".into(), type_name: "INT".into() },
                TrashColumn { name: "name".into(), type_name: "VARCHAR".into() },
            ],
            primary_key: vec!["id".into()],
            rows: vec![
                vec![Cell::Int("1".into()), Cell::Str("O'Brien \\ 한글".into())],
                vec![Cell::Int("2".into()), Cell::Null],
            ],
        }
    }

    fn store() -> (tempfile::TempDir, TrashStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = TrashStore::new(dir.path());
        (dir, store)
    }

    fn time(text: &str) -> DateTime<Utc> {
        parse_time(text).unwrap()
    }

    #[test]
    fn begin_writes_pending_and_commit_marks_committed() {
        let (_dir, store) = store();
        let e = entry("2026-01-02T03:04:05.678Z");
        store.begin(e.clone()).unwrap();
        let pending = store.get(&e.id).unwrap();
        assert_eq!(pending.status, TrashStatus::Pending, "begin always writes pending");
        assert_eq!(pending.rows, e.rows);
        store.commit(&e.id).unwrap();
        assert_eq!(
            store.get(&e.id).unwrap(),
            TrashEntry { status: TrashStatus::Committed, ..e.clone() }
        );
        store.mark_uncertain(&e.id).unwrap();
        assert_eq!(store.get(&e.id).unwrap().status, TrashStatus::Uncertain);
    }

    #[test]
    fn discard_removes_and_tolerates_a_missing_entry() {
        let (_dir, store) = store();
        let e = entry("2026-01-02T03:04:05.678Z");
        store.begin(e.clone()).unwrap();
        store.discard(&e.id).unwrap();
        assert_eq!(store.get(&e.id).unwrap_err().kind(), "not_found");
        store.discard(&e.id).unwrap();
        assert_eq!(store.commit(&e.id).unwrap_err().kind(), "not_found", "never recreated");
        assert!(!store.path(&e.id).exists());
    }

    #[test]
    fn list_is_newest_first_without_rows_and_skips_bad_files() {
        let (_dir, store) = store();
        let old = entry("2026-01-01T00:00:00.000Z");
        let new = entry("2026-03-01T00:00:00.000Z");
        let mid = entry("2026-02-01T09:00:00.000+09:00");
        for e in [&old, &new, &mid] {
            store.begin(e.clone()).unwrap();
        }
        fs::write(store.dir().join(format!("{}.json", new_id())), "{nope").unwrap();
        fs::write(store.dir().join("notes.txt"), "x").unwrap();
        fs::write(store.dir().join("not-an-id.json"), "{}").unwrap();
        let other = entry("2026-04-01T00:00:00.000Z");
        // A file whose content names another id is skipped.
        fs::write(
            store.dir().join(format!("{}.json", new_id())),
            serde_json::to_vec(&other).unwrap(),
        )
        .unwrap();
        let list = store.list().unwrap();
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, [new.id.as_str(), mid.id.as_str(), old.id.as_str()]);
        assert_eq!(list[0].row_count, 2);
        assert_eq!(list[0].columns, new.columns);
        let json = serde_json::to_value(&list[0]).unwrap();
        assert!(json.get("rows").is_none());
        assert_eq!(json["rowCount"], 2);
    }

    #[test]
    fn missing_directory_lists_nothing() {
        let (_dir, store) = store();
        assert!(store.list().unwrap().is_empty());
        assert_eq!(store.purge(30, Utc::now()).unwrap(), 0);
        assert_eq!(store.recover().unwrap(), 0);
        assert_eq!(store.empty().unwrap(), 0);
    }

    #[test]
    fn purge_removes_only_expired_finished_entries() {
        let (_dir, store) = store();
        let expired = entry("2026-01-01T00:00:00.000Z");
        let kept = entry("2026-01-25T00:00:00.000Z");
        let expired_uncertain =
            TrashEntry { status: TrashStatus::Uncertain, ..entry("2025-12-01T00:00:00.000Z") };
        let pending = entry("2025-01-01T00:00:00.000Z");
        let bad_time = entry("yesterday");
        for e in [&expired, &kept, &expired_uncertain, &bad_time] {
            store.begin(e.clone()).unwrap();
            store.write(e).unwrap();
        }
        store.begin(pending.clone()).unwrap();
        let removed = store.purge(30, time("2026-02-15T00:00:00.000Z")).unwrap();
        assert_eq!(removed, 2);
        let left: Vec<String> = store.list().unwrap().into_iter().map(|s| s.id).collect();
        assert!(
            left.contains(&kept.id) && left.contains(&pending.id) && left.contains(&bad_time.id)
        );
        assert_eq!(left.len(), 3);
        // Exactly at the cutoff is kept.
        assert_eq!(store.purge(21, time("2026-02-15T00:00:00.000Z")).unwrap(), 0);
        assert_eq!(store.purge(20, time("2026-02-15T00:00:00.000Z")).unwrap(), 1);
    }

    #[test]
    fn recover_turns_pending_into_uncertain_and_removes_temp_files() {
        let (_dir, store) = store();
        let pending = entry("2026-01-01T00:00:00.000Z");
        let done = entry("2026-01-01T00:00:00.000Z");
        store.begin(pending.clone()).unwrap();
        store.begin(done.clone()).unwrap();
        store.commit(&done.id).unwrap();
        let temp = store.dir().join(format!(".{}.json.x.tmp", new_id()));
        fs::write(&temp, "partial").unwrap();
        assert_eq!(store.recover().unwrap(), 1);
        assert_eq!(store.get(&pending.id).unwrap().status, TrashStatus::Uncertain);
        assert_eq!(store.get(&done.id).unwrap().status, TrashStatus::Committed);
        assert!(!temp.exists());
        assert_eq!(store.recover().unwrap(), 0);
    }

    #[test]
    fn delete_and_empty() {
        let (_dir, store) = store();
        let a = entry("2026-01-01T00:00:00.000Z");
        let b = entry("2026-01-02T00:00:00.000Z");
        let running = entry("2026-01-03T00:00:00.000Z");
        store.begin(a.clone()).unwrap();
        store.commit(&a.id).unwrap();
        store.begin(b.clone()).unwrap();
        store.mark_uncertain(&b.id).unwrap();
        store.begin(running.clone()).unwrap();
        assert_eq!(store.delete(&running.id).unwrap_err().kind(), "invalid_input");
        store.delete(&a.id).unwrap();
        assert_eq!(store.delete(&a.id).unwrap_err().kind(), "not_found");
        let corrupt = store.dir().join(format!("{}.json", new_id()));
        fs::write(&corrupt, "{nope").unwrap();
        assert_eq!(store.empty().unwrap(), 2, "the uncertain entry and the corrupt file");
        assert!(!corrupt.exists());
        let left: Vec<String> = store.list().unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(left, [running.id], "a running delete keeps its backup");
    }

    #[test]
    fn an_entry_is_restored_once_at_a_time() {
        let (_dir, store) = store();
        let store = std::sync::Arc::new(store);
        let id = new_id();
        let claim = store.claim_restore(&id).unwrap();
        assert_eq!(store.claim_restore(&id).unwrap_err().kind(), "invalid_input");
        assert!(store.claim_restore(&new_id()).is_ok(), "other entries are free");
        drop(claim);
        assert!(store.claim_restore(&id).is_ok());
        assert_eq!(store.claim_restore("../x").unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn restored_rows_leave_the_entry() {
        let (_dir, store) = store();
        let e = TrashEntry {
            rows: vec![
                vec![Cell::Int("1".into()), Cell::Null],
                vec![Cell::Int("2".into()), Cell::Null],
                vec![Cell::Int("3".into()), Cell::Null],
            ],
            ..entry("2026-01-01T00:00:00.000Z")
        };
        store.begin(e.clone()).unwrap();
        store.commit(&e.id).unwrap();
        assert_eq!(store.remove_rows(&e.id, &[0, 2], 2).unwrap_err().kind(), "io", "changed");
        assert_eq!(store.remove_rows(&e.id, &[0, 2], 3).unwrap(), 1);
        let left = store.get(&e.id).unwrap();
        assert_eq!(left.rows, [vec![Cell::Int("2".into()), Cell::Null]]);
        assert_eq!(left.status, TrashStatus::Committed);
        assert_eq!(store.remove_rows(&e.id, &[0], 1).unwrap(), 0);
        assert_eq!(store.get(&e.id).unwrap_err().kind(), "not_found");
    }

    #[test]
    fn errors_never_quote_file_content() {
        let (_dir, store) = store();
        let e = entry("2026-01-01T00:00:00.000Z");
        store.begin(e.clone()).unwrap();
        let text = fs::read_to_string(store.path(&e.id)).unwrap();
        let broken = text.replace("\"status\":\"pending\"", "\"status\":\"SECRET-VALUE\"");
        fs::write(store.path(&e.id), broken).unwrap();
        let err = store.get(&e.id).unwrap_err();
        assert_eq!(err.kind(), "io");
        assert!(!err.to_string().contains("SECRET"), "{err}");
        assert!(err.to_string().contains("line 1, column"), "{err}");
    }

    #[test]
    fn a_bad_entry_does_not_stop_recover_or_purge() {
        let (_dir, store) = store();
        let a = entry("2020-01-01T00:00:00.000Z");
        let b = entry("2020-01-02T00:00:00.000Z");
        store.begin(a.clone()).unwrap();
        store.begin(b.clone()).unwrap();
        fs::write(store.dir().join(format!("{}.json", new_id())), "{nope").unwrap();
        assert_eq!(store.recover().unwrap(), 2);
        assert_eq!(store.purge(1, Utc::now()).unwrap(), 2);
        assert_eq!(store.ids().unwrap().len(), 1, "only the corrupt file is left");
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_never_followed() {
        let (dir, store) = store();
        // An entry file that is a link is skipped and cannot be read.
        let outside = dir.path().join("outside.json");
        let e = entry("2026-01-01T00:00:00.000Z");
        fs::write(&outside, serde_json::to_vec(&e).unwrap()).unwrap();
        store.begin(entry("2026-01-02T00:00:00.000Z")).unwrap();
        std::os::unix::fs::symlink(&outside, store.path(&e.id)).unwrap();
        assert_eq!(store.get(&e.id).unwrap_err().kind(), "io");
        assert_eq!(store.list().unwrap().len(), 1);
        // A trash folder that is a link is refused.
        let other = tempfile::tempdir().unwrap();
        let linked = TrashStore::new(other.path());
        std::os::unix::fs::symlink(dir.path(), linked.dir()).unwrap();
        assert_eq!(linked.list().unwrap_err().kind(), "io");
        let err = linked.begin(entry("2026-01-01T00:00:00.000Z")).unwrap_err();
        assert_eq!(err.kind(), "backup_failed");
        assert!(err.to_string().contains("symbolic link"), "{err}");
    }

    #[test]
    fn stores_on_the_same_folder_wait_for_each_other() {
        let (dir, store) = store();
        let held = store.lock_io().unwrap();
        let path = dir.path().to_path_buf();
        let (tx, rx) = std::sync::mpsc::channel();
        let other = std::thread::spawn(move || {
            let result = TrashStore::new(&path).list().map(|l| l.len());
            tx.send(()).unwrap();
            result
        });
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(200)).is_err(),
            "another store must wait for the lock"
        );
        drop(held);
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(other.join().unwrap().unwrap(), 0);
    }

    #[test]
    fn only_one_instance_claims_the_trash() {
        let (dir, first) = store();
        let second = TrashStore::new(dir.path());
        assert!(first.claim_instance());
        assert!(first.claim_instance(), "claiming again keeps it");
        assert!(!second.claim_instance(), "another instance owns it");
        let e = entry("2026-01-01T00:00:00.000Z");
        first.begin(e.clone()).unwrap();
        assert_eq!(first.list().unwrap().len(), 1, "the instance file is not an entry");
        assert_eq!(first.empty().unwrap(), 0, "the pending entry and lock files stay");
        drop(first);
        assert!(second.claim_instance(), "free once the owner is gone");
    }

    #[test]
    fn ids_from_outside_are_validated() {
        let (dir, store) = store();
        fs::write(dir.path().join("settings.json"), "{}").unwrap();
        for bad in ["../settings", "..", "", "x/../../settings"] {
            assert_eq!(store.get(bad).unwrap_err().kind(), "invalid_input", "{bad}");
            assert_eq!(store.delete(bad).unwrap_err().kind(), "invalid_input", "{bad}");
            assert_eq!(store.discard(bad).unwrap_err().kind(), "invalid_input", "{bad}");
            assert_eq!(store.commit(bad).unwrap_err().kind(), "invalid_input", "{bad}");
        }
        let e = TrashEntry { id: "../settings".into(), ..entry("2026-01-01T00:00:00.000Z") };
        assert_eq!(store.begin(e).unwrap_err().kind(), "invalid_input");
        assert!(dir.path().join("settings.json").exists());
    }

    #[test]
    fn limits_are_backup_failed_and_write_nothing() {
        let (_dir, store) = store();
        let row = vec![Cell::Int("1".into()), Cell::Null];
        let many = TrashEntry {
            rows: vec![row; MAX_BACKUP_ROWS + 1],
            ..entry("2026-01-01T00:00:00.000Z")
        };
        let err = store.begin(many).unwrap_err();
        assert_eq!(err.kind(), "backup_failed");
        assert!(err.to_string().contains("10000"), "{err}");
        let huge = "x".repeat(MAX_BACKUP_BYTES);
        let big = TrashEntry {
            rows: vec![vec![Cell::Int("1".into()), Cell::Str(huge)]],
            ..entry("2026-01-01T00:00:00.000Z")
        };
        let err = store.begin(big).unwrap_err();
        assert_eq!(err.kind(), "backup_failed");
        assert!(err.to_string().contains("MiB"), "{err}");
        assert!(store.list().unwrap().is_empty());
        let exactly = TrashEntry {
            rows: vec![vec![Cell::Int("1".into()), Cell::Null]; MAX_BACKUP_ROWS],
            ..entry("2026-01-01T00:00:00.000Z")
        };
        store.begin(exactly).unwrap();
    }

    #[test]
    fn unwritable_directory_is_backup_failed() {
        let (_dir, store) = store();
        // A file where the folder goes: the folder cannot be created.
        fs::write(store.dir(), "not a folder").unwrap();
        let err = store.begin(entry("2026-01-01T00:00:00.000Z")).unwrap_err();
        assert_eq!(err.kind(), "backup_failed");
        assert!(err.to_string().contains("could not be saved"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn directory_and_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::set_permissions(store.dir(), fs::Permissions::from_mode(0o755)).unwrap();
        let e = entry("2026-01-01T00:00:00.000Z");
        store.begin(e.clone()).unwrap();
        store.commit(&e.id).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(store.dir()), 0o700);
        assert_eq!(mode(&store.path(&e.id)), 0o600);
    }
}
