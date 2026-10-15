use std::sync::Mutex;

use super::model::MysqlStateEvent;

pub const STATE_EVENT: &str = "mysql:state";

/// Receives `mysql:state` events. The app forwards them to the webview; tests record them.
pub trait StateSink: Send + Sync {
    fn emit(&self, event: MysqlStateEvent);
}

/// Test sink that keeps every event in order.
#[derive(Debug, Default)]
pub struct RecordingSink {
    events: Mutex<Vec<MysqlStateEvent>>,
}

impl RecordingSink {
    pub fn events(&self) -> Vec<MysqlStateEvent> {
        self.events.lock().map(|events| events.clone()).unwrap_or_default()
    }
}

impl StateSink for RecordingSink {
    fn emit(&self, event: MysqlStateEvent) {
        if let Ok(mut events) = self.events.lock() {
            events.push(event);
        }
    }
}
