use serde::Serialize;

/// Error type crossing the IPC boundary. Every variant serializes to
/// `{ kind, message }` so the frontend can branch on `kind` without parsing text.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Connection(String),
    #[error("{0}")]
    Query(String),
    #[error("{0}")]
    Credential(String),
    #[error("{0}")]
    Io(String),
    /// SSH tunnel failure other than the host key: unreachable bastion, authentication
    /// rejected, forward refused. The message names the step.
    #[error("{0}")]
    Ssh(String),
    /// The bastion's host key is unknown or changed. See `ssh::known_hosts` for the message
    /// format.
    #[error("{0}")]
    SshHostKey(String),
}

#[derive(Serialize)]
struct SerializedError<'a> {
    kind: &'static str,
    message: &'a str,
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::InvalidInput(_) => "invalid_input",
            AppError::NotFound(_) => "not_found",
            AppError::Connection(_) => "connection",
            AppError::Query(_) => "query",
            AppError::Credential(_) => "credential",
            AppError::Io(_) => "io",
            AppError::Ssh(_) => "ssh",
            AppError::SshHostKey(_) => "ssh_host_key",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let message = self.to_string();
        SerializedError { kind: self.kind(), message: &message }.serialize(serializer)
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::InvalidInput(value.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_and_message() {
        let json = serde_json::to_value(AppError::Query("boom".into())).unwrap();
        assert_eq!(json["kind"], "query");
        assert_eq!(json["message"], "boom");
        assert_eq!(AppError::Ssh("x".into()).kind(), "ssh");
        assert_eq!(AppError::SshHostKey("x".into()).kind(), "ssh_host_key");
    }
}
