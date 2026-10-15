//! File helpers shared by the config store and exports.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;

/// Files the app writes (configs, exports) are readable only by the owner on unix.
#[cfg(unix)]
const PRIVATE_MODE: u32 = 0o600;

/// Creates a new file that must not exist yet, with owner-only permissions on unix.
pub fn create_private(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(PRIVATE_MODE);
    }
    options.open(path)
}

/// Replaces `path` with `bytes` through a synced owner-only temp file in the same directory
/// and a rename, so readers see either the old or the new contents. Creates the directory.
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent directory")
    })?;
    fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let written = write_synced(&tmp, bytes).and_then(|()| fs::rename(&tmp, path));
    if written.is_err() {
        // Best effort cleanup; the original file is untouched either way.
        let _ = fs::remove_file(&tmp);
    }
    written
}

fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = create_private(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_to_reuse_an_existing_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x");
        create_private(&path).unwrap();
        assert_eq!(create_private(&path).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
    }

    #[cfg(unix)]
    #[test]
    fn is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x");
        create_private(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
