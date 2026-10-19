//! One-time copy of the config written while the app was called dbclient.
//!
//! The app config dir is named after the bundle identifier, so renaming the identifier from
//! `dev.harry.dbclient` to `dev.harry.ratelquery` leaves the saved connections in a sibling
//! folder. On the first start without a `connections.json`, the files are copied (never moved)
//! from that folder so the old one stays as a backup.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::fsutil;

/// Directory name of the app config dir under the previous bundle identifier.
const LEGACY_DIR_NAME: &str = "dev.harry.dbclient";

/// Its presence in the new config dir means the app already ran under the new identifier.
const CONNECTIONS_FILE: &str = "connections.json";

/// Copied in this order. `connections.json` comes last so that a failed copy of any other file
/// is retried on the next start, until the connections have been copied.
const COPIED_FILES: [&str; 4] = ["settings.json", "secrets.json", "known_hosts", CONNECTIONS_FILE];

/// What a copy did, for logging. Files missing from the legacy dir are skipped silently.
#[derive(Debug, Default)]
pub struct CopyReport {
    pub copied: Vec<&'static str>,
    pub failed: Vec<(&'static str, io::Error)>,
}

/// The legacy config dir next to `config_dir`, if `config_dir` has a parent.
pub fn legacy_dir(config_dir: &Path) -> Option<PathBuf> {
    config_dir.parent().map(|parent| parent.join(LEGACY_DIR_NAME))
}

/// Copies the legacy config files into `config_dir` when `config_dir` has no
/// `connections.json` yet and `legacy` is a directory. Returns `None` when there is nothing to
/// migrate. Existing files in `config_dir` are never overwritten, and copies are owner-only.
pub fn copy_legacy_config(legacy: &Path, config_dir: &Path) -> Option<CopyReport> {
    if config_dir.join(CONNECTIONS_FILE).exists() || !legacy.is_dir() || legacy == config_dir {
        return None;
    }
    let (copied, failed) = COPIED_FILES
        .into_iter()
        .map(|name| (name, copy_file(&legacy.join(name), &config_dir.join(name))))
        .fold((Vec::new(), Vec::new()), |(copied, failed), (name, result)| match result {
            Ok(true) => ([copied, vec![name]].concat(), failed),
            Ok(false) => (copied, failed),
            Err(err) => (copied, failed.into_iter().chain([(name, err)]).collect()),
        });
    Some(CopyReport { copied, failed })
}

/// Copies one file with owner-only permissions. `Ok(false)` when the source does not exist or
/// the target already does.
fn copy_file(from: &Path, to: &Path) -> io::Result<bool> {
    if to.exists() {
        return Ok(false);
    }
    let bytes = match fs::read(from) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    fsutil::write_private_atomic(to, &bytes)?;
    Ok(true)
}

/// Runs the copy for the app's config dir and logs the outcome to stderr. Never fails: a
/// failed copy leaves the app starting with whatever the new dir holds.
pub fn migrate(config_dir: &Path) {
    let Some(legacy) = legacy_dir(config_dir) else { return };
    let Some(report) = copy_legacy_config(&legacy, config_dir) else { return };
    if !report.copied.is_empty() {
        eprintln!(
            "copied {} from {} to {}",
            report.copied.join(", "),
            legacy.display(),
            config_dir.display()
        );
    }
    for (name, err) in &report.failed {
        eprintln!("could not copy {name} from {}: {err}", legacy.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dirs {
        _root: tempfile::TempDir,
        legacy: PathBuf,
        current: PathBuf,
    }

    fn dirs() -> Dirs {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join(LEGACY_DIR_NAME);
        let current = root.path().join("dev.harry.ratelquery");
        fs::create_dir(&legacy).unwrap();
        Dirs { _root: root, legacy, current }
    }

    fn write(dir: &Path, name: &str, contents: &str) {
        fs::write(dir.join(name), contents).unwrap();
    }

    fn read(dir: &Path, name: &str) -> String {
        fs::read_to_string(dir.join(name)).unwrap()
    }

    #[test]
    fn legacy_dir_is_a_sibling() {
        let dir = Path::new("/a/b/dev.harry.ratelquery");
        assert_eq!(legacy_dir(dir).unwrap(), Path::new("/a/b/dev.harry.dbclient"));
    }

    #[test]
    fn copies_every_file_and_keeps_the_originals() {
        let d = dirs();
        for name in COPIED_FILES {
            write(&d.legacy, name, name);
        }
        write(&d.legacy, "unrelated.txt", "x");

        let report = copy_legacy_config(&d.legacy, &d.current).unwrap();

        assert_eq!(report.copied, COPIED_FILES);
        assert!(report.failed.is_empty());
        for name in COPIED_FILES {
            assert_eq!(read(&d.current, name), name);
            assert_eq!(read(&d.legacy, name), name);
        }
        assert!(!d.current.join("unrelated.txt").exists());
    }

    #[test]
    fn skips_files_the_legacy_dir_does_not_have() {
        let d = dirs();
        write(&d.legacy, CONNECTIONS_FILE, "[]");

        let report = copy_legacy_config(&d.legacy, &d.current).unwrap();

        assert_eq!(report.copied, [CONNECTIONS_FILE]);
        assert!(!d.current.join("secrets.json").exists());
    }

    #[test]
    fn does_nothing_once_connections_exist() {
        let d = dirs();
        write(&d.legacy, CONNECTIONS_FILE, "old");
        write(&d.legacy, "settings.json", "old");
        fs::create_dir(&d.current).unwrap();
        write(&d.current, CONNECTIONS_FILE, "new");

        assert!(copy_legacy_config(&d.legacy, &d.current).is_none());
        assert_eq!(read(&d.current, CONNECTIONS_FILE), "new");
        assert!(!d.current.join("settings.json").exists());
    }

    #[test]
    fn does_nothing_without_a_legacy_dir() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("dev.harry.ratelquery");
        let missing = root.path().join(LEGACY_DIR_NAME);

        assert!(copy_legacy_config(&missing, &current).is_none());
        assert!(!current.exists());
    }

    #[test]
    fn never_overwrites_a_file_in_the_new_dir() {
        let d = dirs();
        write(&d.legacy, CONNECTIONS_FILE, "[]");
        write(&d.legacy, "settings.json", "old");
        fs::create_dir(&d.current).unwrap();
        write(&d.current, "settings.json", "new");

        let report = copy_legacy_config(&d.legacy, &d.current).unwrap();

        assert_eq!(report.copied, [CONNECTIONS_FILE]);
        assert_eq!(read(&d.current, "settings.json"), "new");
    }

    #[test]
    fn reports_a_failed_copy_and_continues() {
        let d = dirs();
        // A directory where a file is expected cannot be read as one.
        fs::create_dir(d.legacy.join("secrets.json")).unwrap();
        write(&d.legacy, CONNECTIONS_FILE, "[]");

        let report = copy_legacy_config(&d.legacy, &d.current).unwrap();

        assert_eq!(report.copied, [CONNECTIONS_FILE]);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].0, "secrets.json");
    }

    #[cfg(unix)]
    #[test]
    fn copies_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let d = dirs();
        write(&d.legacy, "secrets.json", "{}");
        fs::set_permissions(d.legacy.join("secrets.json"), fs::Permissions::from_mode(0o644))
            .unwrap();
        write(&d.legacy, CONNECTIONS_FILE, "[]");

        copy_legacy_config(&d.legacy, &d.current).unwrap();

        for name in ["secrets.json", CONNECTIONS_FILE] {
            let mode = fs::metadata(d.current.join(name)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
