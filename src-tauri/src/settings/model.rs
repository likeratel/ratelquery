//! `Settings` shape shared with the frontend, its defaults and range checks.

use std::ops::RangeInclusive;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

pub const EDITOR_FONT_SIZE_RANGE: RangeInclusive<u32> = 11..=20;
pub const DEFAULT_LIMIT_RANGE: RangeInclusive<u32> = 1..=100_000;
pub const MAX_ROWS_RANGE: RangeInclusive<u32> = 1..=100_000;
pub const DYNAMO_PAGE_SIZE_RANGE: RangeInclusive<u32> = 1..=1000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// Missing keys take their defaults; keys this build does not know are kept in `extra`
/// so saving never drops settings written by a newer build.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: Theme,
    pub editor_font_size: u32,
    pub query: QuerySettings,
    pub dynamo: DynamoSettings,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuerySettings {
    pub default_limit: u32,
    pub add_limit_to_select: bool,
    pub confirm_destructive: bool,
    pub max_rows: u32,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DynamoSettings {
    pub page_size: u32,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            editor_font_size: 13,
            query: QuerySettings::default(),
            dynamo: DynamoSettings::default(),
            extra: Map::new(),
        }
    }
}

impl Default for QuerySettings {
    fn default() -> Self {
        Self {
            default_limit: 1000,
            add_limit_to_select: true,
            confirm_destructive: true,
            max_rows: 1000,
            extra: Map::new(),
        }
    }
}

impl Default for DynamoSettings {
    fn default() -> Self {
        Self { page_size: 100, extra: Map::new() }
    }
}

fn check_range(name: &str, value: u32, range: &RangeInclusive<u32>) -> AppResult<()> {
    if range.contains(&value) {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "{name} must be between {} and {}, got {value}",
            range.start(),
            range.end()
        )))
    }
}

impl Settings {
    /// Rejects out-of-range numbers with `invalid_input`.
    pub fn validate(&self) -> AppResult<()> {
        check_range("editorFontSize", self.editor_font_size, &EDITOR_FONT_SIZE_RANGE)?;
        check_range("query.defaultLimit", self.query.default_limit, &DEFAULT_LIMIT_RANGE)?;
        check_range("query.maxRows", self.query.max_rows, &MAX_ROWS_RANGE)?;
        check_range("dynamo.pageSize", self.dynamo.page_size, &DYNAMO_PAGE_SIZE_RANGE)
    }

    /// Strict parse plus range check; type errors are `invalid_input` too.
    pub fn from_value(value: Value) -> AppResult<Self> {
        let settings: Settings = serde_json::from_value(value)?;
        settings.validate()?;
        Ok(settings)
    }
}

/// Deep merge where `overlay` wins; objects merge key by key, anything else is replaced.
pub fn merge(base: &Value, overlay: &Value) -> Value {
    match (base, overlay) {
        (Value::Object(b), Value::Object(o)) => {
            let merged = o.iter().fold(b.clone(), |acc, (key, value)| {
                let next = acc.get(key).map_or_else(|| value.clone(), |old| merge(old, value));
                let mut acc = acc;
                acc.insert(key.clone(), next);
                acc
            });
            Value::Object(merged)
        }
        _ => overlay.clone(),
    }
}

/// Applies the file's values over the defaults one key at a time, skipping any known key
/// whose value is invalid for this build (wrong type or out of range). Unknown keys are kept.
pub fn sanitize(file: &Value) -> Settings {
    let defaults = serde_json::to_value(Settings::default()).unwrap_or(Value::Null);
    let merged = merge_valid(defaults, &[], file);
    Settings::from_value(merged).unwrap_or_default()
}

/// Returns `root` with `value` placed at `path` (creating objects along the way).
fn set_at(root: &Value, path: &[String], value: &Value) -> Value {
    let Some((head, rest)) = path.split_first() else { return value.clone() };
    let mut obj = root.as_object().cloned().unwrap_or_default();
    let child = set_at(obj.get(head).unwrap_or(&Value::Null), rest, value);
    obj.insert(head.clone(), child);
    Value::Object(obj)
}

fn merge_valid(root: Value, path: &[String], file: &Value) -> Value {
    let Value::Object(file) = file else { return root };
    file.iter().fold(root, |acc, (key, value)| {
        let child_path = [path, std::slice::from_ref(key)].concat();
        let candidate = set_at(&acc, &child_path, value);
        if Settings::from_value(candidate.clone()).is_ok() {
            return candidate;
        }
        // Keep the valid parts of a nested object such as `query`.
        let existing = child_path.iter().try_fold(&acc, |v, k| v.get(k));
        match (existing, value) {
            (Some(Value::Object(_)), Value::Object(_)) => merge_valid(acc, &child_path, value),
            _ => acc,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_keys_take_defaults() {
        let s =
            Settings::from_value(json!({ "theme": "dark", "query": { "maxRows": 50 } })).unwrap();
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.editor_font_size, 13);
        assert_eq!(s.query.max_rows, 50);
        assert_eq!(s.query.default_limit, 1000);
        assert!(s.query.add_limit_to_select && s.query.confirm_destructive);
        assert_eq!(s.dynamo.page_size, 100);
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        let input =
            json!({ "future": { "a": 1 }, "query": { "later": true }, "dynamo": { "x": "y" } });
        let s = Settings::from_value(input).unwrap();
        let out = serde_json::to_value(&s).unwrap();
        assert_eq!(out["future"], json!({ "a": 1 }));
        assert_eq!(out["query"]["later"], json!(true));
        assert_eq!(out["dynamo"]["x"], json!("y"));
        assert_eq!(out["editorFontSize"], json!(13));
    }

    #[test]
    fn rejects_out_of_range_and_wrong_types() {
        for bad in [
            json!({ "editorFontSize": 10 }),
            json!({ "editorFontSize": 21 }),
            json!({ "query": { "defaultLimit": 0 } }),
            json!({ "query": { "defaultLimit": 100_001 } }),
            json!({ "query": { "maxRows": 0 } }),
            json!({ "dynamo": { "pageSize": 1001 } }),
            json!({ "dynamo": { "pageSize": -1 } }),
            json!({ "theme": "neon" }),
            json!({ "editorFontSize": 12.5 }),
        ] {
            let err = Settings::from_value(bad.clone()).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{bad}");
        }
        assert!(
            Settings::from_value(json!({ "editorFontSize": 11, "dynamo": { "pageSize": 1000 } }))
                .is_ok()
        );
    }

    #[test]
    fn sanitize_drops_only_invalid_known_values() {
        let file = json!({
            "theme": "neon",
            "editorFontSize": 15,
            "query": { "defaultLimit": 0, "maxRows": 200, "later": 1 },
            "future": "kept"
        });
        let s = sanitize(&file);
        assert_eq!(s.theme, Theme::System);
        assert_eq!(s.editor_font_size, 15);
        assert_eq!(s.query.default_limit, 1000);
        assert_eq!(s.query.max_rows, 200);
        assert_eq!(s.query.extra.get("later"), Some(&json!(1)));
        assert_eq!(s.extra.get("future"), Some(&json!("kept")));
    }

    #[test]
    fn merge_overlays_nested_objects() {
        let merged =
            merge(&json!({ "a": { "b": 1, "c": 2 }, "d": 3 }), &json!({ "a": { "b": 9 } }));
        assert_eq!(merged, json!({ "a": { "b": 9, "c": 2 }, "d": 3 }));
    }
}
