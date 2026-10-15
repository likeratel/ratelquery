//! MySQL sessions, queries, schema, grid edits and streaming export.

mod binary_hint;
mod bind;
mod cell;
mod changes;
mod classify;
mod decode;
mod errors;
mod events;
mod export;
mod model;
mod options;
mod query;
mod registry;
mod schema;
mod session;
mod splitter;
mod table_details;
mod type_meta;

pub use bind::{BindValue, to_bind_value};
pub use cell::Cell;
pub use changes::{BuiltStatement, apply_changes, build_statement};
pub use classify::{infer_base_table, is_read_statement};
pub use errors::{POOL_BUSY, UNKNOWN_OUTCOME, describe_sqlx_error, is_connection_error};
pub use events::{RecordingSink, STATE_EVENT, StateSink};
pub use export::run_export;
pub use model::{
    ApplyChangesResult, ColumnInfo, ExecResult, ForeignKeyInfo, IndexInfo, MysqlSessionInfo,
    MysqlStateEvent, QueryOptions, QueryResult, RowChange, RowsResult, SchemaColumn,
    SchemaSnapshot, SchemaTable, SessionState, TableDetails, TableKind,
};
pub use options::{MAX_CONNECTIONS, connect_options, fetch_server_version, quote_ident};
pub use query::run_query;
pub use registry::{MysqlSessions, PING_INTERVAL};
pub use session::MysqlSession;
pub use splitter::split_statements;

use schema::{fetch_schema, list_databases};
use session::boxed;
use table_details::fetch_table_details;

use crate::error::AppResult;

/// `mysql_databases` for an open session.
pub async fn databases(session: &MysqlSession) -> AppResult<Vec<String>> {
    let (names, _) =
        session.run(|mut conn| boxed(async move { Ok(list_databases(&mut conn).await?) })).await?;
    Ok(names)
}

/// `mysql_schema` for an open session.
pub async fn schema(session: &MysqlSession, database: &str) -> AppResult<SchemaSnapshot> {
    let (snapshot, _) = session
        .run(|mut conn| {
            let database = database.to_string();
            boxed(async move { fetch_schema(&mut conn, &database).await })
        })
        .await?;
    Ok(snapshot)
}

/// `mysql_table_details` for an open session.
pub async fn table_details(
    session: &MysqlSession,
    database: &str,
    table: &str,
) -> AppResult<TableDetails> {
    let (details, _) = session
        .run(|mut conn| {
            let database = database.to_string();
            let table = table.to_string();
            boxed(async move { fetch_table_details(&mut conn, &database, &table).await })
        })
        .await?;
    Ok(details)
}
