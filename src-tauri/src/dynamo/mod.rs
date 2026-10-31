//! DynamoDB: per-connection clients, table metadata, query/scan, item edits and export.

mod errors;
mod export;
mod expr;
mod model;
mod ops;
mod registry;
mod schema;
mod wire;

pub use errors::{
    classify_code, credential_error, credential_hint, credentials_resolution_error,
    has_credentials_source, map_sdk_error,
};
pub use export::run_export;
pub use expr::{DEFAULT_LIMIT, MAX_LIMIT};
pub use model::{
    AttributeUpdate, DynamoExportFormat, DynamoExportOptions, DynamoExportRequest, ExpectedValue,
    IndexDescription, IndexKind, KeyAttribute, KeySchema, KeyType, Page, PathSegment, Projection,
    PutExpectation, QueryRequest, RangeCondition, RangeOp, ScanRequest, TableDescription,
};
pub use ops::{delete_item, get_item, put_item, query, scan, update_item_attributes};
pub use registry::{
    DynamoClients, DynamoHandle, aws_sdk_config, profile_credentials, resolve_credentials,
    sdk_config,
};
pub use schema::{describe_table, list_tables};
pub use wire::{SdkItem, WireItem, from_wire, from_wire_item, to_wire, to_wire_item};
