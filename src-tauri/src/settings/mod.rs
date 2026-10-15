//! App settings persisted as `settings.json` and cached in memory.

mod model;
mod store;

use std::sync::Mutex;

use serde_json::Value;

pub use model::{
    DEFAULT_LIMIT_RANGE, DYNAMO_PAGE_SIZE_RANGE, DynamoSettings, EDITOR_FONT_SIZE_RANGE,
    MAX_ROWS_RANGE, QuerySettings, Settings, Theme,
};
pub use store::SettingsStore;

use crate::error::{AppError, AppResult};

/// `settings_get` / `settings_set` over a store, with the last loaded or saved value cached.
pub struct SettingsService {
    store: SettingsStore,
    cache: Mutex<Option<Settings>>,
}

impl SettingsService {
    pub fn new(store: SettingsStore) -> Self {
        Self { store, cache: Mutex::new(None) }
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Option<Settings>>> {
        self.cache.lock().map_err(|_| AppError::Io("settings cache is unavailable".into()))
    }

    fn current(&self, cache: &Option<Settings>) -> AppResult<Settings> {
        match cache {
            Some(settings) => Ok(settings.clone()),
            None => self.store.load(),
        }
    }

    pub fn get(&self) -> AppResult<Settings> {
        let mut cache = self.lock()?;
        let settings = self.current(&cache)?;
        *cache = Some(settings.clone());
        Ok(settings)
    }

    /// Validates `input` (type or range errors are `invalid_input`) and saves it. It is merged
    /// over the current settings, so keys the caller does not know about are kept.
    pub fn set(&self, input: &Value) -> AppResult<Settings> {
        if !input.is_object() {
            return Err(AppError::InvalidInput("settings must be an object".into()));
        }
        let mut cache = self.lock()?;
        let current = serde_json::to_value(self.current(&cache)?)
            .map_err(|e| AppError::Io(format!("could not encode settings: {e}")))?;
        let next = Settings::from_value(model::merge(&current, input))?;
        self.store.save(&next)?;
        *cache = Some(next.clone());
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn service(dir: &std::path::Path) -> SettingsService {
        SettingsService::new(SettingsStore::new(dir))
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(service(dir.path()).get().unwrap(), Settings::default());
    }

    #[test]
    fn file_values_merge_over_defaults_and_keep_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"theme":"light","query":{"maxRows":5,"x":1},"future":[1]}"#)
            .unwrap();
        let s = service(dir.path()).get().unwrap();
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.query.max_rows, 5);
        assert_eq!(s.query.default_limit, 1000);

        // Saving without the unknown keys keeps them on disk.
        let svc = service(dir.path());
        let saved = svc.set(&json!({ "editorFontSize": 16 })).unwrap();
        assert_eq!(saved.editor_font_size, 16);
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["future"], json!([1]));
        assert_eq!(on_disk["query"]["x"], json!(1));
        assert_eq!(on_disk["theme"], json!("light"));
    }

    #[test]
    fn round_trips_through_a_new_service() {
        let dir = tempfile::tempdir().unwrap();
        let wanted = Settings {
            theme: Theme::Dark,
            query: QuerySettings { add_limit_to_select: false, ..QuerySettings::default() },
            dynamo: DynamoSettings { page_size: 250, ..DynamoSettings::default() },
            ..Settings::default()
        };
        let saved = service(dir.path()).set(&serde_json::to_value(&wanted).unwrap()).unwrap();
        assert_eq!(saved, wanted);
        assert_eq!(service(dir.path()).get().unwrap(), wanted);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["settings.json"]);
    }

    #[test]
    fn out_of_range_is_rejected_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let err = svc.set(&json!({ "dynamo": { "pageSize": 0 } })).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert_eq!(svc.set(&json!("x")).unwrap_err().kind(), "invalid_input");
        assert!(!dir.path().join("settings.json").exists());
        assert_eq!(svc.get().unwrap(), Settings::default());
    }

    #[test]
    fn corrupt_file_is_an_io_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "{nope").unwrap();
        assert_eq!(service(dir.path()).get().unwrap_err().kind(), "io");
        std::fs::write(dir.path().join("settings.json"), "[]").unwrap();
        assert_eq!(service(dir.path()).set(&json!({})).unwrap_err().kind(), "io");
    }

    #[cfg(unix)]
    #[test]
    fn settings_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        svc.set(&json!({})).unwrap();
        svc.set(&json!({ "theme": "dark" })).unwrap();
        let mode =
            std::fs::metadata(dir.path().join("settings.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
