//! File helpers shared by the config store and exports.

use std::fs::{File, OpenOptions};
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
