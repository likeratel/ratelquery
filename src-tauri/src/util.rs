//! Small helpers shared across modules.

use std::time::Instant;

use crate::error::{AppError, AppResult};

/// Milliseconds since `start`, saturating.
pub fn elapsed_ms(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Runs synchronous I/O (files, the OS keyring) on the blocking thread pool so it never
/// occupies an async worker thread. A panic or cancellation of the task is reported as `io`.
pub async fn run_blocking<T, F>(work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::Io(format!("background task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn run_blocking_leaves_the_async_thread_and_maps_failures() {
        let caller = std::thread::current().id();
        let worker = run_blocking(|| Ok(std::thread::current().id())).await.unwrap();
        assert_ne!(caller, worker);
        let failed = run_blocking(|| Err::<(), _>(AppError::Io("disk full".into()))).await;
        assert_eq!(failed.unwrap_err().to_string(), "disk full");
        let panicked = run_blocking::<(), _>(|| panic!("boom")).await.unwrap_err();
        assert_eq!(panicked.kind(), "io");
        assert!(panicked.to_string().starts_with("background task failed"), "{panicked}");
    }

    #[test]
    fn elapsed_is_small_for_now() {
        assert!(elapsed_ms(Instant::now()) < 1000);
    }
}
