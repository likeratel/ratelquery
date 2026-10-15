//! Reads and atomically writes `<config dir>/settings.json`.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::model::{Settings, sanitize};
use crate::error::{AppError, AppResult};
use crate::fsutil::write_private_atomic;

const FILE_NAME: &str = "settings.json";

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

    /// Settings from the file merged over the defaults. A missing file means defaults; a file
    /// that is not a JSON object is an error so a later save never overwrites it silently.
    /// Individual known values that are invalid for this build fall back to their defaults.
    pub fn load(&self) -> AppResult<Settings> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Settings::default()),
            Err(e) => return Err(AppError::Io(format!("could not read {FILE_NAME}: {e}"))),
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| AppError::Io(format!("{FILE_NAME} is not valid: {e}")))?;
        if !value.is_object() {
            return Err(AppError::Io(format!("{FILE_NAME} is not a JSON object")));
        }
        Ok(sanitize(&value))
    }

    pub fn save(&self, settings: &Settings) -> AppResult<()> {
        let json = serde_json::to_vec_pretty(settings)
            .map_err(|e| AppError::Io(format!("could not encode settings: {e}")))?;
        write_private_atomic(&self.path, &json)
            .map_err(|e| AppError::Io(format!("could not write {FILE_NAME}: {e}")))
    }
}
