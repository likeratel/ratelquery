use serde::{Deserialize, Serialize};

/// MySQL TLS mode, mapped onto sqlx `MySqlSslMode`.
/// `preferred` and `required` encrypt without verifying the certificate; `verify_ca` checks the
/// chain (against `caCertPath`, or the bundled Mozilla roots when absent); `verify_identity`
/// also checks the host name.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MysqlTlsMode {
    #[default]
    Preferred,
    Required,
    VerifyCa,
    VerifyIdentity,
}

impl MysqlTlsMode {
    pub fn verifies_certificate(self) -> bool {
        matches!(self, MysqlTlsMode::VerifyCa | MysqlTlsMode::VerifyIdentity)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlConnectionConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    /// Kept wide so out-of-range values reach validation instead of failing deserialization.
    pub port: i64,
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Absent means `preferred`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls: Option<MysqlTlsMode>,
    /// PEM file with the CA certificate(s) for `verify_ca` / `verify_identity`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_cert_path: Option<String>,
}

impl MysqlConnectionConfig {
    pub fn tls_mode(&self) -> MysqlTlsMode {
        self.tls.unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DynamoAuth {
    Profile {
        profile: String,
    },
    Keys {
        #[serde(rename = "accessKeyId")]
        access_key_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamoConnectionConfig {
    pub id: String,
    pub name: String,
    pub region: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    pub auth: DynamoAuth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ConnectionConfig {
    #[serde(rename = "mysql")]
    Mysql(MysqlConnectionConfig),
    #[serde(rename = "dynamodb")]
    Dynamodb(DynamoConnectionConfig),
}

impl ConnectionConfig {
    pub fn id(&self) -> &str {
        match self {
            ConnectionConfig::Mysql(c) => &c.id,
            ConnectionConfig::Dynamodb(c) => &c.id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            ConnectionConfig::Mysql(c) => &c.name,
            ConnectionConfig::Dynamodb(c) => &c.name,
        }
    }

    /// Returns a copy with `id` replaced.
    pub fn with_id(&self, id: &str) -> ConnectionConfig {
        match self {
            ConnectionConfig::Mysql(c) => {
                ConnectionConfig::Mysql(MysqlConnectionConfig { id: id.to_string(), ..c.clone() })
            }
            ConnectionConfig::Dynamodb(c) => ConnectionConfig::Dynamodb(DynamoConnectionConfig {
                id: id.to_string(),
                ..c.clone()
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    pub latency_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mysql_config_round_trips_with_kind_tag() {
        let value = json!({
            "kind": "mysql", "id": "a", "name": "local", "host": "127.0.0.1",
            "port": 3307, "user": "dev", "database": "sample"
        });
        let config: ConnectionConfig = serde_json::from_value(value.clone()).unwrap();
        assert!(matches!(&config, ConnectionConfig::Mysql(c) if c.port == 3307));
        assert_eq!(serde_json::to_value(&config).unwrap(), value);
    }

    #[test]
    fn mysql_tls_fields_round_trip() {
        let value = json!({
            "kind": "mysql", "id": "a", "name": "rds", "host": "db.example.com", "port": 3306,
            "user": "app", "tls": "verify_identity", "caCertPath": "/etc/ssl/rds.pem"
        });
        let config: ConnectionConfig = serde_json::from_value(value.clone()).unwrap();
        let ConnectionConfig::Mysql(c) = &config else { panic!("expected mysql") };
        assert_eq!(c.tls_mode(), MysqlTlsMode::VerifyIdentity);
        assert_eq!(serde_json::to_value(&config).unwrap(), value);
        let bad = json!({ "kind": "mysql", "id": "a", "name": "n", "host": "h", "port": 1,
                          "user": "u", "tls": "sometimes" });
        assert!(serde_json::from_value::<ConnectionConfig>(bad).is_err());
    }

    #[test]
    fn dynamo_keys_auth_uses_camel_case() {
        let value = json!({
            "kind": "dynamodb", "id": "b", "name": "ddb", "region": "ap-northeast-2",
            "endpoint": "http://localhost:8000",
            "auth": { "type": "keys", "accessKeyId": "AKIA" }, "color": "#7c9cff"
        });
        let config: ConnectionConfig = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&config).unwrap(), value);
    }

    #[test]
    fn test_result_omits_missing_version() {
        let result = ConnectionTestResult { ok: true, server_version: None, latency_ms: 3 };
        assert_eq!(serde_json::to_value(result).unwrap(), json!({ "ok": true, "latencyMs": 3 }));
    }
}
