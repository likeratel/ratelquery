use crate::aws_profiles::{AwsProfile, aws_profiles as load_aws_profiles};
use crate::error::AppResult;
use crate::util::run_blocking;

/// Profiles from the shared AWS config and credentials files, for the connection form.
#[tauri::command]
pub async fn aws_profiles() -> AppResult<Vec<AwsProfile>> {
    run_blocking(load_aws_profiles).await
}
