//! Runs only with `RATELQUERY_TEST_DYNAMODB_ENDPOINT` (e.g. `http://localhost:8000`).

mod common;

use ratelquery_lib::connections::{DynamoAuth, DynamoConnectionConfig, probe_dynamodb};

#[tokio::test]
async fn probes_dynamodb_local_with_static_keys() {
    let Ok(endpoint) = std::env::var("RATELQUERY_TEST_DYNAMODB_ENDPOINT") else {
        common::skipped(
            "live DynamoDB test: RATELQUERY_TEST_DYNAMODB_ENDPOINT is not set. Run \
             `pnpm db:up` and set RATELQUERY_TEST_DYNAMODB_ENDPOINT=http://localhost:8000 \
             to run it.",
        );
        return;
    };
    let config = DynamoConnectionConfig {
        id: String::new(),
        name: "local".into(),
        region: "ap-northeast-2".into(),
        endpoint: Some(endpoint),
        auth: DynamoAuth::Keys { access_key_id: "local".into() },
        color: None,
    };
    let ok = probe_dynamodb(&config, Some("local")).await.unwrap();
    assert!(ok.ok && ok.server_version.is_none());
    assert_eq!(probe_dynamodb(&config, None).await.unwrap_err().kind(), "connection");
    let unreachable =
        DynamoConnectionConfig { endpoint: Some("http://127.0.0.1:1".into()), ..config };
    assert_eq!(probe_dynamodb(&unreachable, Some("local")).await.unwrap_err().kind(), "connection");
}
