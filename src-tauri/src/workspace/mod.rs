//! Open query tabs persisted as `workspace.json`, so the next launch reopens them.

mod model;
mod store;

pub use model::{TabEngine, TabKind, WORKSPACE_VERSION, Workspace, WorkspaceTab};
pub use store::WorkspaceStore;
