use std::fs::{self, File};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Checks that `path` is an absolute file path inside an existing directory.
pub fn validate_target(path: &str) -> AppResult<PathBuf> {
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err(AppError::InvalidInput(format!("export path must be absolute: {path}")));
    }
    if target.file_name().is_none() || target.is_dir() {
        return Err(AppError::InvalidInput(format!("export path is not a file: {path}")));
    }
    match target.parent() {
        Some(parent) if parent.is_dir() => Ok(target),
        _ => Err(AppError::InvalidInput(format!("export directory does not exist: {path}"))),
    }
}

/// Writes to a temp file next to the target and renames it into place on commit, so a failed
/// export never leaves a truncated file behind. Dropping without commit removes the temp file.
pub struct AtomicFile {
    tmp: PathBuf,
    target: PathBuf,
    committed: bool,
}

impl AtomicFile {
    pub fn create(target: &Path) -> AppResult<(AtomicFile, File)> {
        let parent = target
            .parent()
            .ok_or_else(|| AppError::InvalidInput("export path has no directory".into()))?;
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
        let file = File::create(&tmp)
            .map_err(|e| AppError::Io(format!("could not create {}: {e}", tmp.display())))?;
        Ok((AtomicFile { tmp, target: target.to_path_buf(), committed: false }, file))
    }

    pub fn commit(mut self, file: File) -> AppResult<()> {
        file.sync_all()?;
        drop(file);
        fs::rename(&self.tmp, &self.target)
            .map_err(|e| AppError::Io(format!("could not write {}: {e}", self.target.display())))?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for AtomicFile {
    fn drop(&mut self) {
        if !self.committed {
            // Best effort cleanup of an abandoned export.
            let _ = fs::remove_file(&self.tmp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn validates_paths() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("out.csv");
        assert!(validate_target(ok.to_str().unwrap()).is_ok());
        assert_eq!(validate_target("relative.csv").unwrap_err().kind(), "invalid_input");
        assert_eq!(
            validate_target(dir.path().to_str().unwrap()).unwrap_err().kind(),
            "invalid_input"
        );
        let missing = dir.path().join("nope").join("x.csv");
        assert_eq!(validate_target(missing.to_str().unwrap()).unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn commit_renames_and_drop_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.txt");
        let (atomic, mut file) = AtomicFile::create(&target).unwrap();
        file.write_all(b"hi").unwrap();
        atomic.commit(file).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hi");

        let other = dir.path().join("b.txt");
        let (atomic, file) = AtomicFile::create(&other).unwrap();
        drop(file);
        drop(atomic);
        assert!(!other.exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
