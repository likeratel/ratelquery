//! StartQueryExecution / GetQueryExecution polling / StopQueryExecution. Nothing here re-runs
//! a statement: every execution is billed.

use std::time::{Duration, Instant};

use aws_sdk_athena::types::{
    QueryExecution, QueryExecutionContext, QueryExecutionState, ResultConfiguration,
};

use super::errors::map_sdk_error;
use super::model::{AthenaQueryOptions, AthenaRowsResult, AthenaStarted, AthenaStats};
use super::registry::AthenaHandle;
use super::results::fetch_rows;
use crate::error::{AppError, AppResult};
use crate::mysql::{RowsResult, resolve_max_rows};
use crate::util::elapsed_ms;

const FIRST_POLL: Duration = Duration::from_millis(500);
const MAX_POLL: Duration = Duration::from_secs(2);
pub const CANCELLED_MESSAGE: &str = "The query was cancelled";

/// Poll interval after `current`: grows by half up to [`MAX_POLL`].
pub fn next_poll_delay(current: Duration) -> Duration {
    (current + current / 2).min(MAX_POLL)
}

fn trimmed(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// `QueryExecutionContext` only when a database or catalog is given.
fn execution_context(options: &AthenaQueryOptions) -> Option<QueryExecutionContext> {
    let database = trimmed(options.database.as_deref());
    let catalog = trimmed(options.catalog.as_deref());
    (database.is_some() || catalog.is_some()).then(|| {
        QueryExecutionContext::builder().set_database(database).set_catalog(catalog).build()
    })
}

/// Starts one statement in the connection's workgroup.
pub async fn start(
    handle: &AthenaHandle,
    sql: &str,
    options: &AthenaQueryOptions,
) -> AppResult<AthenaStarted> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err(AppError::InvalidInput("The statement is empty".into()));
    }
    resolve_max_rows(options.max_rows)?;
    let output_location = handle.output_for_query().await?;
    let output = handle
        .client()
        .start_query_execution()
        .query_string(sql)
        .work_group(handle.workgroup())
        .set_query_execution_context(execution_context(options))
        .set_result_configuration(
            output_location.map(|l| ResultConfiguration::builder().output_location(l).build()),
        )
        .send()
        .await
        .map_err(|e| map_sdk_error(&e, handle.auth()))?;
    let execution_id = output
        .query_execution_id()
        .ok_or_else(|| AppError::Query("StartQueryExecution returned no execution id".into()))?
        .to_string();
    handle.record_start(&execution_id);
    Ok(AthenaStarted { execution_id })
}

/// What a polled state means: `None` keeps polling.
pub fn terminal_outcome(
    state: Option<&QueryExecutionState>,
    error_message: Option<&str>,
    reason: Option<&str>,
) -> Option<AppResult<()>> {
    match state? {
        QueryExecutionState::Succeeded => Some(Ok(())),
        QueryExecutionState::Cancelled => Some(Err(AppError::Query(CANCELLED_MESSAGE.into()))),
        QueryExecutionState::Failed => {
            let message = error_message.or(reason).unwrap_or("The query failed");
            Some(Err(AppError::Query(message.to_string())))
        }
        _ => None,
    }
}

fn outcome(execution: &QueryExecution) -> Option<AppResult<()>> {
    let status = execution.status();
    terminal_outcome(
        status.and_then(|s| s.state()),
        status.and_then(|s| s.athena_error()).and_then(|e| e.error_message()),
        status.and_then(|s| s.state_change_reason()),
    )
}

async fn poll_until_done(handle: &AthenaHandle, execution_id: &str) -> AppResult<QueryExecution> {
    let mut delay = FIRST_POLL;
    loop {
        let output = handle
            .client()
            .get_query_execution()
            .query_execution_id(execution_id)
            .send()
            .await
            .map_err(|e| map_sdk_error(&e, handle.auth()))?;
        let execution = output
            .query_execution()
            .ok_or_else(|| AppError::Query("GetQueryExecution returned no execution".into()))?;
        match outcome(execution) {
            Some(result) => return result.map(|()| execution.clone()),
            None => {
                tokio::time::sleep(delay).await;
                delay = next_poll_delay(delay);
            }
        }
    }
}

pub fn stats(execution_id: &str, execution: &QueryExecution) -> AthenaStats {
    let statistics = execution.statistics();
    AthenaStats {
        execution_id: execution_id.to_string(),
        data_scanned_bytes: statistics.and_then(|s| s.data_scanned_in_bytes()).unwrap_or(0),
        engine_ms: statistics.and_then(|s| s.engine_execution_time_in_millis()),
        output_location: execution
            .result_configuration()
            .and_then(|r| r.output_location())
            .map(str::to_string),
    }
}

/// Waits for the execution to finish and reads up to `max_rows` rows.
pub async fn wait(
    handle: &AthenaHandle,
    execution_id: &str,
    max_rows: Option<i64>,
) -> AppResult<AthenaRowsResult> {
    let max_rows = resolve_max_rows(max_rows)?;
    let start = handle.started_at(execution_id).unwrap_or_else(Instant::now);
    let result = poll_until_done(handle, execution_id).await;
    // Terminal (or no longer pollable): nothing to stop on delete / edit any more.
    handle.forget_start(execution_id);
    let execution = result?;
    let fetched = fetch_rows(handle, execution_id, max_rows).await?;
    Ok(AthenaRowsResult {
        rows: RowsResult {
            row_count: fetched.rows.len(),
            columns: fetched.columns,
            rows: fetched.rows,
            truncated: fetched.truncated,
            elapsed_ms: elapsed_ms(start),
            reconnected: false,
            statement: execution.query().unwrap_or_default().to_string(),
        },
        athena: stats(execution_id, &execution),
    })
}

/// StopQueryExecution; finished executions are left as they are. Once stopped, the execution
/// is no longer tracked for the stop on delete / edit (a failed stop keeps it tracked).
pub async fn cancel(handle: &AthenaHandle, execution_id: &str) -> AppResult<()> {
    handle
        .client()
        .stop_query_execution()
        .query_execution_id(execution_id)
        .send()
        .await
        .map_err(|e| map_sdk_error(&e, handle.auth()))?;
    handle.forget_start(execution_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_athena::types::{QueryExecutionStatistics, QueryExecutionStatus};

    #[test]
    fn poll_delay_grows_to_two_seconds() {
        let mut delay = FIRST_POLL;
        let mut seen = vec![delay];
        for _ in 0..6 {
            delay = next_poll_delay(delay);
            seen.push(delay);
        }
        let millis: Vec<u128> = seen.iter().map(Duration::as_millis).collect();
        assert_eq!(millis, [500, 750, 1125, 1687, 2000, 2000, 2000]);
    }

    #[test]
    fn terminal_states_map_to_results() {
        assert!(terminal_outcome(None, None, None).is_none());
        assert!(terminal_outcome(Some(&QueryExecutionState::Queued), None, None).is_none());
        assert!(terminal_outcome(Some(&QueryExecutionState::Running), None, None).is_none());
        assert!(matches!(
            terminal_outcome(Some(&QueryExecutionState::Succeeded), None, None),
            Some(Ok(()))
        ));
        let cancelled = terminal_outcome(Some(&QueryExecutionState::Cancelled), None, None);
        let err = cancelled.unwrap().unwrap_err();
        assert_eq!((err.kind(), err.to_string().as_str()), ("query", CANCELLED_MESSAGE));
        let failed =
            |e, r| terminal_outcome(Some(&QueryExecutionState::Failed), e, r).unwrap().unwrap_err();
        assert_eq!(
            failed(Some("SYNTAX_ERROR: line 1"), Some("reason")).to_string(),
            "SYNTAX_ERROR: line 1"
        );
        assert_eq!(failed(None, Some("reason")).to_string(), "reason");
        assert_eq!(failed(None, None).kind(), "query");
    }

    #[test]
    fn builds_the_execution_context_only_when_needed() {
        assert!(execution_context(&AthenaQueryOptions::default()).is_none());
        let blank = AthenaQueryOptions { database: Some(" ".into()), ..Default::default() };
        assert!(execution_context(&blank).is_none());
        let options = AthenaQueryOptions { database: Some(" sales ".into()), ..Default::default() };
        let context = execution_context(&options).unwrap();
        assert_eq!((context.database(), context.catalog()), (Some("sales"), None));
        let catalog = AthenaQueryOptions { catalog: Some("lake".into()), ..Default::default() };
        assert_eq!(execution_context(&catalog).unwrap().catalog(), Some("lake"));
    }

    #[test]
    fn stats_read_the_execution() {
        let execution = QueryExecution::builder()
            .status(QueryExecutionStatus::builder().state(QueryExecutionState::Succeeded).build())
            .statistics(
                QueryExecutionStatistics::builder()
                    .data_scanned_in_bytes(2048)
                    .engine_execution_time_in_millis(15)
                    .build(),
            )
            .result_configuration(
                ResultConfiguration::builder().output_location("s3://b/e.csv").build(),
            )
            .build();
        assert_eq!(
            stats("e", &execution),
            AthenaStats {
                execution_id: "e".into(),
                data_scanned_bytes: 2048,
                engine_ms: Some(15),
                output_location: Some("s3://b/e.csv".into()),
            }
        );
        let bare = stats("e", &QueryExecution::builder().build());
        assert_eq!(
            (bare.data_scanned_bytes, bare.engine_ms, bare.output_location),
            (0, None, None)
        );
        assert!(outcome(&execution).is_some_and(|r| r.is_ok()));
    }
}
