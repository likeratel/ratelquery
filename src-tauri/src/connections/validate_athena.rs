//! Validation of Athena connection configs.

use super::model::AthenaConnectionConfig;
use super::validate::{non_empty, require, validate_auth, validate_color};
use crate::error::{AppError, AppResult};

const S3_SCHEME: &str = "s3://";
const MIN_BUCKET_LEN: usize = 3;
const MAX_BUCKET_LEN: usize = 63;

fn is_bucket_name(bucket: &str) -> bool {
    (MIN_BUCKET_LEN..=MAX_BUCKET_LEN).contains(&bucket.len())
        && bucket
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// `s3://<bucket>` or `s3://<bucket>/<prefix>` with a valid bucket name, returned trimmed and
/// ending in `/`.
pub fn normalize_output_location(location: &str) -> AppResult<String> {
    let location = location.trim();
    let invalid = |why: &str| {
        AppError::InvalidInput(format!(
            "outputLocation {why}; expected s3://bucket/ or s3://bucket/prefix/, got {location}"
        ))
    };
    let rest = location.strip_prefix(S3_SCHEME).ok_or_else(|| invalid("must start with s3://"))?;
    let bucket = rest.split('/').next().unwrap_or_default();
    if !is_bucket_name(bucket) {
        return Err(invalid(
            "needs a bucket name of 3-63 lowercase letters, digits, dots or hyphens",
        ));
    }
    if location.ends_with('/') { Ok(location.to_string()) } else { Ok(format!("{location}/")) }
}

fn validate_workgroup(workgroup: &Option<String>) -> AppResult<Option<String>> {
    match workgroup {
        None => Ok(None),
        Some(name) => {
            require(name, "workgroup")?;
            Ok(Some(name.trim().to_string()))
        }
    }
}

pub fn validate_athena(c: &AthenaConnectionConfig) -> AppResult<AthenaConnectionConfig> {
    require(&c.name, "name")?;
    require(&c.region, "region")?;
    let output_location =
        non_empty(&c.output_location).map(|l| normalize_output_location(&l)).transpose()?;
    Ok(AthenaConnectionConfig {
        id: c.id.trim().to_string(),
        name: c.name.trim().to_string(),
        region: c.region.trim().to_string(),
        auth: validate_auth(&c.auth)?,
        workgroup: validate_workgroup(&c.workgroup)?,
        output_location,
        database: non_empty(&c.database),
        color: validate_color(&c.color)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{AwsAuth, ConnectionConfig, same_target, validate_config};

    fn athena() -> AthenaConnectionConfig {
        AthenaConnectionConfig {
            id: " a ".into(),
            name: " lake ".into(),
            region: " ap-northeast-2 ".into(),
            auth: AwsAuth::Profile { profile: " data ".into() },
            workgroup: None,
            output_location: None,
            database: Some("  ".into()),
            color: None,
        }
    }

    fn check(c: AthenaConnectionConfig) -> AppResult<AthenaConnectionConfig> {
        match validate_config(&ConnectionConfig::Athena(c))? {
            ConnectionConfig::Athena(c) => Ok(c),
            other => panic!("expected athena, got {other:?}"),
        }
    }

    #[test]
    fn normalizes_athena_config() {
        let c = check(athena()).unwrap();
        assert_eq!(
            (c.id.as_str(), c.name.as_str(), c.region.as_str()),
            ("a", "lake", "ap-northeast-2")
        );
        assert_eq!(c.auth, AwsAuth::Profile { profile: "data".into() });
        assert_eq!((c.database, c.workgroup, c.output_location), (None, None, None));
        let full = AthenaConnectionConfig {
            workgroup: Some(" analysts ".into()),
            output_location: Some(" s3://my-bucket/results ".into()),
            database: Some(" sales ".into()),
            ..athena()
        };
        let c = check(full).unwrap();
        assert_eq!(c.workgroup.as_deref(), Some("analysts"));
        assert_eq!(c.output_location.as_deref(), Some("s3://my-bucket/results/"));
        assert_eq!(c.database.as_deref(), Some("sales"));
        let blank_location =
            AthenaConnectionConfig { output_location: Some(" ".into()), ..athena() };
        assert_eq!(check(blank_location).unwrap().output_location, None);
    }

    #[test]
    fn rejects_bad_athena_fields() {
        let cases = [
            AthenaConnectionConfig { name: " ".into(), ..athena() },
            AthenaConnectionConfig { region: String::new(), ..athena() },
            AthenaConnectionConfig { auth: AwsAuth::Profile { profile: " ".into() }, ..athena() },
            AthenaConnectionConfig {
                auth: AwsAuth::Keys { access_key_id: String::new() },
                ..athena()
            },
            AthenaConnectionConfig { workgroup: Some("  ".into()), ..athena() },
            AthenaConnectionConfig { color: Some("red".into()), ..athena() },
            AthenaConnectionConfig { output_location: Some("bucket/x".into()), ..athena() },
        ];
        for case in cases {
            let label = format!("{case:?}");
            assert_eq!(check(case).unwrap_err().kind(), "invalid_input", "{label}");
        }
    }

    #[test]
    fn output_location_format() {
        for (input, expected) in [
            ("s3://abc", "s3://abc/"),
            ("s3://abc/", "s3://abc/"),
            ("s3://my.bucket-1/a/b", "s3://my.bucket-1/a/b/"),
            ("s3://my.bucket-1/a/b/", "s3://my.bucket-1/a/b/"),
        ] {
            assert_eq!(normalize_output_location(input).unwrap(), expected, "{input}");
        }
        let long = format!("s3://{}", "a".repeat(64));
        let longest = format!("s3://{}", "a".repeat(63));
        assert!(normalize_output_location(&longest).is_ok());
        for bad in [
            "abc",
            "S3://abc",
            "s3://",
            "s3:///prefix",
            "s3://ab",
            "s3://Bucket",
            "s3://bu_cket",
            "https://abc",
            long.as_str(),
        ] {
            assert_eq!(
                normalize_output_location(bad).unwrap_err().kind(),
                "invalid_input",
                "{bad}"
            );
        }
    }

    #[test]
    fn same_target_compares_region_and_auth() {
        let base = ConnectionConfig::Athena(check(athena()).unwrap());
        let ConnectionConfig::Athena(a) = &base else { unreachable!() };
        let cosmetic = AthenaConnectionConfig {
            name: "x".into(),
            workgroup: Some("other".into()),
            output_location: Some("s3://abc/".into()),
            database: Some("db".into()),
            color: Some("#000000".into()),
            ..a.clone()
        };
        assert!(same_target(&base, &ConnectionConfig::Athena(cosmetic)));
        for changed in [
            AthenaConnectionConfig { region: "us-east-1".into(), ..a.clone() },
            AthenaConnectionConfig {
                auth: AwsAuth::Profile { profile: "other".into() },
                ..a.clone()
            },
            AthenaConnectionConfig {
                auth: AwsAuth::Keys { access_key_id: "AKIA".into() },
                ..a.clone()
            },
        ] {
            assert!(!same_target(&base, &ConnectionConfig::Athena(changed)));
        }
    }
}
