use serde::{Deserialize, Serialize};

use crate::athena::AthenaTestInfo;

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

pub const DEFAULT_SSH_PORT: i64 = 22;

fn default_ssh_port() -> i64 {
    DEFAULT_SSH_PORT
}

/// How the SSH tunnel authenticates. The password (`password`) or key passphrase (`key`) is
/// kept in the secret store under `<connection id>:ssh`, never in the config.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SshAuth {
    /// Every key the SSH agent (`SSH_AUTH_SOCK`) offers.
    #[default]
    Agent,
    /// An OpenSSH private key file.
    Key {
        #[serde(rename = "keyPath")]
        key_path: String,
    },
    Password,
}

/// SSH bastion a MySQL connection is tunnelled through. The MySQL `host`/`port` are then the
/// address as seen from the bastion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    /// Kept wide so out-of-range values reach validation instead of failing deserialization.
    #[serde(default = "default_ssh_port")]
    pub port: i64,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
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
    /// Tunnel through this SSH bastion; absent means a direct connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConfig>,
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

/// AWS authentication shared by the AWS connection kinds (DynamoDB, Athena).
pub type AwsAuth = DynamoAuth;

/// Workgroup used when an Athena config names none.
pub const DEFAULT_ATHENA_WORKGROUP: &str = "primary";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AthenaConnectionConfig {
    pub id: String,
    pub name: String,
    pub region: String,
    pub auth: AwsAuth,
    /// Absent means [`DEFAULT_ATHENA_WORKGROUP`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workgroup: Option<String>,
    /// `s3://bucket/[prefix/]`; absent means the workgroup's or the default bucket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_location: Option<String>,
    /// Default database of new query tabs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl AthenaConnectionConfig {
    pub fn workgroup_name(&self) -> &str {
        self.workgroup.as_deref().unwrap_or(DEFAULT_ATHENA_WORKGROUP)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ConnectionConfig {
    #[serde(rename = "mysql")]
    Mysql(MysqlConnectionConfig),
    #[serde(rename = "dynamodb")]
    Dynamodb(DynamoConnectionConfig),
    #[serde(rename = "athena")]
    Athena(AthenaConnectionConfig),
}

impl ConnectionConfig {
    pub fn id(&self) -> &str {
        match self {
            ConnectionConfig::Mysql(c) => &c.id,
            ConnectionConfig::Dynamodb(c) => &c.id,
            ConnectionConfig::Athena(c) => &c.id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            ConnectionConfig::Mysql(c) => &c.name,
            ConnectionConfig::Dynamodb(c) => &c.name,
            ConnectionConfig::Athena(c) => &c.name,
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
            ConnectionConfig::Athena(c) => {
                ConnectionConfig::Athena(AthenaConnectionConfig { id: id.to_string(), ..c.clone() })
            }
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
    /// Workgroup and output location; set only for Athena configs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub athena: Option<AthenaTestInfo>,
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
    fn mysql_ssh_config_round_trips() {
        let value = json!({
            "kind": "mysql", "id": "a", "name": "prod", "host": "10.0.0.5", "port": 3306,
            "user": "app",
            "ssh": { "host": "bastion.example.com", "port": 2222, "user": "ec2-user",
                     "auth": { "type": "key", "keyPath": "/home/me/.ssh/id_ed25519" } }
        });
        let config: ConnectionConfig = serde_json::from_value(value.clone()).unwrap();
        let ConnectionConfig::Mysql(c) = &config else { panic!("expected mysql") };
        let ssh = c.ssh.as_ref().unwrap();
        assert_eq!(ssh.auth, SshAuth::Key { key_path: "/home/me/.ssh/id_ed25519".into() });
        assert_eq!(serde_json::to_value(&config).unwrap(), value);

        for (auth, expected) in [
            (json!({ "type": "agent" }), SshAuth::Agent),
            (json!({ "type": "password" }), SshAuth::Password),
        ] {
            let ssh: SshConfig = serde_json::from_value(
                json!({ "host": "b", "port": 22, "user": "u", "auth": auth }),
            )
            .unwrap();
            assert_eq!(ssh.auth, expected);
        }
        let defaults: SshConfig =
            serde_json::from_value(json!({ "host": "b", "user": "u" })).unwrap();
        assert_eq!((defaults.port, defaults.auth), (DEFAULT_SSH_PORT, SshAuth::Agent));
        let bad = json!({ "host": "b", "user": "u", "auth": { "type": "kerberos" } });
        assert!(serde_json::from_value::<SshConfig>(bad).is_err());
        let no_path = json!({ "host": "b", "user": "u", "auth": { "type": "key" } });
        assert!(serde_json::from_value::<SshConfig>(no_path).is_err());
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
        let result =
            ConnectionTestResult { ok: true, server_version: None, latency_ms: 3, athena: None };
        assert_eq!(serde_json::to_value(result).unwrap(), json!({ "ok": true, "latencyMs": 3 }));
    }

    #[test]
    fn test_result_carries_athena_info() {
        let athena = AthenaTestInfo {
            workgroup: "primary".into(),
            output_location: None,
            missing_bucket: Some("aws-athena-query-results-1-us-east-1".into()),
        };
        let result = ConnectionTestResult {
            ok: true,
            server_version: None,
            latency_ms: 3,
            athena: Some(athena),
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "ok": true, "latencyMs": 3, "athena": {
                "workgroup": "primary", "outputLocation": null,
                "missingBucket": "aws-athena-query-results-1-us-east-1" } })
        );
    }

    #[test]
    fn athena_config_round_trips() {
        let value = json!({
            "kind": "athena", "id": "c", "name": "lake", "region": "ap-northeast-2",
            "auth": { "type": "profile", "profile": "data" }, "workgroup": "analysts",
            "outputLocation": "s3://bucket/results/", "database": "sales", "color": "#7c9cff"
        });
        let config: ConnectionConfig = serde_json::from_value(value.clone()).unwrap();
        let ConnectionConfig::Athena(c) = &config else { panic!("expected athena") };
        assert_eq!(c.workgroup_name(), "analysts");
        assert_eq!(serde_json::to_value(&config).unwrap(), value);

        let minimal = json!({
            "kind": "athena", "id": "c", "name": "lake", "region": "us-east-1",
            "auth": { "type": "keys", "accessKeyId": "AKIA" }
        });
        let config: ConnectionConfig = serde_json::from_value(minimal.clone()).unwrap();
        let ConnectionConfig::Athena(c) = &config else { panic!("expected athena") };
        assert_eq!(c.workgroup_name(), DEFAULT_ATHENA_WORKGROUP);
        assert_eq!(serde_json::to_value(&config).unwrap(), minimal);
        assert_eq!(config.with_id("d").id(), "d");
    }
}
