//! Maps AWS SDK errors to `AppError` kinds by service error code.

use std::error::Error as StdError;
use std::fmt::Debug;

use aws_credential_types::provider::error::CredentialsError;
use aws_sdk_dynamodb::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};

use crate::connections::DynamoAuth;
use crate::error::AppError;

const CREDENTIAL_CODES: &[&str] = &[
    "UnrecognizedClientException",
    "InvalidSignatureException",
    "SignatureDoesNotMatch",
    "IncompleteSignature",
    "InvalidClientTokenId",
    "MissingAuthenticationToken",
    "ExpiredTokenException",
    "ExpiredToken",
];

/// IAM denied the operation: the credentials are valid, so this is not a `credential` error
/// (which would also drop the cached handle) but a `query` error for this call.
const ACCESS_DENIED_CODE: &str = "AccessDeniedException";

const NETWORK_CODES: &[&str] = &["ServiceUnavailable", "InternalServerError"];

/// Text appended to credential errors telling the user how to fix them.
pub fn credential_hint(auth: &DynamoAuth) -> String {
    match auth {
        DynamoAuth::Profile { profile } => format!(
            "Check the AWS profile \"{profile}\" in ~/.aws/config. If it uses SSO, run \
             `aws sso login --profile {profile}` and retry."
        ),
        DynamoAuth::Keys { .. } => {
            "Check the access key id and secret access key saved for this connection.".to_string()
        }
    }
}

pub fn credential_error(auth: &DynamoAuth, detail: &str) -> AppError {
    AppError::Credential(format!(
        "AWS credentials are missing, expired or were rejected: {detail}. {}",
        credential_hint(auth)
    ))
}

/// Error from resolving credentials up front.
pub fn credentials_resolution_error(auth: &DynamoAuth, err: &CredentialsError) -> AppError {
    credential_error(auth, &DisplayErrorContext(err).to_string())
}

fn has_credentials_source(err: &(dyn StdError + 'static)) -> bool {
    let mut current: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = current {
        if e.downcast_ref::<CredentialsError>().is_some() {
            return true;
        }
        current = e.source();
    }
    false
}

/// Classification of a service error code, independent of the SDK error type (unit tested).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeClass {
    Credential,
    NotFound,
    Network,
    Query,
}

pub fn classify_code(code: &str) -> CodeClass {
    if CREDENTIAL_CODES.contains(&code) {
        CodeClass::Credential
    } else if code == "ResourceNotFoundException" {
        CodeClass::NotFound
    } else if NETWORK_CODES.contains(&code) {
        CodeClass::Network
    } else {
        CodeClass::Query
    }
}

fn service_error(code: &str, message: &str, auth: &DynamoAuth, table: Option<&str>) -> AppError {
    let detail = if message.is_empty() { code.to_string() } else { format!("{code}: {message}") };
    match classify_code(code) {
        CodeClass::Credential => credential_error(auth, &detail),
        CodeClass::NotFound => AppError::NotFound(match table {
            Some(table) => {
                format!("table {table} (or the requested index) does not exist: {detail}")
            }
            None => detail,
        }),
        CodeClass::Network => AppError::Connection(detail),
        CodeClass::Query if code == ACCESS_DENIED_CODE => {
            AppError::Query(format!("Access denied by IAM for this operation: {detail}"))
        }
        CodeClass::Query if code == "ConditionalCheckFailedException" => {
            AppError::Query(format!("the condition check failed: {detail}"))
        }
        CodeClass::Query => AppError::Query(detail),
    }
}

/// Maps any SDK operation error. `table` is used in `not_found` messages.
pub fn map_sdk_error<E, R>(err: &SdkError<E, R>, auth: &DynamoAuth, table: Option<&str>) -> AppError
where
    E: ProvideErrorMetadata + StdError + 'static,
    R: Debug + 'static,
{
    let text = DisplayErrorContext(err).to_string();
    match err {
        SdkError::ServiceError(service) => {
            let inner = service.err();
            match inner.code() {
                Some(code) => service_error(code, inner.message().unwrap_or(""), auth, table),
                None => AppError::Query(text),
            }
        }
        _ if has_credentials_source(err) => credential_error(auth, &text),
        SdkError::ConstructionFailure(_) => AppError::InvalidInput(text),
        _ => AppError::Connection(text),
    }
}

/// True when the SDK reported a failed condition expression.
pub fn is_conditional_check_failed<E, R>(err: &SdkError<E, R>) -> bool
where
    E: ProvideErrorMetadata,
{
    err.as_service_error().and_then(|e| e.code()) == Some("ConditionalCheckFailedException")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> DynamoAuth {
        DynamoAuth::Profile { profile: "dev".into() }
    }

    #[test]
    fn classifies_codes() {
        assert_eq!(classify_code("ExpiredTokenException"), CodeClass::Credential);
        assert_eq!(classify_code("UnrecognizedClientException"), CodeClass::Credential);
        assert_eq!(classify_code("ResourceNotFoundException"), CodeClass::NotFound);
        assert_eq!(classify_code("ValidationException"), CodeClass::Query);
        assert_eq!(classify_code("ProvisionedThroughputExceededException"), CodeClass::Query);
        assert_eq!(classify_code("ConditionalCheckFailedException"), CodeClass::Query);
        assert_eq!(classify_code("ServiceUnavailable"), CodeClass::Network);
        assert_eq!(classify_code("AccessDeniedException"), CodeClass::Query);
    }

    #[test]
    fn access_denied_is_a_query_error() {
        let err = service_error("AccessDeniedException", "not authorized", &profile(), None);
        assert_eq!(err.kind(), "query");
        assert_eq!(
            err.to_string(),
            "Access denied by IAM for this operation: AccessDeniedException: not authorized"
        );
    }

    #[test]
    fn service_errors_carry_kind_and_hint() {
        let err = service_error("ExpiredTokenException", "token expired", &profile(), None);
        assert_eq!(err.kind(), "credential");
        assert!(err.to_string().contains("aws sso login --profile dev"), "{err}");
        let err = service_error("ResourceNotFoundException", "", &profile(), Some("t"));
        assert_eq!(err.kind(), "not_found");
        assert!(err.to_string().contains("table t"));
        let err = service_error("ConditionalCheckFailedException", "failed", &profile(), None);
        assert_eq!(err.kind(), "query");
        assert!(err.to_string().contains("condition check failed"));
        let keys = DynamoAuth::Keys { access_key_id: "AKIA".into() };
        assert!(credential_error(&keys, "x").to_string().contains("secret access key"));
    }

    #[test]
    fn credential_sources_are_detected() {
        let err = CredentialsError::not_loaded("no profile");
        assert!(has_credentials_source(&err));
        let io = std::io::Error::other("refused");
        assert!(!has_credentials_source(&io));
        let mapped = credentials_resolution_error(&profile(), &err);
        assert_eq!(mapped.kind(), "credential");
    }
}
