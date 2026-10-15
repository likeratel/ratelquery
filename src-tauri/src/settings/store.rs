//! Reads and atomically writes `<config dir>/settings.json`.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::model::{Settings, sanitize};
use crate::error::{AppError, AppResult};
use crate::fsutil::write_private_atomic;

const FILE_NAME: &str = "settings.json";
const BACKUP_NAME: &str = "settings.json.bak";

/// What the settings file held.
#[derive(Debug, Clone, PartialEq)]
pub enum Loaded {
    /// Missing (defaults) or readable.
    Valid(Settings),
    /// Not a JSON object; the reason is for the log.
    Corrupt(String),
}

#[derive(Debug, Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join(FILE_NAME) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn backup_path(&self) -> PathBuf {
        self.path.with_file_name(BACKUP_NAME)
    }

    /// Settings from the file merged over the defaults. A missing file means defaults; a file
    /// that is not a JSON object is [`Loaded::Corrupt`] (see [`SettingsStore::set_aside`]).
    /// Individual known values that are invalid for this build fall back to their defaults.
    /// A file that cannot be read at all is an `io` error.
    pub fn load(&self) -> AppResult<Loaded> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Loaded::Valid(Settings::default()));
            }
            Err(e) => return Err(AppError::Io(format!("could not read {FILE_NAME}: {e}"))),
        };
        Ok(match serde_json::from_str::<Value>(&text) {
            Ok(value) if value.is_object() => Loaded::Valid(sanitize(&value)),
            Ok(_) => Loaded::Corrupt(format!("{FILE_NAME} is not a JSON object")),
            Err(e) => Loaded::Corrupt(format!("{FILE_NAME} is not valid: {e}")),
        })
    }

    /// Moves a corrupt file to `settings.json.bak` (replacing an older backup) so the next
    /// save does not destroy what the user had.
    pub fn set_aside(&self) -> AppResult<PathBuf> {
        let backup = self.backup_path();
        fs::rename(&self.path, &backup)
            .map_err(|e| AppError::Io(format!("could not move {FILE_NAME} aside: {e}")))?;
        Ok(backup)
    }

    pub fn save(&self, settings: &Settings) -> AppResult<()> {
        let json = serde_json::to_vec_pretty(settings)
            .map_err(|e| AppError::Io(format!("could not encode settings: {e}")))?;
        write_private_atomic(&self.path, &json)
            .map_err(|e| AppError::Io(format!("could not write {FILE_NAME}: {e}")))
    }
}
