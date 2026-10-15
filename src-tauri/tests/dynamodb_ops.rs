//! Live DynamoDB Local tests. Run only with `DBCLIENT_TEST_DYNAMODB_ENDPOINT`
//! (e.g. `http://localhost:8000`).

use std::sync::Arc;

use aws_sdk_dynamodb::types::{
    AttributeDefinition, BillingMode, GlobalSecondaryIndex, KeySchemaElement,
    KeyType as SdkKeyType, Projection as SdkProjection, ProjectionType, ScalarAttributeType,
};
use dbclient_lib::connections::{DynamoAuth, DynamoConnectionConfig};
use dbclient_lib::dynamo::{
    self, DynamoClients, DynamoExportFormat, DynamoExportOptions, DynamoExportRequest,
    DynamoHandle, IndexKind, KeyType, Page, Projection, PutExpectation, QueryRequest,
    RangeCondition, ScanRequest, WireItem,
};
use futures_util::FutureExt;
use serde_json::{Value, json};

fn endpoint() -> Option<String> {
    match std::env::var("DBCLIENT_TEST_DYNAMODB_ENDPOINT") {
        Ok(endpoint) => Some(endpoint),
        Err(_) => {
            eprintln!("skipping: DBCLIENT_TEST_DYNAMODB_ENDPOINT is not set");
            None
        }
    }
}

fn config(endpoint: &str) -> DynamoConnectionConfig {
    DynamoConnectionConfig {
        id: uuid::Uuid::new_v4().to_string(),
        name: "local".into(),
        region: "ap-northeast-2".into(),
        endpoint: Some(endpoint.to_string()),
        auth: DynamoAuth::Keys { access_key_id: "local".into() },
        color: None,
    }
}

fn item(value: Value) -> WireItem {
    serde_json::from_value(value).expect("item object")
}

fn s(v: &str) -> Value {
    json!({ "S": v })
}

fn key_element(name: &str, kind: SdkKeyType) -> KeySchemaElement {
    KeySchemaElement::builder().attribute_name(name).key_type(kind).build().unwrap()
}

fn definition(name: &str) -> AttributeDefinition {
    AttributeDefinition::builder()
        .attribute_name(name)
        .attribute_type(ScalarAttributeType::S)
        .build()
        .unwrap()
}

async fn create_table(handle: &DynamoHandle, table: &str) {
    let gsi = GlobalSecondaryIndex::builder()
        .index_name("by_cat")
        .key_schema(key_element("cat", SdkKeyType::Hash))
        .key_schema(key_element("sk", SdkKeyType::Range))
        .projection(SdkProjection::builder().projection_type(ProjectionType::All).build())
        .build()
        .unwrap();
    handle
        .client()
        .create_table()
        .table_name(table)
        .key_schema(key_element("pk", SdkKeyType::Hash))
        .key_schema(key_element("sk", SdkKeyType::Range))
        .attribute_definitions(definition("pk"))
        .attribute_definitions(definition("sk"))
        .attribute_definitions(definition("cat"))
        .global_secondary_indexes(gsi)
        .billing_mode(BillingMode::PayPerRequest)
        .send()
        .await
        .expect("create table");
}

fn seed() -> Vec<WireItem> {
    let rows = [
        ("u1", "2024-01", "red", "1"),
        ("u1", "2024-02", "blue", "2"),
        ("u1", "2024-03", "red", "3"),
        ("u1", "2025-01", "blue", "4"),
        ("u1", "2025-02", "red", "5"),
        ("u2", "2024-01", "green", "6"),
    ];
    rows.iter()
        .map(|(pk, sk, cat, n)| {
            item(json!({ "pk": s(pk), "sk": s(sk), "cat": s(cat), "n": { "N": n } }))
        })
        .collect()
}

fn query_u1(range: Option<Value>) -> QueryRequest {
    QueryRequest {
        table: String::new(),
        hash: s("u1"),
        range: range.map(|r| serde_json::from_value::<RangeCondition>(r).unwrap()),
        ..Default::default()
    }
}

fn sks(page: &Page) -> Vec<String> {
    page.items.iter().map(|i| i["sk"]["S"].as_str().unwrap().to_string()).collect()
}

async fn check_queries(handle: &DynamoHandle, table: &str) {
    let q = |range: Option<Value>| QueryRequest { table: table.to_string(), ..query_u1(range) };
    let all = dynamo::query(handle, &q(None)).await.unwrap();
    assert_eq!((all.count, all.scanned_count, all.last_key.clone()), (5, 5, None));
    let cases = [
        (json!({ "op": "eq", "value": s("2024-02") }), vec!["2024-02"]),
        (json!({ "op": "lt", "value": s("2024-03") }), vec!["2024-01", "2024-02"]),
        (json!({ "op": "le", "value": s("2024-03") }), vec!["2024-01", "2024-02", "2024-03"]),
        (json!({ "op": "gt", "value": s("2024-03") }), vec!["2025-01", "2025-02"]),
        (json!({ "op": "ge", "value": s("2024-03") }), vec!["2024-03", "2025-01", "2025-02"]),
        (json!({ "op": "begins_with", "value": s("2025") }), vec!["2025-01", "2025-02"]),
        (
            json!({ "op": "between", "from": s("2024-02"), "to": s("2025-01") }),
            vec!["2024-02", "2024-03", "2025-01"],
        ),
    ];
    for (range, expected) in cases {
        let page = dynamo::query(handle, &q(Some(range.clone()))).await.unwrap();
        assert_eq!(sks(&page), expected, "{range}");
    }

    let backwards = QueryRequest { scan_forward: Some(false), ..q(None) };
    assert_eq!(sks(&dynamo::query(handle, &backwards).await.unwrap())[0], "2025-02");

    // User placeholders that look like the internal ones must not collide.
    let filtered = QueryRequest {
        filter: Some("#dbk0 > :dbk0".into()),
        names: Some([("#dbk0".to_string(), "n".to_string())].into()),
        values: Some(item(json!({ ":dbk0": { "N": "2" } }))),
        ..q(None)
    };
    let page = dynamo::query(handle, &filtered).await.unwrap();
    assert_eq!((page.count, page.scanned_count), (3, 5));

    let by_index = QueryRequest {
        index: Some("by_cat".into()),
        hash: s("red"),
        range: Some(
            serde_json::from_value(json!({ "op": "begins_with", "value": s("2024") })).unwrap(),
        ),
        ..q(None)
    };
    assert_eq!(sks(&dynamo::query(handle, &by_index).await.unwrap()), vec!["2024-01", "2024-03"]);

    let bad_index = QueryRequest { index: Some("nope".into()), ..q(None) };
    assert_eq!(dynamo::query(handle, &bad_index).await.unwrap_err().kind(), "not_found");
    let bad_filter = QueryRequest { filter: Some("#missing = :x".into()), ..q(None) };
    assert_eq!(dynamo::query(handle, &bad_filter).await.unwrap_err().kind(), "query");
    let bad_hash = QueryRequest { hash: json!({ "S": 1 }), ..q(None) };
    assert_eq!(dynamo::query(handle, &bad_hash).await.unwrap_err().kind(), "invalid_input");
}

async fn check_pagination_and_scan(handle: &DynamoHandle, table: &str) {
    let mut start_key = None;
    let mut pages = Vec::new();
    loop {
        let request = QueryRequest {
            table: table.to_string(),
            limit: Some(2),
            start_key: start_key.take(),
            ..query_u1(None)
        };
        let page = dynamo::query(handle, &request).await.unwrap();
        pages.push(sks(&page));
        match page.last_key {
            Some(key) => start_key = Some(key),
            None => break,
        }
        assert!(pages.len() < 10, "pagination did not terminate");
    }
    assert_eq!(
        pages,
        vec![vec!["2024-01", "2024-02"], vec!["2024-03", "2025-01"], vec!["2025-02"]]
    );

    let scan = ScanRequest {
        table: table.to_string(),
        filter: Some("#c = :c".into()),
        names: Some([("#c".to_string(), "cat".to_string())].into()),
        values: Some(item(json!({ ":c": s("red") }))),
        ..Default::default()
    };
    let page = dynamo::scan(handle, &scan).await.unwrap();
    assert_eq!((page.count, page.scanned_count), (3, 6));
    let page = dynamo::scan(
        handle,
        &ScanRequest { table: table.to_string(), limit: Some(4), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(page.items.len(), 4);
    assert!(page.last_key.is_some());
}

async fn check_items(handle: &DynamoHandle, table: &str) {
    let key = item(json!({ "pk": s("u9"), "sk": s("x") }));
    let new_item = item(json!({
        "pk": s("u9"), "sk": s("x"), "cat": s("red"),
        "nested": { "M": { "l": { "L": [ { "N": "1" }, { "NULL": true } ] }, "b": { "B": "AAH/" } } },
        "tags": { "SS": ["a", "b"] }
    }));
    assert!(dynamo::get_item(handle, table, &key).await.unwrap().is_none());
    let err = dynamo::put_item(handle, table, &new_item, PutExpectation::Exists).await.unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().contains("no item"), "{err}");
    dynamo::put_item(handle, table, &new_item, PutExpectation::NotExists).await.unwrap();
    let err =
        dynamo::put_item(handle, table, &new_item, PutExpectation::NotExists).await.unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().contains("already exists"), "{err}");
    let updated = item(json!({ "pk": s("u9"), "sk": s("x"), "v": { "BOOL": true } }));
    dynamo::put_item(handle, table, &updated, PutExpectation::Exists).await.unwrap();
    assert_eq!(dynamo::get_item(handle, table, &key).await.unwrap(), Some(updated.clone()));
    dynamo::put_item(handle, table, &new_item, PutExpectation::Any).await.unwrap();
    assert_eq!(dynamo::get_item(handle, table, &key).await.unwrap(), Some(new_item.clone()));
    let missing_hash = item(json!({ "sk": s("x") }));
    let err =
        dynamo::put_item(handle, table, &missing_hash, PutExpectation::Exists).await.unwrap_err();
    assert_eq!(err.kind(), "invalid_input");

    dynamo::delete_item(handle, table, &key).await.unwrap();
    assert!(dynamo::get_item(handle, table, &key).await.unwrap().is_none());
    assert_eq!(
        dynamo::get_item(handle, table, &WireItem::new()).await.unwrap_err().kind(),
        "invalid_input"
    );
    assert_eq!(
        dynamo::get_item(handle, "missing_table_x", &key).await.unwrap_err().kind(),
        "not_found"
    );
}

async fn export(
    handle: &DynamoHandle,
    request: &DynamoExportRequest,
    format: DynamoExportFormat,
    dir: &std::path::Path,
    name: &str,
) -> (String, u64) {
    let path = dir.join(name);
    let options = DynamoExportOptions { format, path: path.to_string_lossy().into_owned() };
    let result = dynamo::run_export(handle, request, &options).await.unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(result.bytes, text.len() as u64);
    (text, result.rows)
}

async fn check_exports(handle: &DynamoHandle, table: &str) {
    let dir = tempfile::tempdir().unwrap();
    let query = DynamoExportRequest::Query(QueryRequest {
        table: table.to_string(),
        limit: Some(2),
        ..query_u1(None)
    });
    let (json_text, rows) =
        export(handle, &query, DynamoExportFormat::Json, dir.path(), "q.json").await;
    let parsed: Vec<WireItem> = serde_json::from_str(&json_text).unwrap();
    assert_eq!((rows, parsed.len()), (5, 5));
    assert_eq!(parsed[0], seed()[0]);

    let scan = DynamoExportRequest::Scan(ScanRequest {
        table: table.to_string(),
        limit: Some(4),
        ..Default::default()
    });
    let (jsonl, rows) =
        export(handle, &scan, DynamoExportFormat::Jsonl, dir.path(), "s.jsonl").await;
    assert_eq!(rows, 6);
    assert_eq!(jsonl.lines().count(), 6);
    assert!(jsonl.lines().all(|l| serde_json::from_str::<WireItem>(l).is_ok()));

    let odd = item(json!({ "pk": s("u2"), "sk": s("2099"), "extra": { "M": { "k": s("v") } } }));
    dynamo::put_item(handle, table, &odd, PutExpectation::Any).await.unwrap();
    let (csv_text, rows) =
        export(handle, &scan, DynamoExportFormat::Csv, dir.path(), "s.csv").await;
    assert_eq!(rows, 7);
    let lines: Vec<&str> = csv_text.lines().collect();
    assert_eq!(lines[0], "pk,sk,cat,extra,n");
    assert_eq!(lines.len(), 8);
    assert!(lines.contains(&"u1,2024-01,red,,1"), "{csv_text}");
    assert!(lines.contains(&"u2,2099,,\"{\"\"k\"\":\"\"v\"\"}\","), "{csv_text}");

    let empty = DynamoExportRequest::Query(QueryRequest {
        table: table.to_string(),
        hash: s("nobody"),
        ..query_u1(None)
    });
    let (text, rows) = export(handle, &empty, DynamoExportFormat::Csv, dir.path(), "e.csv").await;
    assert_eq!((text.as_str(), rows), ("pk,sk\n", 0));
    let (text, _) = export(handle, &empty, DynamoExportFormat::Json, dir.path(), "e.json").await;
    assert_eq!(text, "[]\n");

    let failing = DynamoExportRequest::Scan(ScanRequest {
        table: table.to_string(),
        filter: Some("#nope = :x".into()),
        ..Default::default()
    });
    let path = dir.path().join("fail.csv");
    let options = DynamoExportOptions {
        format: DynamoExportFormat::Csv,
        path: path.to_string_lossy().into_owned(),
    };
    assert_eq!(dynamo::run_export(handle, &failing, &options).await.unwrap_err().kind(), "query");
    assert!(!path.exists());
    // Only the successful exports remain, no temp or spool files.
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 5);
}

async fn check_metadata(handle: &DynamoHandle, table: &str) {
    let tables = dynamo::list_tables(handle).await.unwrap();
    assert!(tables.iter().any(|t| t == table), "{tables:?}");
    let description = dynamo::describe_table(handle, table).await.unwrap();
    assert_eq!(description.name, table);
    assert_eq!(description.status, "ACTIVE");
    assert_eq!(description.key_schema.hash.name, "pk");
    assert_eq!(
        description.key_schema.range.as_ref().map(|r| (r.name.as_str(), r.key_type)),
        Some(("sk", KeyType::S))
    );
    let [index] = description.indexes.as_slice() else { panic!("expected one index") };
    assert_eq!(
        (index.name.as_str(), index.kind, index.projection),
        ("by_cat", IndexKind::Gsi, Projection::All)
    );
    assert_eq!(index.key_schema.hash.name, "cat");
    assert_eq!(
        dynamo::describe_table(handle, "missing_table_x").await.unwrap_err().kind(),
        "not_found"
    );
}

async fn run_all(handle: &DynamoHandle, table: &str) {
    for seeded in seed() {
        dynamo::put_item(handle, table, &seeded, PutExpectation::NotExists).await.unwrap();
    }
    check_metadata(handle, table).await;
    check_queries(handle, table).await;
    check_pagination_and_scan(handle, table).await;
    check_items(handle, table).await;
    check_exports(handle, table).await;
}

#[tokio::test]
async fn dynamodb_local_end_to_end() {
    let Some(endpoint) = endpoint() else { return };
    let clients = DynamoClients::new();
    let config = config(&endpoint);
    let handle = clients.connect(&config, Some("local")).await.unwrap();
    let table = format!("it_{}", uuid::Uuid::new_v4().simple());
    create_table(&handle, &table).await;
    let outcome = std::panic::AssertUnwindSafe(run_all(&handle, &table)).catch_unwind().await;
    handle.client().delete_table().table_name(&table).send().await.expect("delete table");
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn registry_caches_and_reports_credentials() {
    let Some(endpoint) = endpoint() else { return };
    let clients = DynamoClients::new();
    let config = config(&endpoint);
    let first = clients.connect(&config, Some("local")).await.unwrap();
    let second = clients.connect(&config, None).await.unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    clients.remove(&config.id).await;
    assert!(clients.get(&config.id).await.is_none());
    let err = clients.connect(&config, None).await.err().expect("missing secret");
    assert_eq!(err.kind(), "credential");
    let unreachable =
        DynamoConnectionConfig { endpoint: Some("http://127.0.0.1:1".into()), ..config };
    let handle = clients.connect(&unreachable, Some("local")).await.unwrap();
    assert_eq!(dynamo::list_tables(&handle).await.unwrap_err().kind(), "connection");
}
