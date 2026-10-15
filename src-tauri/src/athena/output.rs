//! Where Athena writes result files: workgroup (enforced) -> config -> workgroup -> the console's
//! default bucket. Also creates that default bucket on request.

use aws_sdk_athena::Client;
use aws_sdk_athena::types::WorkGroup;
use aws_sdk_s3::types::{
    BucketLocationConstraint, CreateBucketConfiguration, PublicAccessBlockConfiguration,
};
use aws_types::SdkConfig;

use super::errors::map_sdk_error;
use crate::connections::{AthenaConnectionConfig, AwsAuth};
use crate::error::{AppError, AppResult};

const DEFAULT_BUCKET_PREFIX: &str = "aws-athena-query-results";
/// S3's default region: CreateBucket there takes no `LocationConstraint`.
const S3_DEFAULT_REGION: &str = "us-east-1";
const HTTP_FORBIDDEN: u16 = 403;
const HTTP_NOT_FOUND: u16 = 404;

/// The output settings of a workgroup that matter for the resolution.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkgroupOutput {
    pub enforced: bool,
    pub location: Option<String>,
    /// Athena-managed query results: no S3 location may be passed.
    pub managed: bool,
}

impl WorkgroupOutput {
    pub fn from_sdk(workgroup: Option<&WorkGroup>) -> Self {
        let Some(configuration) = workgroup.and_then(WorkGroup::configuration) else {
            return Self::default();
        };
        Self {
            enforced: configuration.enforce_work_group_configuration().unwrap_or(false),
            location: configuration
                .result_configuration()
                .and_then(|r| r.output_location())
                .filter(|l| !l.trim().is_empty())
                .map(str::to_string),
            managed: configuration
                .managed_query_results_configuration()
                .is_some_and(|m| m.enabled()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutputChoice {
    Location(String),
    Managed,
    DefaultBucket,
}

/// The resolution order of the contract, without any AWS call.
pub fn choose_output(workgroup: &WorkgroupOutput, configured: Option<&str>) -> OutputChoice {
    if workgroup.managed {
        return OutputChoice::Managed;
    }
    let enforced = workgroup.location.as_ref().filter(|_| workgroup.enforced);
    enforced
        .map(String::as_str)
        .or(configured)
        .or(workgroup.location.as_deref())
        .map_or(OutputChoice::DefaultBucket, |l| OutputChoice::Location(l.to_string()))
}

/// Resolved output for queries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedOutput {
    Location(String),
    /// The workgroup stores results itself; queries pass no location.
    Managed,
    /// The default bucket (named here) does not exist.
    MissingBucket(String),
}

impl ResolvedOutput {
    pub fn location(&self) -> Option<&str> {
        match self {
            ResolvedOutput::Location(location) => Some(location),
            _ => None,
        }
    }

    pub fn missing_bucket(&self) -> Option<&str> {
        match self {
            ResolvedOutput::MissingBucket(bucket) => Some(bucket),
            _ => None,
        }
    }

    /// The location to pass to `StartQueryExecution`; a missing bucket is `invalid_input`.
    pub fn for_query(&self) -> AppResult<Option<String>> {
        match self {
            ResolvedOutput::Location(location) => Ok(Some(location.clone())),
            ResolvedOutput::Managed => Ok(None),
            ResolvedOutput::MissingBucket(bucket) => Err(AppError::InvalidInput(format!(
                "The Athena query result bucket {bucket} does not exist. Create it from the \
                 connection dialog (Test) or set an output location for the connection."
            ))),
        }
    }
}

pub fn default_bucket_name(account_id: &str, region: &str) -> String {
    format!("{DEFAULT_BUCKET_PREFIX}-{account_id}-{region}")
}

pub fn bucket_location(bucket: &str) -> String {
    format!("s3://{bucket}/")
}

/// `LocationConstraint` for CreateBucket in `region`.
pub fn location_constraint(region: &str) -> Option<&str> {
    (region != S3_DEFAULT_REGION).then_some(region)
}

/// HeadBucket with `ExpectedBucketOwner` answers 404 when the bucket does not exist and 403
/// when it is not owned by the account (or not readable). Both mean "no usable bucket of ours":
/// the default bucket name is global, so a bucket another account claimed must not be used.
pub fn is_missing_bucket_status(status: Option<u16>) -> bool {
    matches!(status, Some(HTTP_NOT_FOUND | HTTP_FORBIDDEN))
}

pub async fn fetch_workgroup(
    client: &Client,
    name: &str,
    auth: &AwsAuth,
) -> AppResult<WorkgroupOutput> {
    let output = client
        .get_work_group()
        .work_group(name)
        .send()
        .await
        .map_err(|e| map_sdk_error(&e, auth))?;
    Ok(WorkgroupOutput::from_sdk(output.work_group()))
}

async fn account_id(sdk: &SdkConfig, auth: &AwsAuth) -> AppResult<String> {
    let output = aws_sdk_sts::Client::new(sdk)
        .get_caller_identity()
        .send()
        .await
        .map_err(|e| map_sdk_error(&e, auth))?;
    output
        .account()
        .map(str::to_string)
        .ok_or_else(|| AppError::Query("GetCallerIdentity returned no account id".into()))
}

/// Whether `bucket` exists and is owned by `account_id`. 404 / 403 are `false`; any other
/// failure (network, credentials, ...) is an error.
async fn bucket_owned(
    sdk: &SdkConfig,
    bucket: &str,
    account_id: &str,
    auth: &AwsAuth,
) -> AppResult<bool> {
    let request =
        aws_sdk_s3::Client::new(sdk).head_bucket().bucket(bucket).expected_bucket_owner(account_id);
    match request.send().await {
        Ok(_) => Ok(true),
        Err(err) if is_missing_bucket_status(err.raw_response().map(|r| r.status().as_u16())) => {
            Ok(false)
        }
        Err(err) => Err(map_sdk_error(&err, auth)),
    }
}

/// Default bucket name of the caller's account in the connection's region.
pub async fn default_bucket(sdk: &SdkConfig, config: &AthenaConnectionConfig) -> AppResult<String> {
    Ok(default_bucket_name(&account_id(sdk, &config.auth).await?, &config.region))
}

/// Resolves the output location of `config` (GetWorkGroup, then STS / HeadBucket only for the
/// default bucket, checked to be owned by the caller's account). Nothing is created.
pub async fn resolve_output(
    sdk: &SdkConfig,
    client: &Client,
    config: &AthenaConnectionConfig,
) -> AppResult<ResolvedOutput> {
    let workgroup = fetch_workgroup(client, config.workgroup_name(), &config.auth).await?;
    match choose_output(&workgroup, config.output_location.as_deref()) {
        OutputChoice::Location(location) => Ok(ResolvedOutput::Location(location)),
        OutputChoice::Managed => Ok(ResolvedOutput::Managed),
        OutputChoice::DefaultBucket => {
            let account = account_id(sdk, &config.auth).await?;
            let bucket = default_bucket_name(&account, &config.region);
            if bucket_owned(sdk, &bucket, &account, &config.auth).await? {
                Ok(ResolvedOutput::Location(bucket_location(&bucket)))
            } else {
                Ok(ResolvedOutput::MissingBucket(bucket))
            }
        }
    }
}

/// Creates `bucket` (which must be the default bucket of the account and region) and blocks
/// all public access on it. Returns its `s3://<bucket>/` location.
pub async fn create_output_bucket(
    sdk: &SdkConfig,
    config: &AthenaConnectionConfig,
    bucket: &str,
) -> AppResult<String> {
    let expected = default_bucket(sdk, config).await?;
    if bucket.trim() != expected {
        return Err(AppError::InvalidInput(format!(
            "Only the default Athena result bucket {expected} can be created here, not {bucket}"
        )));
    }
    let s3 = aws_sdk_s3::Client::new(sdk);
    let request = s3.create_bucket().bucket(&expected);
    let request = match location_constraint(&config.region) {
        Some(region) => request.create_bucket_configuration(
            CreateBucketConfiguration::builder()
                .location_constraint(BucketLocationConstraint::from(region))
                .build(),
        ),
        None => request,
    };
    match request.send().await {
        Ok(_) => {}
        Err(err) if err.as_service_error().is_some_and(|e| e.is_bucket_already_owned_by_you()) => {}
        Err(err) => return Err(map_sdk_error(&err, &config.auth)),
    }
    block_public_access(&s3, &expected, &config.auth).await?;
    Ok(bucket_location(&expected))
}

async fn block_public_access(
    s3: &aws_sdk_s3::Client,
    bucket: &str,
    auth: &AwsAuth,
) -> AppResult<()> {
    let block = PublicAccessBlockConfiguration::builder()
        .block_public_acls(true)
        .ignore_public_acls(true)
        .block_public_policy(true)
        .restrict_public_buckets(true)
        .build();
    s3.put_public_access_block()
        .bucket(bucket)
        .public_access_block_configuration(block)
        .send()
        .await
        .map(|_| ())
        .map_err(|e| {
            let mapped = map_sdk_error(&e, auth);
            let message = format!(
                "The bucket {bucket} was created, but blocking public access failed: {mapped}"
            );
            match mapped {
                AppError::Credential(_) => AppError::Credential(message),
                AppError::Connection(_) => AppError::Connection(message),
                _ => AppError::Query(message),
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_athena::types::{
        ManagedQueryResultsConfiguration, ResultConfiguration, WorkGroupConfiguration,
    };

    fn workgroup(enforced: bool, location: Option<&str>) -> WorkgroupOutput {
        WorkgroupOutput { enforced, location: location.map(str::to_string), managed: false }
    }

    fn location(l: &str) -> OutputChoice {
        OutputChoice::Location(l.into())
    }

    #[test]
    fn enforced_workgroup_location_wins() {
        let wg = workgroup(true, Some("s3://wg/"));
        assert_eq!(choose_output(&wg, Some("s3://mine/")), location("s3://wg/"));
        assert_eq!(choose_output(&wg, None), location("s3://wg/"));
    }

    #[test]
    fn config_wins_over_unenforced_workgroup() {
        let wg = workgroup(false, Some("s3://wg/"));
        assert_eq!(choose_output(&wg, Some("s3://mine/")), location("s3://mine/"));
        assert_eq!(choose_output(&wg, None), location("s3://wg/"));
        // Enforced without a location of its own falls through to the config.
        let bare = workgroup(true, None);
        assert_eq!(choose_output(&bare, Some("s3://mine/")), location("s3://mine/"));
    }

    #[test]
    fn falls_back_to_the_default_bucket_and_respects_managed_results() {
        assert_eq!(choose_output(&workgroup(false, None), None), OutputChoice::DefaultBucket);
        assert_eq!(choose_output(&workgroup(true, None), None), OutputChoice::DefaultBucket);
        let managed = WorkgroupOutput { managed: true, ..workgroup(false, None) };
        assert_eq!(choose_output(&managed, Some("s3://mine/")), OutputChoice::Managed);
    }

    #[test]
    fn reads_workgroup_settings_from_the_sdk_shape() {
        assert_eq!(WorkgroupOutput::from_sdk(None), WorkgroupOutput::default());
        let configured = WorkGroup::builder()
            .name("analysts")
            .configuration(
                WorkGroupConfiguration::builder()
                    .enforce_work_group_configuration(true)
                    .result_configuration(
                        ResultConfiguration::builder().output_location("s3://wg/out/").build(),
                    )
                    .build(),
            )
            .build()
            .unwrap();
        assert_eq!(
            WorkgroupOutput::from_sdk(Some(&configured)),
            workgroup(true, Some("s3://wg/out/"))
        );
        let managed = WorkGroup::builder()
            .name("m")
            .configuration(
                WorkGroupConfiguration::builder()
                    .managed_query_results_configuration(
                        ManagedQueryResultsConfiguration::builder().enabled(true).build(),
                    )
                    .result_configuration(
                        ResultConfiguration::builder().output_location(" ").build(),
                    )
                    .build(),
            )
            .build()
            .unwrap();
        let read = WorkgroupOutput::from_sdk(Some(&managed));
        assert!(read.managed && !read.enforced && read.location.is_none(), "{read:?}");
    }

    #[test]
    fn default_bucket_names_and_regions() {
        assert_eq!(
            default_bucket_name("123456789012", "ap-northeast-2"),
            "aws-athena-query-results-123456789012-ap-northeast-2"
        );
        assert_eq!(bucket_location("b-1"), "s3://b-1/");
        assert_eq!(location_constraint("us-east-1"), None);
        assert_eq!(location_constraint("eu-west-1"), Some("eu-west-1"));
        assert!(is_missing_bucket_status(Some(404)));
        assert!(is_missing_bucket_status(Some(403)), "not owned by the account");
        for other in [Some(301), Some(400), Some(500), Some(200), None] {
            assert!(!is_missing_bucket_status(other), "{other:?}");
        }
    }

    #[test]
    fn missing_bucket_blocks_queries_only() {
        let missing = ResolvedOutput::MissingBucket("b".into());
        let err = missing.for_query().unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("b does not exist"), "{err}");
        assert_eq!((missing.location(), missing.missing_bucket()), (None, Some("b")));
        assert_eq!(ResolvedOutput::Managed.for_query().unwrap(), None);
        let at = ResolvedOutput::Location("s3://x/".into());
        assert_eq!(at.for_query().unwrap().as_deref(), Some("s3://x/"));
        assert_eq!(at.location(), Some("s3://x/"));
    }
}
