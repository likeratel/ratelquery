//! Rows removed by grid deletes (and, later, DELETE statements), kept in `<config dir>/trash/`
//! for the number of days set in Settings so they can be looked at or restored.

mod model;
mod store;

pub use model::{
    MAX_BACKUP_BYTES, MAX_BACKUP_ROWS, TrashColumn, TrashEntry, TrashSource, TrashStatus,
    TrashSummary, check_id, new_id, now_rfc3339,
};
pub use store::{RestoreClaim, TrashStore, backup_failed, too_large_reason};

/// Purges with `retention_days` now; a failure is only logged (the next purge tries again).
pub fn purge_logged(store: &TrashStore, retention_days: u32) {
    match store.purge(retention_days, chrono::Utc::now()) {
        Ok(0) => {}
        Ok(removed) => {
            eprintln!("trash: removed {removed} entries older than {retention_days} days")
        }
        Err(err) => eprintln!("trash: could not remove old entries: {err}"),
    }
}

/// At startup: when this instance owns the trash (see [`TrashStore::claim_instance`]), entries
/// left `pending` become `uncertain`; then old entries are purged. Failures
/// are logged and never stop the app.
pub fn startup(store: &TrashStore, retention_days: u32) {
    if !store.claim_instance() {
        eprintln!(
            "trash: another app instance owns the trash; unfinished deletes left as they are"
        );
    } else {
        match store.recover() {
            Ok(0) => {}
            Ok(changed) => eprintln!("trash: {changed} unfinished deletes marked uncertain"),
            Err(err) => eprintln!("trash: could not check unfinished deletes: {err}"),
        }
    }
    purge_logged(store, retention_days);
}
