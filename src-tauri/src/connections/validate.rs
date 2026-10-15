use super::model::{ConnectionConfig, DynamoAuth, DynamoConnectionConfig, MysqlConnectionConfig};
use crate::error::{AppError, AppResult};

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
        color: non_empty(&c.color),
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
        endpoint: non_empty(&c.endpoint),
        auth: validate_auth(&c.auth)?,
        color: non_empty(&c.color),
    })
}

/// Validates a config and returns a normalized copy (trimmed, empty optionals removed).
pub fn validate_config(config: &ConnectionConfig) -> AppResult<ConnectionConfig> {
    match config {
        ConnectionConfig::Mysql(c) => validate_mysql(c).map(ConnectionConfig::Mysql),
        ConnectionConfig::Dynamodb(c) => validate_dynamo(c).map(ConnectionConfig::Dynamodb),
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
