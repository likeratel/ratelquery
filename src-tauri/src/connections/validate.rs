use std::path::Path;

use super::model::{ConnectionConfig, DynamoAuth, DynamoConnectionConfig, MysqlConnectionConfig};
use crate::error::{AppError, AppResult};

const ENDPOINT_SCHEMES: [&str; 2] = ["http", "https"];

const MIN_PORT: i64 = 1;
const MAX_PORT: i64 = 65_535;

fn require(value: &str, field: &str) -> AppResult<()> {
    if value.trim().is_empty() {
        return Err(AppError::InvalidInput(format!("{field} must not be empty")));
    }
    Ok(())
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// `#rrggbb`, or nothing.
fn validate_color(color: &Option<String>) -> AppResult<Option<String>> {
    let Some(color) = non_empty(color) else { return Ok(None) };
    let hex = color.strip_prefix('#').unwrap_or("");
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(format!("color must look like #7c9cff, got {color}")));
    }
    Ok(Some(color))
}

/// An absolute `http(s)://host[:port]` URL, or nothing.
fn validate_endpoint(endpoint: &Option<String>) -> AppResult<Option<String>> {
    let Some(endpoint) = non_empty(endpoint) else { return Ok(None) };
    let invalid = |why: &str| AppError::InvalidInput(format!("endpoint {why}: {endpoint}"));
    let parsed = url::Url::parse(&endpoint).map_err(|e| invalid(&format!("is not a URL ({e})")))?;
    if !ENDPOINT_SCHEMES.contains(&parsed.scheme()) {
        return Err(invalid("must start with http:// or https://"));
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(invalid("needs a host"));
    }
    Ok(Some(endpoint))
}

/// `caCertPath` is an absolute path and only used by the verifying TLS modes.
fn validate_ca_path(c: &MysqlConnectionConfig) -> AppResult<Option<String>> {
    let Some(path) = non_empty(&c.ca_cert_path) else { return Ok(None) };
    if !Path::new(&path).is_absolute() {
        return Err(AppError::InvalidInput(format!("caCertPath must be absolute: {path}")));
    }
    if !c.tls_mode().verifies_certificate() {
        return Err(AppError::InvalidInput(
            "caCertPath needs tls verify_ca or verify_identity".into(),
        ));
    }
    Ok(Some(path))
}

fn validate_mysql(c: &MysqlConnectionConfig) -> AppResult<MysqlConnectionConfig> {
    require(&c.name, "name")?;
    require(&c.host, "host")?;
    if !(MIN_PORT..=MAX_PORT).contains(&c.port) {
        return Err(AppError::InvalidInput(format!(
            "port must be between {MIN_PORT} and {MAX_PORT}"
        )));
    }
    Ok(MysqlConnectionConfig {
        id: c.id.trim().to_string(),
        name: c.name.trim().to_string(),
        host: c.host.trim().to_string(),
        port: c.port,
        user: c.user.clone(),
        database: non_empty(&c.database),
        color: validate_color(&c.color)?,
        tls: c.tls,
        ca_cert_path: validate_ca_path(c)?,
    })
}

fn validate_auth(auth: &DynamoAuth) -> AppResult<DynamoAuth> {
    match auth {
        DynamoAuth::Profile { profile } => {
            require(profile, "profile")?;
            Ok(DynamoAuth::Profile { profile: profile.trim().to_string() })
        }
        DynamoAuth::Keys { access_key_id } => {
            require(access_key_id, "accessKeyId")?;
            Ok(DynamoAuth::Keys { access_key_id: access_key_id.trim().to_string() })
        }
    }
}

fn validate_dynamo(c: &DynamoConnectionConfig) -> AppResult<DynamoConnectionConfig> {
    require(&c.name, "name")?;
    require(&c.region, "region")?;
    Ok(DynamoConnectionConfig {
        id: c.id.trim().to_string(),
        name: c.name.trim().to_string(),
        region: c.region.trim().to_string(),
        endpoint: validate_endpoint(&c.endpoint)?,
        auth: validate_auth(&c.auth)?,
        color: validate_color(&c.color)?,
    })
}

/// Validates a config and returns a normalized copy (trimmed, empty optionals removed).
pub fn validate_config(config: &ConnectionConfig) -> AppResult<ConnectionConfig> {
    match config {
        ConnectionConfig::Mysql(c) => validate_mysql(c).map(ConnectionConfig::Mysql),
        ConnectionConfig::Dynamodb(c) => validate_dynamo(c).map(ConnectionConfig::Dynamodb),
    }
}

/// True when both configs send the stored secret to the same place: same kind and
/// host/port/user/TLS settings (MySQL) or endpoint/region/auth identity (DynamoDB). Compare
/// validated configs.
pub fn same_target(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    match (a, b) {
        (ConnectionConfig::Mysql(a), ConnectionConfig::Mysql(b)) => {
            a.host.eq_ignore_ascii_case(&b.host)
                && a.port == b.port
                && a.user == b.user
                && a.tls_mode() == b.tls_mode()
                && a.ca_cert_path == b.ca_cert_path
        }
        (ConnectionConfig::Dynamodb(a), ConnectionConfig::Dynamodb(b)) => {
            a.endpoint == b.endpoint && a.region == b.region && a.auth == b.auth
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mysql() -> MysqlConnectionConfig {
        MysqlConnectionConfig {
            id: String::new(),
            name: " local ".into(),
            host: "127.0.0.1".into(),
            port: 3306,
            user: "dev".into(),
            database: Some("  ".into()),
            color: None,
            tls: None,
            ca_cert_path: None,
        }
    }

    fn dynamo(auth: DynamoAuth) -> DynamoConnectionConfig {
        DynamoConnectionConfig {
            id: String::new(),
            name: "ddb".into(),
            region: "ap-northeast-2".into(),
            endpoint: Some(String::new()),
            auth,
            color: None,
        }
    }

    fn kind_of(result: AppResult<ConnectionConfig>) -> &'static str {
        result.err().map(|e| e.kind()).unwrap_or("ok")
    }

    #[test]
    fn normalizes_mysql_config() {
        let ConnectionConfig::Mysql(c) =
            validate_config(&ConnectionConfig::Mysql(mysql())).unwrap()
        else {
            panic!("expected mysql");
        };
        assert_eq!(c.name, "local");
        assert_eq!(c.database, None);
    }

    #[test]
    fn rejects_bad_mysql_fields() {
        let cases = [
            MysqlConnectionConfig { name: " ".into(), ..mysql() },
            MysqlConnectionConfig { host: String::new(), ..mysql() },
            MysqlConnectionConfig { port: 0, ..mysql() },
            MysqlConnectionConfig { port: 65_536, ..mysql() },
        ];
        for case in cases {
            assert_eq!(kind_of(validate_config(&ConnectionConfig::Mysql(case))), "invalid_input");
        }
        let edge = MysqlConnectionConfig { port: 65_535, ..mysql() };
        assert_eq!(kind_of(validate_config(&ConnectionConfig::Mysql(edge))), "ok");
    }

    #[test]
    fn validates_color_format() {
        for ok in ["#7c9cff", "#ABCDEF", " #000000 "] {
            let c = MysqlConnectionConfig { color: Some(ok.into()), ..mysql() };
            assert_eq!(kind_of(validate_config(&ConnectionConfig::Mysql(c))), "ok", "{ok}");
        }
        for bad in ["7c9cff", "#7c9cf", "#7c9cffa", "#gggggg", "red", "url(x)"] {
            let c = MysqlConnectionConfig { color: Some(bad.into()), ..mysql() };
            assert_eq!(kind_of(validate_config(&ConnectionConfig::Mysql(c))), "invalid_input");
        }
    }

    #[test]
    fn validates_tls_ca_path() {
        use crate::connections::MysqlTlsMode;
        let with = |tls, path: &str| MysqlConnectionConfig {
            tls,
            ca_cert_path: Some(path.into()),
            ..mysql()
        };
        let check = |c| kind_of(validate_config(&ConnectionConfig::Mysql(c)));
        assert_eq!(check(with(Some(MysqlTlsMode::VerifyCa), "/etc/ca.pem")), "ok");
        assert_eq!(
            check(with(Some(MysqlTlsMode::VerifyIdentity), "relative.pem")),
            "invalid_input"
        );
        assert_eq!(check(with(Some(MysqlTlsMode::Required), "/etc/ca.pem")), "invalid_input");
        assert_eq!(check(with(None, "/etc/ca.pem")), "invalid_input");
        assert_eq!(check(with(None, "  ")), "ok");
        let verify = MysqlConnectionConfig { tls: Some(MysqlTlsMode::VerifyIdentity), ..mysql() };
        assert_eq!(check(verify), "ok", "system roots are used without caCertPath");
    }

    #[test]
    fn validates_dynamo_endpoint_url() {
        let base = dynamo(DynamoAuth::Profile { profile: "default".into() });
        let with = |e: &str| DynamoConnectionConfig { endpoint: Some(e.into()), ..base.clone() };
        let check = |c| kind_of(validate_config(&ConnectionConfig::Dynamodb(c)));
        assert_eq!(check(with("http://localhost:8000")), "ok");
        assert_eq!(check(with("https://dynamodb.ap-northeast-2.amazonaws.com")), "ok");
        for bad in ["localhost:8000", "file:///etc/passwd", "ftp://h", "http://", "not a url"] {
            assert_eq!(check(with(bad)), "invalid_input", "{bad}");
        }
    }

    #[test]
    fn same_target_compares_destination_fields() {
        let base = validate_config(&ConnectionConfig::Mysql(mysql())).unwrap();
        let ConnectionConfig::Mysql(m) = &base else { panic!() };
        let renamed = ConnectionConfig::Mysql(MysqlConnectionConfig {
            name: "other".into(),
            host: "127.0.0.1".to_uppercase(),
            ..m.clone()
        });
        assert!(same_target(&base, &renamed));
        for changed in [
            MysqlConnectionConfig { host: "evil.example".into(), ..m.clone() },
            MysqlConnectionConfig { port: 3307, ..m.clone() },
            MysqlConnectionConfig { user: "root".into(), ..m.clone() },
        ] {
            assert!(!same_target(&base, &ConnectionConfig::Mysql(changed)));
        }
        let d = dynamo(DynamoAuth::Keys { access_key_id: "AKIA".into() });
        let dyn_base = ConnectionConfig::Dynamodb(d.clone());
        let moved =
            DynamoConnectionConfig { endpoint: Some("http://evil:8000".into()), ..d.clone() };
        assert!(!same_target(&dyn_base, &ConnectionConfig::Dynamodb(moved)));
        let rekeyed = DynamoConnectionConfig {
            auth: DynamoAuth::Keys { access_key_id: "AKIB".into() },
            ..d.clone()
        };
        assert!(!same_target(&dyn_base, &ConnectionConfig::Dynamodb(rekeyed)));
        assert!(!same_target(&dyn_base, &base));
    }

    #[test]
    fn rejects_bad_dynamo_fields() {
        let ok = dynamo(DynamoAuth::Profile { profile: "default".into() });
        assert_eq!(kind_of(validate_config(&ConnectionConfig::Dynamodb(ok.clone()))), "ok");
        let cases = [
            DynamoConnectionConfig { region: " ".into(), ..ok.clone() },
            DynamoConnectionConfig { name: String::new(), ..ok.clone() },
            dynamo(DynamoAuth::Profile { profile: String::new() }),
            dynamo(DynamoAuth::Keys { access_key_id: " ".into() }),
        ];
        for case in cases {
            assert_eq!(
                kind_of(validate_config(&ConnectionConfig::Dynamodb(case))),
                "invalid_input"
            );
        }
    }

    #[test]
    fn drops_empty_endpoint() {
        let input = dynamo(DynamoAuth::Keys { access_key_id: "AKIA".into() });
        let ConnectionConfig::Dynamodb(c) =
            validate_config(&ConnectionConfig::Dynamodb(input)).unwrap()
        else {
            panic!("expected dynamo");
        };
        assert_eq!(c.endpoint, None);
    }
}
