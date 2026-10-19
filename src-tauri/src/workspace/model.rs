//! `Workspace` shape shared with the frontend: the query tabs that were open, so they can be
//! reopened on the next launch.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// The only format this build reads and writes.
pub const WORKSPACE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabEngine {
    Mysql,
    Athena,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabKind {
    Query,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceTab {
    pub id: String,
    pub kind: TabKind,
    pub connection_id: String,
    pub engine: TabEngine,
    pub title: String,
    pub sql: String,
    pub database: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub version: u32,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<WorkspaceTab>,
}

impl Workspace {
    /// Strict parse for `workspace_save`: any type error, another version, an empty or repeated
    /// tab id, or an active id that names no tab is `invalid_input`.
    pub fn from_value(value: Value) -> AppResult<Self> {
        let workspace: Workspace = serde_json::from_value(value)?;
        if workspace.version != WORKSPACE_VERSION {
            return Err(AppError::InvalidInput(format!(
                "workspace version must be {WORKSPACE_VERSION}, got {}",
                workspace.version
            )));
        }
        let mut seen = HashSet::new();
        for tab in &workspace.tabs {
            if tab.id.is_empty() || tab.connection_id.is_empty() {
                return Err(AppError::InvalidInput("workspace tab ids must not be empty".into()));
            }
            if !seen.insert(tab.id.as_str()) {
                return Err(AppError::InvalidInput(format!("duplicate workspace tab {}", tab.id)));
            }
        }
        if let Some(active) = &workspace.active_tab_id
            && !seen.contains(active.as_str())
        {
            return Err(AppError::InvalidInput(format!("active tab {active} is not a tab")));
        }
        Ok(workspace)
    }

    /// Lenient read of the file: `Err` with the reason when it is not a version 1 workspace
    /// object; otherwise tabs that don't parse (or repeat an id) are dropped, and an active id
    /// that no longer names a tab becomes `None`.
    pub fn from_file_value(value: &Value) -> Result<Self, String> {
        let obj = value.as_object().ok_or("not a JSON object")?;
        let version = obj.get("version").and_then(Value::as_u64);
        if version != Some(u64::from(WORKSPACE_VERSION)) {
            return Err(format!("version is not {WORKSPACE_VERSION}"));
        }
        let raw_tabs = obj.get("tabs").and_then(Value::as_array).ok_or("tabs is not an array")?;
        let tabs =
            raw_tabs.iter().fold(
                Vec::<WorkspaceTab>::new(),
                |acc, raw| match serde_json::from_value::<WorkspaceTab>(raw.clone()) {
                    Ok(tab)
                        if !tab.id.is_empty()
                            && !tab.connection_id.is_empty()
                            && acc.iter().all(|t| t.id != tab.id) =>
                    {
                        [acc, vec![tab]].concat()
                    }
                    _ => acc,
                },
            );
        let active_tab_id = obj
            .get("activeTabId")
            .and_then(Value::as_str)
            .filter(|id| tabs.iter().any(|t| t.id == *id))
            .map(str::to_owned);
        Ok(Workspace { version: WORKSPACE_VERSION, active_tab_id, tabs })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tab(id: &str) -> Value {
        json!({
            "id": id, "kind": "query", "connectionId": "c1", "engine": "mysql",
            "title": "Query 1", "sql": "select 1", "database": null
        })
    }

    #[test]
    fn strict_parse_accepts_a_valid_workspace() {
        let ws = Workspace::from_value(json!({
            "version": 1, "activeTabId": "t1", "tabs": [tab("t1"), tab("t2")]
        }))
        .unwrap();
        assert_eq!(ws.tabs.len(), 2);
        assert_eq!(ws.active_tab_id.as_deref(), Some("t1"));
        assert_eq!(ws.tabs[0].engine, TabEngine::Mysql);
    }

    #[test]
    fn strict_parse_rejects_bad_input() {
        let mut unknown_engine = tab("t1");
        unknown_engine["engine"] = json!("postgres");
        for bad in [
            json!("x"),
            json!({ "version": 2, "activeTabId": null, "tabs": [] }),
            json!({ "version": 1, "activeTabId": "nope", "tabs": [tab("t1")] }),
            json!({ "version": 1, "activeTabId": null, "tabs": [tab("t1"), tab("t1")] }),
            json!({ "version": 1, "activeTabId": null, "tabs": [tab("")] }),
            json!({ "version": 1, "activeTabId": null, "tabs": [unknown_engine] }),
            json!({ "version": 1, "activeTabId": null }),
        ] {
            let err = Workspace::from_value(bad.clone()).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{bad}");
        }
    }

    #[test]
    fn lenient_read_drops_only_broken_tabs() {
        let mut broken = tab("t2");
        broken["sql"] = json!(5);
        let ws = Workspace::from_file_value(&json!({
            "version": 1,
            "activeTabId": "t2",
            "tabs": [tab("t1"), broken, tab("t1"), tab("t3")]
        }))
        .unwrap();
        let ids: Vec<_> = ws.tabs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["t1", "t3"]);
        assert_eq!(ws.active_tab_id, None);
    }

    #[test]
    fn lenient_read_rejects_other_shapes() {
        for bad in [json!([]), json!({ "version": 2, "tabs": [] }), json!({ "version": 1 })] {
            assert!(Workspace::from_file_value(&bad).is_err(), "{bad}");
        }
    }
}
