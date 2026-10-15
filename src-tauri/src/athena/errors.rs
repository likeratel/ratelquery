//! Maps AWS SDK errors of the Athena, STS and S3 calls to `AppError` kinds.

use std::error::Error as StdError;
use std::fmt::Debug;

use aws_sdk_athena::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};

use crate::connections::AwsAuth;
use crate::dynamo::{credential_error, has_credentials_source};
use crate::error::AppError;

const CREDENTIAL_CODES: &[&str] = &[
    "UnrecognizedClientException",
    "InvalidSignatureException",
    "SignatureDoesNotMatch",
    "IncompleteSignature",
    "InvalidClientTokenId",
    "InvalidAccessKeyId",
    "MissingAuthenticationToken",
    "ExpiredTokenException",
    "ExpiredToken",
];

/// IAM denied the operation for otherwise valid credentials; kept as `query` like DynamoDB so
/// the cached client stays.
const ACCESS_DENIED_CODES: &[&str] = &["AccessDeniedException", "AccessDenied"];

const NETWORK_CODES: &[&str] = &[
    "TooManyRequestsException",
    "ThrottlingException",
    "Throttling",
    "InternalServerException",
    "InternalServerError",
    "ServiceUnavailable",
    "SlowDown",
];

const NOT_FOUND_CODES: &[&str] = &["MetadataException", "ResourceNotFoundException"];

/// Classification of a service error code, independent of the SDK error type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeClass {
    Credential,
    AccessDenied,
    Network,
    InvalidInput,
    NotFound,
    Query,
}

pub fn classify_code(code: &str) -> CodeClass {
    if CREDENTIAL_CODES.contains(&code) {
        CodeClass::Credential
    } else if ACCESS_DENIED_CODES.contains(&code) {
        CodeClass::AccessDenied
    } else if NETWORK_CODES.contains(&code) {
        CodeClass::Network
    } else if code == "InvalidRequestException" {
        CodeClass::InvalidInput
    } else if NOT_FOUND_CODES.contains(&code) {
        CodeClass::NotFound
    } else {
        CodeClass::Query
    }
}

pub fn service_error(code: &str, message: &str, auth: &AwsAuth) -> AppError {
    let detail = if message.is_empty() { code.to_string() } else { format!("{code}: {message}") };
    match classify_code(code) {
        CodeClass::Credential => credential_error(auth, &detail),
        CodeClass::AccessDenied => {
            AppError::Query(format!("Access denied by IAM for this operation: {detail}"))
        }
        CodeClass::Network => AppError::Connection(detail),
        CodeClass::InvalidInput => AppError::InvalidInput(detail),
        CodeClass::NotFound => AppError::NotFound(detail),
        CodeClass::Query => AppError::Query(detail),
    }
}

/// Maps any SDK operation error (Athena, STS or S3).
pub fn map_sdk_error<E, R>(err: &SdkError<E, R>, auth: &AwsAuth) -> AppError
where
    E: ProvideErrorMetadata + StdError + 'static,
    R: Debug + 'static,
{
    let text = DisplayErrorContext(err).to_string();
    match err {
        SdkError::ServiceError(service) => {
            let inner = service.err();
            match inner.code() {
                Some(code) => service_error(code, inner.message().unwrap_or(""), auth),
                None => AppError::Query(text),
            }
        }
        _ if has_credentials_source(err) => credential_error(auth, &text),
        SdkError::ConstructionFailure(_) => AppError::InvalidInput(text),
        _ => AppError::Connection(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> AwsAuth {
        AwsAuth::Profile { profile: "data".into() }
    }

    #[test]
    fn classifies_codes() {
        assert_eq!(classify_code("ExpiredTokenException"), CodeClass::Credential);
        assert_eq!(classify_code("InvalidClientTokenId"), CodeClass::Credential);
        assert_eq!(classify_code("AccessDeniedException"), CodeClass::AccessDenied);
        assert_eq!(classify_code("TooManyRequestsException"), CodeClass::Network);
        assert_eq!(classify_code("InternalServerException"), CodeClass::Network);
        assert_eq!(classify_code("InvalidRequestException"), CodeClass::InvalidInput);
        assert_eq!(classify_code("MetadataException"), CodeClass::NotFound);
        assert_eq!(classify_code("ResourceNotFoundException"), CodeClass::NotFound);
        assert_eq!(classify_code("SessionAlreadyExistsException"), CodeClass::Query);
    }

    #[test]
    fn service_errors_carry_kind_and_hint() {
        let err = service_error("ExpiredToken", "expired", &profile());
        assert_eq!(err.kind(), "credential");
        assert!(err.to_string().contains("aws sso login --profile data"), "{err}");
        let err = service_error("AccessDeniedException", "no", &profile());
        assert_eq!(err.kind(), "query");
        assert!(err.to_string().starts_with("Access denied by IAM for this operation:"), "{err}");
        let err = service_error("InvalidRequestException", "bad workgroup", &profile());
        assert_eq!(
            (err.kind(), err.to_string().as_str()),
            ("invalid_input", "InvalidRequestException: bad workgroup")
        );
        assert_eq!(service_error("MetadataException", "", &profile()).kind(), "not_found");
        assert_eq!(service_error("ThrottlingException", "", &profile()).kind(), "connection");
        assert_eq!(service_error("Other", "", &profile()).kind(), "query");
    }
}
