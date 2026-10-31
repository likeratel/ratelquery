//! Live DynamoDB Local tests. Run only with `RATELQUERY_TEST_DYNAMODB_ENDPOINT`
//! (e.g. `http://localhost:8000`).

mod common;

use std::sync::Arc;

use aws_sdk_dynamodb::types::{
    AttributeDefinition, BillingMode, GlobalSecondaryIndex, KeySchemaElement,
    KeyType as SdkKeyType, Projection as SdkProjection, ProjectionType, ScalarAttributeType,
};
use futures_util::FutureExt;
use ratelquery_lib::connections::{DynamoAuth, DynamoConnectionConfig};
use ratelquery_lib::dynamo::{
    self, AttributeUpdate, DynamoClients, DynamoExportFormat, DynamoExportOptions,
    DynamoExportRequest, DynamoHandle, ExpectedValue, IndexKind, KeyType, Page, Projection,
    PutExpectation, QueryRequest, RangeCondition, ScanRequest, WireItem,
};
use serde_json::{Value, json};

fn endpoint() -> Option<String> {
    match std::env::var("RATELQUERY_TEST_DYNAMODB_ENDPOINT") {
        Ok(endpoint) => Some(endpoint),
        Err(_) => {
            common::skipped(
                "live DynamoDB test: RATELQUERY_TEST_DYNAMODB_ENDPOINT is not set. Run \
                 `pnpm db:up` and set RATELQUERY_TEST_DYNAMODB_ENDPOINT=http://localhost:8000 \
                 to run it.",
            );
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
    let err =
        dynamo::put_item(handle, table, &new_item, PutExpectation::Exists, &[]).await.unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().contains("no item"), "{err}");
    dynamo::put_item(handle, table, &new_item, PutExpectation::NotExists, &[]).await.unwrap();
    let err = dynamo::put_item(handle, table, &new_item, PutExpectation::NotExists, &[])
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().contains("already exists"), "{err}");
    let updated = item(json!({ "pk": s("u9"), "sk": s("x"), "v": { "BOOL": true } }));
    dynamo::put_item(handle, table, &updated, PutExpectation::Exists, &[]).await.unwrap();
    assert_eq!(dynamo::get_item(handle, table, &key).await.unwrap(), Some(updated.clone()));
    dynamo::put_item(handle, table, &new_item, PutExpectation::Any, &[]).await.unwrap();
    assert_eq!(dynamo::get_item(handle, table, &key).await.unwrap(), Some(new_item.clone()));
    let missing_hash = item(json!({ "sk": s("x") }));
    let err = dynamo::put_item(handle, table, &missing_hash, PutExpectation::Exists, &[])
        .await
        .unwrap_err();
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

fn update(name: &str, value: Value, expected: Option<Value>) -> AttributeUpdate {
    AttributeUpdate { name: name.into(), path: vec![], value, expected }
}

async fn check_attribute_updates(handle: &DynamoHandle, table: &str) {
    let key = item(json!({ "pk": s("u8"), "sk": s("y") }));
    let original = item(json!({ "pk": s("u8"), "sk": s("y"), "cat": s("red"), "n": { "N": "1" } }));
    dynamo::put_item(handle, table, &original, PutExpectation::NotExists, &[]).await.unwrap();
    let changes = [
        update("cat", s("blue"), Some(s("red"))),
        update("n", json!({ "N": "2" }), Some(json!({ "N": "1.0" }))),
        update("flag", json!({ "BOOL": true }), None),
    ];
    dynamo::update_item_attributes(handle, table, &key, &changes, &[]).await.unwrap();
    let stored = dynamo::get_item(handle, table, &key).await.unwrap().unwrap();
    assert_eq!(stored["cat"], s("blue"));
    assert_eq!(stored["n"], json!({ "N": "2" }));
    assert_eq!(stored["flag"], json!({ "BOOL": true }));

    // The same edit again: `cat` is no longer "red", so nothing is written.
    let err =
        dynamo::update_item_attributes(handle, table, &key, &changes[..1], &[]).await.unwrap_err();
    assert_eq!(err.kind(), "query");
    assert!(err.to_string().contains("changed or deleted"), "{err}");
    let err =
        dynamo::update_item_attributes(handle, table, &key, &changes[2..], &[]).await.unwrap_err();
    assert!(err.to_string().contains("changed or deleted"), "{err}");

    // A value inside maps and lists is set through its path, under the same condition.
    let numbers = json!({ "M": { "numbers": { "L": [
        { "M": { "sender": s("01"), "on": { "BOOL": false } } },
        { "M": { "sender": s("02") } }
    ] } } });
    let nested = AttributeUpdate {
        name: "service".into(),
        path: serde_json::from_value(json!(["numbers", 1, "sender"])).unwrap(),
        value: s("03"),
        expected: Some(s("02")),
    };
    let service = [update("service", numbers, None)];
    dynamo::update_item_attributes(handle, table, &key, &service, &[]).await.unwrap();
    dynamo::update_item_attributes(handle, table, &key, std::slice::from_ref(&nested), &[])
        .await
        .unwrap();
    let stored = dynamo::get_item(handle, table, &key).await.unwrap().unwrap();
    assert_eq!(stored["service"]["M"]["numbers"]["L"][1], json!({ "M": { "sender": s("03") } }));
    assert_eq!(stored["service"]["M"]["numbers"]["L"][0]["M"]["sender"], s("01"));
    let err =
        dynamo::update_item_attributes(handle, table, &key, &[nested], &[]).await.unwrap_err();
    assert!(err.to_string().contains("changed or deleted"), "{err}");

    check_shifted_lists(handle, table, &key).await;

    // A deleted item is not recreated.
    dynamo::delete_item(handle, table, &key).await.unwrap();
    let recreate = [update("cat", s("x"), None)];
    let err =
        dynamo::update_item_attributes(handle, table, &key, &recreate, &[]).await.unwrap_err();
    assert!(err.to_string().contains("changed or deleted"), "{err}");
    assert!(dynamo::get_item(handle, table, &key).await.unwrap().is_none());

    let err =
        dynamo::update_item_attributes(handle, table, &key, &[update("pk", s("z"), None)], &[])
            .await
            .unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
}

/// A list element removed meanwhile shifts the next one to the edited index. The guard on the
/// whole list as loaded (the app sends one for every list index on an edited path) refuses the
/// write, even though the edited leaf, or an equal element, still holds what was seen.
async fn check_shifted_lists(handle: &DynamoHandle, table: &str, key: &WireItem) {
    let rule = |id: &str| json!({ "M": { "id": s(id), "on": { "BOOL": false } } });
    let rules = json!({ "L": [rule("r1"), rule("r2")] });
    let loaded = [update("rules", rules, None)];
    dynamo::update_item_attributes(handle, table, key, &loaded, &[]).await.unwrap();
    let removed = [update(
        "rules",
        json!({ "L": [rule("r2")] }),
        Some(json!({ "L": [rule("r1"), rule("r2")] })),
    )];
    dynamo::update_item_attributes(handle, table, key, &removed, &[]).await.unwrap();

    let edit = AttributeUpdate {
        name: "rules".into(),
        path: serde_json::from_value(json!([0, "on"])).unwrap(),
        value: json!({ "BOOL": true }),
        expected: Some(json!({ "BOOL": false })),
    };
    let guard = ExpectedValue {
        name: "rules".into(),
        path: vec![],
        value: Some(json!({ "L": [rule("r1"), rule("r2")] })),
    };
    let err = dynamo::update_item_attributes(
        handle,
        table,
        key,
        std::slice::from_ref(&edit),
        std::slice::from_ref(&guard),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("changed or deleted"), "{err}");
    let stored = dynamo::get_item(handle, table, key).await.unwrap().unwrap();
    assert_eq!(stored["rules"], json!({ "L": [rule("r2")] }));

    // The item editor's save is held to the same values.
    let mut overwrite = stored.clone();
    overwrite.insert("rules".into(), json!({ "L": [] }));
    let err = dynamo::put_item(handle, table, &overwrite, PutExpectation::Exists, &[guard])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("changed or deleted"), "{err}");
    let current = ExpectedValue {
        name: "rules".into(),
        path: vec![],
        value: Some(json!({ "L": [rule("r2")] })),
    };
    dynamo::put_item(handle, table, &overwrite, PutExpectation::Exists, &[current]).await.unwrap();
    let stored = dynamo::get_item(handle, table, key).await.unwrap().unwrap();
    assert_eq!(stored["rules"], json!({ "L": [] }));
    eprintln!("checked nested edits against a shifted list");

    // An index in the middle of the path, among equal maps: without `rules[0]`, `rules[1]` is
    // still `{ on: false }` (so even a guard on the element would hold), but it is the other one.
    let off = json!({ "M": { "on": { "BOOL": false } } });
    let first = json!({ "M": { "id": s("a") } });
    let loaded_rules = json!({ "L": [first, off, off] });
    let shifted_rules = json!({ "L": [off, off] });
    let reset = [update("rules", loaded_rules.clone(), Some(json!({ "L": [] })))];
    dynamo::update_item_attributes(handle, table, key, &reset, &[]).await.unwrap();
    let remove = [update("rules", shifted_rules.clone(), Some(loaded_rules.clone()))];
    dynamo::update_item_attributes(handle, table, key, &remove, &[]).await.unwrap();
    let edit = AttributeUpdate {
        name: "rules".into(),
        path: serde_json::from_value(json!([1, "on"])).unwrap(),
        value: json!({ "BOOL": true }),
        expected: Some(json!({ "BOOL": false })),
    };
    let whole = ExpectedValue { name: "rules".into(), path: vec![], value: Some(loaded_rules) };
    let err = dynamo::update_item_attributes(
        handle,
        table,
        key,
        std::slice::from_ref(&edit),
        std::slice::from_ref(&whole),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("changed or deleted"), "{err}");
    let stored = dynamo::get_item(handle, table, key).await.unwrap().unwrap();
    assert_eq!(stored["rules"], shifted_rules);
    eprintln!("checked a mid-path index against a shifted list of equal maps");

    // The edited value is itself a list element. Without `y`, index 1 still holds an "x", but
    // it is the other one, so only the guard on the whole list catches it.
    let tags = |values: &[&str]| json!({ "L": values.iter().map(|v| s(v)).collect::<Vec<_>>() });
    let loaded = [update("tags", tags(&["y", "x", "x", "w"]), None)];
    dynamo::update_item_attributes(handle, table, key, &loaded, &[]).await.unwrap();
    let removed = [update("tags", tags(&["x", "x", "w"]), Some(tags(&["y", "x", "x", "w"])))];
    dynamo::update_item_attributes(handle, table, key, &removed, &[]).await.unwrap();
    let edit = AttributeUpdate {
        name: "tags".into(),
        path: serde_json::from_value(json!([1])).unwrap(),
        value: s("z"),
        expected: Some(s("x")),
    };
    let whole_list = ExpectedValue {
        name: "tags".into(),
        path: vec![],
        value: Some(tags(&["y", "x", "x", "w"])),
    };
    let err = dynamo::update_item_attributes(
        handle,
        table,
        key,
        std::slice::from_ref(&edit),
        std::slice::from_ref(&whole_list),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("changed or deleted"), "{err}");
    let stored = dynamo::get_item(handle, table, key).await.unwrap().unwrap();
    assert_eq!(stored["tags"], tags(&["x", "x", "w"]));
    eprintln!("checked a list element edit against a shifted list of equal values");
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
    dynamo::put_item(handle, table, &odd, PutExpectation::Any, &[]).await.unwrap();
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
        dynamo::put_item(handle, table, &seeded, PutExpectation::NotExists, &[]).await.unwrap();
    }
    check_metadata(handle, table).await;
    check_queries(handle, table).await;
    check_pagination_and_scan(handle, table).await;
    check_items(handle, table).await;
    check_attribute_updates(handle, table).await;
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
