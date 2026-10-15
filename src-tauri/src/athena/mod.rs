//! Amazon Athena: per-connection clients, output-location resolution, catalog browsing and
//! asynchronous query executions.

mod catalog;
mod cell;
mod errors;
mod model;
mod output;
mod query;
mod registry;
mod results;

pub use catalog::{list_databases, list_workgroups, schema};
pub use errors::map_sdk_error;
pub use model::{
    AthenaBucketCreated, AthenaQueryOptions, AthenaRowsResult, AthenaStarted, AthenaStats,
    AthenaTestInfo, DEFAULT_CATALOG,
};
pub use output::{ResolvedOutput, create_output_bucket, resolve_output};
pub use query::{cancel, start, wait};
pub use registry::{AthenaClients, AthenaHandle, connect_sdk};
