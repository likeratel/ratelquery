//! Reads and atomically writes `<config dir>/connection-layout.json`: the sidebar order of the
//! saved connections and the (nested) folders they are grouped in. The frontend owns the shape
//! and validates what it reads, converting a version 1 file; the backend only checks that it is
//! an object of a known version and bounded size, so a broken file can never grow without limit
//! or be mistaken for another format.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::fsutil::write_private_atomic;

const FILE_NAME: &str = "connection-layout.json";

/// The format this build writes: folders hold connections and other folders.
pub const LAYOUT_VERSION: u64 = 2;

/// The formats this build reads. Version 1 had folders one level deep.
const READABLE_VERSIONS: [u64; 2] = [1, LAYOUT_VERSION];

/// Upper bound of the encoded layout; thousands of connections and folders fit easily.
pub const MAX_LAYOUT_BYTES: usize = 1024 * 1024;

/// Deepest `{`/`[` nesting `load` will parse. serde_json's own recursion limit is 128, and each
/// folder level costs two of these (the item's object, then its `children` array), so a
/// hand-edited file nested past roughly 60 folders already failed to parse under that limit and
/// was silently ignored instead of being flattened at `connectionLayout.MAX_FOLDER_DEPTH` as
/// `docs/ipc-contract.md` promises. This bound allows roughly 250 folder levels -- eight times
/// that frontend limit. Parsing below bypasses serde_json's own limit (see `load`), so this bound
/// is what protects the stack: at 512 levels a parse takes about 190 KiB in a release build and
/// about 1 MiB in a debug build, against the 2 MiB stack of the blocking thread `load` runs on.
const MAX_PARSE_DEPTH: usize = 512;

/// Whether every `{`/`[` in `text` nests no deeper than `limit`, checked with a counter instead
/// of recursion so measuring a hostile file (up to `MAX_LAYOUT_BYTES`) can never itself exhaust
/// the stack. Quoted strings are skipped so a brace or bracket in a folder name or connection id
/// is not mistaken for structure. Not a full JSON validator -- serde_json still does that.
fn nests_no_deeper_than(text: &str, limit: usize) -> bool {
    let mut depth: usize = 0;
    let mut in_string = false;
    let mut escaped = false;
    for byte in text.bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > limit {
                    return false;
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    true
}

#[derive(Debug, Clone)]
pub struct ConnectionLayoutStore {
    path: PathBuf,
}

/// `Err` with the reason when `value` is not a layout object of one of `versions`.
fn check(value: &Value, versions: &[u64]) -> Result<(), String> {
    let obj = value.as_object().ok_or("not a JSON object")?;
    let version = obj.get("version").and_then(Value::as_u64);
    if !version.is_some_and(|v| versions.contains(&v)) {
        let known: Vec<String> = versions.iter().map(u64::to_string).collect();
        return Err(format!("version is not {}", known.join(" or ")));
    }
    Ok(())
}

impl ConnectionLayoutStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join(FILE_NAME) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The saved layout, version 1 or 2. A missing file is `None`; so is a corrupt, oversized
    /// or unknown-version one, after logging why (the file is left as is until the next save
    /// replaces it). A file that exists but cannot be read is an `io` error.
    pub fn load(&self) -> AppResult<Option<Value>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::Io(format!("could not read {FILE_NAME}: {e}"))),
        };
        let parsed = if text.len() > MAX_LAYOUT_BYTES {
            Err(format!("larger than {MAX_LAYOUT_BYTES} bytes"))
        } else if !nests_no_deeper_than(&text, MAX_PARSE_DEPTH) {
            Err(format!("nested deeper than {MAX_PARSE_DEPTH} levels"))
        } else {
            // `nests_no_deeper_than` already bounded the real nesting above, so disabling
            // serde_json's own (lower) recursion limit here -- which the "unbounded_depth"
            // feature requires -- cannot let a hostile file overflow the stack.
            let mut deserializer = serde_json::Deserializer::from_str(&text);
            deserializer.disable_recursion_limit();
            Value::deserialize(&mut deserializer)
                .and_then(|value| deserializer.end().map(|()| value))
                .map_err(|e| e.to_string())
                .and_then(|value| check(&value, &READABLE_VERSIONS).map(|()| value))
        };
        match parsed {
            Ok(layout) => Ok(Some(layout)),
            Err(reason) => {
                eprintln!("{FILE_NAME} is not valid ({reason}); using the default order");
                Ok(None)
            }
        }
    }

    /// Checks `input` (`invalid_input` when it is not a `LAYOUT_VERSION` object or too large,
    /// nothing written) and replaces the file.
    pub fn save(&self, input: Value) -> AppResult<()> {
        check(&input, &[LAYOUT_VERSION])
            .map_err(|reason| AppError::InvalidInput(format!("layout is {reason}")))?;
        let json = serde_json::to_vec_pretty(&input)
            .map_err(|e| AppError::Io(format!("could not encode the layout: {e}")))?;
        if json.len() > MAX_LAYOUT_BYTES {
            return Err(AppError::InvalidInput(format!(
                "layout is larger than {MAX_LAYOUT_BYTES} bytes"
            )));
        }
        write_private_atomic(&self.path, &json)
            .map_err(|e| AppError::Io(format!("could not write {FILE_NAME}: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "version": 2,
            "folders": [
                { "id": "f1", "name": "Prod 한글", "collapsed": true },
                { "id": "f2", "name": "mysql", "collapsed": false }
            ],
            "items": [
                { "type": "folder", "id": "f1", "children": [
                    { "type": "folder", "id": "f2", "children": [
                        { "type": "connection", "id": "c2" }
                    ] }
                ] },
                { "type": "connection", "id": "c1" }
            ]
        })
    }

    fn version_1() -> Value {
        json!({
            "version": 1,
            "folders": [{ "id": "f1", "name": "Prod", "collapsed": false }],
            "items": [
                { "type": "folder", "id": "f1", "children": ["c2"] },
                { "type": "connection", "id": "c1" }
            ]
        })
    }

    #[test]
    fn missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(ConnectionLayoutStore::new(dir.path()).load().unwrap(), None);
    }

    #[test]
    fn round_trips_through_a_new_store() {
        let dir = tempfile::tempdir().unwrap();
        ConnectionLayoutStore::new(dir.path()).save(sample()).unwrap();
        assert_eq!(ConnectionLayoutStore::new(dir.path()).load().unwrap(), Some(sample()));
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["connection-layout.json"]);
    }

    #[test]
    fn loads_version_1_and_version_2_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionLayoutStore::new(dir.path());
        for layout in [version_1(), sample()] {
            std::fs::write(store.path(), serde_json::to_vec(&layout).unwrap()).unwrap();
            assert_eq!(store.load().unwrap(), Some(layout));
        }
    }

    /// A folder nested `depth` levels deep around a single connection, built bottom-up with a
    /// loop (not recursion) so the test itself never risks the stack it is exercising.
    fn nested_folders(depth: u32) -> Value {
        let mut folders = Vec::new();
        let mut children = vec![json!({ "type": "connection", "id": "c1" })];
        for i in (0..depth).rev() {
            let id = format!("f{i}");
            folders.push(
                json!({ "id": id.clone(), "name": format!("folder {i}"), "collapsed": false }),
            );
            children = vec![json!({ "type": "folder", "id": id, "children": children })];
        }
        json!({ "version": 2, "folders": folders, "items": children })
    }

    #[test]
    fn depth_scan_skips_brackets_and_escapes_inside_strings() {
        let opens = "[".repeat(10);
        // Closers inside a string must not hide real nesting.
        assert!(!nests_no_deeper_than(&format!(r#"["]]]]]]]]]]",{opens}"#), 10));
        // Openers inside a string must not count as nesting.
        assert!(nests_no_deeper_than(r#"[{"name":"{[{[{[{["}]"#, 2));
        // An escaped quote doesn't end the string, so the brackets after it are still text.
        assert!(nests_no_deeper_than(r#"["a\"[[[[","b"]"#, 1));
        // An escaped backslash does end the string before the quote, so later brackets count.
        assert!(!nests_no_deeper_than(r#"["a\\",[[["#, 3));
        assert!(nests_no_deeper_than(r#"["a\\",[[["#, 4));
    }

    #[test]
    fn depth_scan_limit_is_exact() {
        let at = format!("{}{}", "[".repeat(MAX_PARSE_DEPTH), "]".repeat(MAX_PARSE_DEPTH));
        let past = format!("[{at}]");
        assert!(nests_no_deeper_than(&at, MAX_PARSE_DEPTH));
        assert!(!nests_no_deeper_than(&past, MAX_PARSE_DEPTH));
    }

    #[test]
    fn loads_a_layout_nested_past_serde_jsons_default_recursion_limit() {
        // 100 folders cost 200 levels of `{`/`[` nesting -- well past serde_json's default
        // limit of 128 -- and a hand-edited file at this depth must still load so the frontend
        // can flatten it, rather than be silently ignored as if it were corrupt.
        let layout = nested_folders(100);
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionLayoutStore::new(dir.path());
        std::fs::write(store.path(), serde_json::to_vec(&layout).unwrap()).unwrap();
        assert_eq!(store.load().unwrap(), Some(layout));
    }

    #[test]
    fn nesting_past_the_safe_parse_depth_is_none_and_kept() {
        // Built as raw text with a loop, never as a real `Value` tree, so that measuring and
        // rejecting a file this deep -- the same way a corrupt or oversized one is rejected --
        // can never itself risk the stack the limit exists to protect.
        let depth = MAX_PARSE_DEPTH + 100;
        let mut text = String::from(r#"{"version":2,"folders":[],"items":["#);
        for _ in 0..depth {
            text.push_str(r#"{"type":"folder","id":"f","children":["#);
        }
        text.push_str(r#"{"type":"connection","id":"c1"}"#);
        for _ in 0..depth {
            text.push_str("]}");
        }
        text.push_str("]}");

        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionLayoutStore::new(dir.path());
        std::fs::write(store.path(), &text).unwrap();
        assert_eq!(store.load().unwrap(), None);
        assert_eq!(std::fs::read_to_string(store.path()).unwrap(), text);
    }

    #[test]
    fn corrupt_or_oversized_file_is_none_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionLayoutStore::new(dir.path());
        let huge = format!(r#"{{"version":1,"pad":"{}"}}"#, "x".repeat(MAX_LAYOUT_BYTES));
        for bad in ["{nope", "[]", r#"{"version":3,"items":[]}"#, huge.as_str()] {
            std::fs::write(store.path(), bad).unwrap();
            assert_eq!(store.load().unwrap(), None);
            assert_eq!(std::fs::read_to_string(store.path()).unwrap(), bad);
        }
    }

    #[test]
    fn invalid_input_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionLayoutStore::new(dir.path());
        let huge = json!({ "version": 2, "pad": "x".repeat(MAX_LAYOUT_BYTES) });
        for bad in [
            json!("x"),
            json!([]),
            json!({ "version": 3 }),
            json!({ "items": [] }),
            version_1(),
            huge,
        ] {
            assert_eq!(store.save(bad).unwrap_err().kind(), "invalid_input");
        }
        assert!(!store.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn layout_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionLayoutStore::new(dir.path());
        store.save(sample()).unwrap();
        let mode = std::fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
