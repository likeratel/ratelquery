//! DynamoDB: per-connection clients, table metadata, query/scan, item edits and export.

mod errors;
mod export;
mod expr;
mod model;
mod ops;
mod registry;
mod schema;
mod wire;

pub use errors::{classify_code, credential_hint, map_sdk_error};
pub use export::run_export;
pub use expr::{DEFAULT_LIMIT, MAX_LIMIT};
pub use model::{
    DynamoExportFormat, DynamoExportOptions, DynamoExportRequest, IndexDescription, IndexKind,
    KeyAttribute, KeySchema, KeyType, Page, Projection, PutExpectation, QueryRequest,
    RangeCondition, RangeOp, ScanRequest, TableDescription,
};
pub use ops::{delete_item, get_item, put_item, query, scan};
pub use registry::{DynamoClients, DynamoHandle};
pub use schema::{describe_table, list_tables};
pub use wire::{SdkItem, WireItem, from_wire, from_wire_item, to_wire, to_wire_item};
