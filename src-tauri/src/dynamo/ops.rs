//! Query, Scan and single-item operations.

use std::time::Instant;

use aws_sdk_dynamodb::error::{ProvideErrorMetadata, SdkError};

use super::errors::{is_conditional_check_failed, map_sdk_error};
use super::expr::{UserParts, build_query, build_scan, build_update, page_limit, put_condition};
use super::model::{
    AttributeUpdate, ExpectedValue, Page, PutExpectation, QueryRequest, ScanRequest,
};
use super::registry::DynamoHandle;
use super::schema::key_schema_for;
use super::wire::{SdkItem, WireItem, from_wire_item, to_wire_item};
use crate::error::{AppError, AppResult};
use crate::util::elapsed_ms;

fn require_table(table: &str) -> AppResult<()> {
    if table.trim().is_empty() {
        return Err(AppError::InvalidInput("table name is required".into()));
    }
    Ok(())
}

fn require_attributes(key: &WireItem, what: &str) -> AppResult<SdkItem> {
    if key.is_empty() {
        return Err(AppError::InvalidInput(format!("the {what} must not be empty")));
    }
    from_wire_item(key)
}

fn index_name(index: Option<&String>) -> Option<String> {
    index.map(|i| i.trim()).filter(|i| !i.is_empty()).map(str::to_string)
}

fn start_key(key: Option<&WireItem>) -> AppResult<Option<SdkItem>> {
    key.filter(|k| !k.is_empty()).map(from_wire_item).transpose()
}

/// Maps an SDK error and drops the cached description when the table is gone.
async fn fail<E, R>(handle: &DynamoHandle, table: &str, err: SdkError<E, R>) -> AppError
where
    E: ProvideErrorMetadata + std::error::Error + 'static,
    R: std::fmt::Debug + 'static,
{
    let mapped = map_sdk_error(&err, handle.auth(), Some(table));
    if mapped.kind() == "not_found" {
        handle.forget_table(table).await;
    }
    mapped
}

fn page(
    items: &[SdkItem],
    last_key: Option<&SdkItem>,
    count: i32,
    scanned_count: i32,
    start: Instant,
) -> AppResult<Page> {
    Ok(Page {
        items: items.iter().map(to_wire_item).collect::<AppResult<_>>()?,
        last_key: last_key.filter(|k| !k.is_empty()).map(to_wire_item).transpose()?,
        count: i64::from(count),
        scanned_count: i64::from(scanned_count),
        elapsed_ms: elapsed_ms(start),
    })
}

/// One Query page.
pub async fn query(handle: &DynamoHandle, request: &QueryRequest) -> AppResult<Page> {
    let start = Instant::now();
    require_table(&request.table)?;
    let limit = page_limit(request.limit)?;
    let index = index_name(request.index.as_ref());
    let schema = key_schema_for(handle, &request.table, index.as_deref()).await?;
    let user = UserParts {
        filter: request.filter.as_deref(),
        names: request.names.as_ref(),
        values: request.values.as_ref(),
    };
    let expressions = build_query(&schema, &request.hash, request.range.as_ref(), &user)?;
    let output = handle
        .client()
        .query()
        .table_name(&request.table)
        .set_index_name(index)
        .set_key_condition_expression(expressions.key_condition.clone())
        .set_filter_expression(expressions.filter.clone())
        .set_expression_attribute_names(expressions.names_or_none())
        .set_expression_attribute_values(expressions.values_or_none())
        .set_exclusive_start_key(start_key(request.start_key.as_ref())?)
        .scan_index_forward(request.scan_forward.unwrap_or(true))
        .limit(limit)
        .send()
        .await;
    let output = match output {
        Ok(output) => output,
        Err(err) => return Err(fail(handle, &request.table, err).await),
    };
    page(output.items(), output.last_evaluated_key(), output.count(), output.scanned_count(), start)
}

/// One Scan page.
pub async fn scan(handle: &DynamoHandle, request: &ScanRequest) -> AppResult<Page> {
    let start = Instant::now();
    require_table(&request.table)?;
    let limit = page_limit(request.limit)?;
    let user = UserParts {
        filter: request.filter.as_deref(),
        names: request.names.as_ref(),
        values: request.values.as_ref(),
    };
    let expressions = build_scan(&user)?;
    let output = handle
        .client()
        .scan()
        .table_name(&request.table)
        .set_index_name(index_name(request.index.as_ref()))
        .set_filter_expression(expressions.filter.clone())
        .set_expression_attribute_names(expressions.names_or_none())
        .set_expression_attribute_values(expressions.values_or_none())
        .set_exclusive_start_key(start_key(request.start_key.as_ref())?)
        .limit(limit)
        .send()
        .await;
    let output = match output {
        Ok(output) => output,
        Err(err) => return Err(fail(handle, &request.table, err).await),
    };
    page(output.items(), output.last_evaluated_key(), output.count(), output.scanned_count(), start)
}

pub async fn get_item(
    handle: &DynamoHandle,
    table: &str,
    key: &WireItem,
) -> AppResult<Option<WireItem>> {
    require_table(table)?;
    let key = require_attributes(key, "item key")?;
    let output = handle.client().get_item().table_name(table).set_key(Some(key)).send().await;
    match output {
        Ok(output) => output.item().filter(|i| !i.is_empty()).map(to_wire_item).transpose(),
        Err(err) => Err(fail(handle, table, err).await),
    }
}

fn condition_failed_message(expect: PutExpectation, hash_key: &str) -> String {
    match expect {
        PutExpectation::NotExists => {
            format!("an item with this {hash_key} already exists; reload it or save with overwrite")
        }
        _ => format!("no item with this {hash_key} exists anymore; it may have been deleted"),
    }
}

/// Writes a whole item under `expect`. Over an existing item, `expected` values must also
/// still hold (the item editor sends the values its carried inline edits started from).
pub async fn put_item(
    handle: &DynamoHandle,
    table: &str,
    item: &WireItem,
    expect: PutExpectation,
    expected: &[ExpectedValue],
) -> AppResult<()> {
    require_table(table)?;
    let sdk_item = require_attributes(item, "item")?;
    let hash_key = match expect {
        PutExpectation::Any => None,
        _ => Some(key_schema_for(handle, table, None).await?.hash.name),
    };
    if let Some(hash) = hash_key.as_deref().filter(|h| !sdk_item.contains_key(*h)) {
        return Err(AppError::InvalidInput(format!("the item is missing its hash key {hash}")));
    }
    let condition = put_condition(expect, hash_key.as_deref().unwrap_or_default(), expected)?;
    let output = handle
        .client()
        .put_item()
        .table_name(table)
        .set_item(Some(sdk_item))
        .set_condition_expression(condition.condition.clone())
        .set_expression_attribute_names(condition.names_or_none())
        .set_expression_attribute_values(condition.values_or_none())
        .send()
        .await;
    match output {
        Ok(_) => Ok(()),
        Err(err) if is_conditional_check_failed(&err) && !expected.is_empty() => {
            Err(AppError::Query(UPDATE_CONFLICT_MESSAGE.to_string()))
        }
        Err(err) if is_conditional_check_failed(&err) => Err(AppError::Query(
            condition_failed_message(expect, hash_key.as_deref().unwrap_or("key")),
        )),
        Err(err) => Err(fail(handle, table, err).await),
    }
}

const UPDATE_CONFLICT_MESSAGE: &str = "the item was changed or deleted since it was loaded; \
                                       refresh to see its current values";

/// Sets some attributes, or values nested in their maps and lists, of one existing item with a
/// single UpdateItem. The write is refused (nothing changes) when the item is gone, any edited
/// value no longer is what the user saw, or an `expected` value (such as a list an edited path
/// indexes into) no longer holds.
pub async fn update_item_attributes(
    handle: &DynamoHandle,
    table: &str,
    key: &WireItem,
    changes: &[AttributeUpdate],
    expected: &[ExpectedValue],
) -> AppResult<()> {
    require_table(table)?;
    let key = require_attributes(key, "item key")?;
    let schema = key_schema_for(handle, table, None).await?;
    if !key.contains_key(&schema.hash.name) {
        return Err(AppError::InvalidInput(format!(
            "the item key is missing its hash key {}",
            schema.hash.name
        )));
    }
    let expressions = build_update(&schema, changes, expected)?;
    let output = handle
        .client()
        .update_item()
        .table_name(table)
        .set_key(Some(key))
        .set_update_expression(expressions.update.clone())
        .set_condition_expression(expressions.condition.clone())
        .set_expression_attribute_names(expressions.names_or_none())
        .set_expression_attribute_values(expressions.values_or_none())
        .send()
        .await;
    match output {
        Ok(_) => Ok(()),
        Err(err) if is_conditional_check_failed(&err) => {
            Err(AppError::Query(UPDATE_CONFLICT_MESSAGE.to_string()))
        }
        Err(err) => Err(fail(handle, table, err).await),
    }
}

pub async fn delete_item(handle: &DynamoHandle, table: &str, key: &WireItem) -> AppResult<()> {
    require_table(table)?;
    let key = require_attributes(key, "item key")?;
    match handle.client().delete_item().table_name(table).set_key(Some(key)).send().await {
        Ok(_) => Ok(()),
        Err(err) => Err(fail(handle, table, err).await),
    }
}
