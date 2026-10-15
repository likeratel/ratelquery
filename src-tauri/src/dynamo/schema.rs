//! ListTables / DescribeTable and the per-handle description cache.

use std::sync::Arc;

use aws_sdk_dynamodb::types::{
    self as sdk, KeySchemaElement, KeyType as SdkKeyType, ProjectionType, ScalarAttributeType,
};

use super::errors::map_sdk_error;
use super::model::{
    IndexDescription, IndexKind, KeyAttribute, KeySchema, KeyType, Projection, TableDescription,
};
use super::registry::DynamoHandle;
use crate::error::{AppError, AppResult};

fn unexpected(what: &str) -> AppError {
    AppError::Query(format!("DescribeTable returned an unexpected response: {what}"))
}

fn attribute_type(definitions: &[sdk::AttributeDefinition], name: &str) -> AppResult<KeyType> {
    let definition = definitions
        .iter()
        .find(|d| d.attribute_name() == name)
        .ok_or_else(|| unexpected(&format!("no attribute definition for key {name}")))?;
    match definition.attribute_type() {
        ScalarAttributeType::S => Ok(KeyType::S),
        ScalarAttributeType::N => Ok(KeyType::N),
        ScalarAttributeType::B => Ok(KeyType::B),
        other => Err(unexpected(&format!("key type {}", other.as_str()))),
    }
}

fn key_schema(
    elements: &[KeySchemaElement],
    definitions: &[sdk::AttributeDefinition],
) -> AppResult<KeySchema> {
    let attribute = |kind: SdkKeyType| -> AppResult<Option<KeyAttribute>> {
        elements
            .iter()
            .find(|e| *e.key_type() == kind)
            .map(|e| {
                let name = e.attribute_name().to_string();
                Ok(KeyAttribute { key_type: attribute_type(definitions, &name)?, name })
            })
            .transpose()
    };
    let hash = attribute(SdkKeyType::Hash)?.ok_or_else(|| unexpected("no HASH key"))?;
    Ok(KeySchema { hash, range: attribute(SdkKeyType::Range)? })
}

fn projection(value: Option<&sdk::Projection>) -> Projection {
    match value.and_then(|p| p.projection_type()) {
        Some(ProjectionType::KeysOnly) => Projection::KeysOnly,
        Some(ProjectionType::Include) => Projection::Include,
        _ => Projection::All,
    }
}

/// SDK description -> IPC description.
pub fn describe_from_sdk(table: &sdk::TableDescription) -> AppResult<TableDescription> {
    let definitions = table.attribute_definitions();
    let index = |name: Option<&str>, kind, keys: &[KeySchemaElement], proj| {
        Ok(IndexDescription {
            name: name.unwrap_or_default().to_string(),
            kind,
            key_schema: key_schema(keys, definitions)?,
            projection: projection(proj),
        })
    };
    let global = table
        .global_secondary_indexes()
        .iter()
        .map(|i| index(i.index_name(), IndexKind::Gsi, i.key_schema(), i.projection()));
    let local = table
        .local_secondary_indexes()
        .iter()
        .map(|i| index(i.index_name(), IndexKind::Lsi, i.key_schema(), i.projection()));
    Ok(TableDescription {
        name: table.table_name().ok_or_else(|| unexpected("no table name"))?.to_string(),
        status: table.table_status().map(|s| s.as_str().to_string()).unwrap_or_default(),
        key_schema: key_schema(table.key_schema(), definitions)?,
        indexes: global.chain(local).collect::<AppResult<_>>()?,
        item_count: table.item_count(),
        size_bytes: table.table_size_bytes(),
        billing_mode: table
            .billing_mode_summary()
            .and_then(|b| b.billing_mode())
            .map(|m| m.as_str().to_string()),
    })
}

/// Every table name, following `LastEvaluatedTableName`.
pub async fn list_tables(handle: &DynamoHandle) -> AppResult<Vec<String>> {
    let mut names = Vec::new();
    let mut start: Option<String> = None;
    loop {
        let output = handle
            .client()
            .list_tables()
            .set_exclusive_start_table_name(start.take())
            .send()
            .await
            .map_err(|e| map_sdk_error(&e, handle.auth(), None))?;
        names.extend(output.table_names().iter().cloned());
        match output.last_evaluated_table_name() {
            Some(last) => start = Some(last.to_string()),
            None => return Ok(names),
        }
    }
}

/// Fresh DescribeTable; refreshes the cache.
pub async fn describe_table(
    handle: &DynamoHandle,
    table: &str,
) -> AppResult<Arc<TableDescription>> {
    let result = handle.client().describe_table().table_name(table).send().await;
    let output = match result {
        Ok(output) => output,
        Err(err) => {
            handle.forget_table(table).await;
            return Err(map_sdk_error(&err, handle.auth(), Some(table)));
        }
    };
    let description = output.table().ok_or_else(|| unexpected("no table"))?;
    Ok(handle.cache_table(table, describe_from_sdk(description)?).await)
}

/// Cached description, fetched on first use.
pub async fn table_info(handle: &DynamoHandle, table: &str) -> AppResult<Arc<TableDescription>> {
    match handle.cached_table(table).await {
        Some(description) => Ok(description),
        None => describe_table(handle, table).await,
    }
}

/// Key schema for the table or one of its indexes. An unknown index triggers one refresh in
/// case the index was created after the description was cached.
pub async fn key_schema_for(
    handle: &DynamoHandle,
    table: &str,
    index: Option<&str>,
) -> AppResult<KeySchema> {
    let cached = table_info(handle, table).await?;
    if let Some(schema) = cached.key_schema_for(index) {
        return Ok(schema.clone());
    }
    let fresh = describe_table(handle, table).await?;
    fresh.key_schema_for(index).cloned().ok_or_else(|| {
        AppError::NotFound(format!("index {} does not exist on table {table}", index.unwrap_or("")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_dynamodb::types::{
        AttributeDefinition, BillingMode, BillingModeSummary, GlobalSecondaryIndexDescription,
        LocalSecondaryIndexDescription, TableStatus,
    };

    fn element(name: &str, kind: SdkKeyType) -> KeySchemaElement {
        KeySchemaElement::builder().attribute_name(name).key_type(kind).build().unwrap()
    }

    fn definition(name: &str, kind: ScalarAttributeType) -> AttributeDefinition {
        AttributeDefinition::builder().attribute_name(name).attribute_type(kind).build().unwrap()
    }

    #[test]
    fn converts_description_with_indexes() {
        let table = sdk::TableDescription::builder()
            .table_name("orders")
            .table_status(TableStatus::Active)
            .key_schema(element("pk", SdkKeyType::Hash))
            .key_schema(element("sk", SdkKeyType::Range))
            .attribute_definitions(definition("pk", ScalarAttributeType::S))
            .attribute_definitions(definition("sk", ScalarAttributeType::N))
            .attribute_definitions(definition("g", ScalarAttributeType::B))
            .global_secondary_indexes(
                GlobalSecondaryIndexDescription::builder()
                    .index_name("by_g")
                    .key_schema(element("g", SdkKeyType::Hash))
                    .projection(
                        sdk::Projection::builder()
                            .projection_type(ProjectionType::KeysOnly)
                            .build(),
                    )
                    .build(),
            )
            .local_secondary_indexes(
                LocalSecondaryIndexDescription::builder()
                    .index_name("by_g_local")
                    .key_schema(element("pk", SdkKeyType::Hash))
                    .key_schema(element("g", SdkKeyType::Range))
                    .projection(
                        sdk::Projection::builder().projection_type(ProjectionType::Include).build(),
                    )
                    .build(),
            )
            .item_count(3)
            .table_size_bytes(120)
            .billing_mode_summary(
                BillingModeSummary::builder().billing_mode(BillingMode::PayPerRequest).build(),
            )
            .build();
        let d = describe_from_sdk(&table).unwrap();
        assert_eq!(d.name, "orders");
        assert_eq!(d.status, "ACTIVE");
        assert_eq!(d.key_schema.hash, KeyAttribute { name: "pk".into(), key_type: KeyType::S });
        assert_eq!(
            d.key_schema.range,
            Some(KeyAttribute { name: "sk".into(), key_type: KeyType::N })
        );
        assert_eq!(d.indexes.len(), 2);
        assert_eq!(
            (d.indexes[0].kind, d.indexes[0].projection),
            (IndexKind::Gsi, Projection::KeysOnly)
        );
        assert_eq!(d.indexes[0].key_schema.hash.key_type, KeyType::B);
        assert_eq!(
            (d.indexes[1].kind, d.indexes[1].projection),
            (IndexKind::Lsi, Projection::Include)
        );
        assert_eq!(d.key_schema_for(Some("by_g_local")).unwrap().range.as_ref().unwrap().name, "g");
        assert!(d.key_schema_for(Some("missing")).is_none());
        assert_eq!((d.item_count, d.size_bytes), (Some(3), Some(120)));
        assert_eq!(d.billing_mode.as_deref(), Some("PAY_PER_REQUEST"));
    }

    #[test]
    fn missing_hash_key_is_an_error() {
        let table = sdk::TableDescription::builder().table_name("t").build();
        assert_eq!(describe_from_sdk(&table).unwrap_err().kind(), "query");
    }
}
