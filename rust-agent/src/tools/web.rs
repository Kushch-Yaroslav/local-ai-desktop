use crate::{agent::events::Event, protocol::emit};
use serde_json::Value;
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex, Condvar};
use std::time::{Duration, Instant};

pub fn is_web_tool(name: &str) -> bool {
    matches!(name, "web_project" | "web_search" | "web_image_search" | "web_open" | "web_read" | "web_follow_link" | "web_back")
}
pub fn is_attachment_tool(name: &str) -> bool {
    matches!(name, "read_attachment_data" | "read_conversation_file" | "list_attachments" | "attachment_metadata" | "search_attachments" | "read_document" | "document_memory" | "save_chat_note" | "list_observations" | "read_observation")
}
pub fn is_host_tool(name: &str) -> bool { is_web_tool(name) || is_attachment_tool(name) || matches!(name, "download_file" | "create_visual_artifact") }

/// Permission transport failure never authorizes execution or becomes a retryable
/// command/network error. A deadline does not prove the renderer disappeared.
pub fn permission_failure(error: &str, cancelled: bool) -> Value {
    serde_json::json!({"approved":false,"reason":if cancelled { "cancelled" }
        else if error.starts_with("Approval response transport timed out") { "timeout" }
        else { "ui_unavailable" },"error":error})
}

/// Only the trusted host can answer a pending call. Results still flow through
/// the ordinary observation ledger; they are never accepted as verification.
#[derive(Default)]
pub struct HostTools {
    pending: Mutex<Option<(String, Option<Value>)>>,
    changed: Condvar,
    next_id: AtomicU64,
    dispatch: Option<Box<dyn Fn(&str, &Value) -> Option<Value> + Send + Sync>>,
    permission_ui: bool,
}
impl HostTools {
    /// Trusted embedding hosts may provide their own permission/UI transport.
    /// This is never a model capability or a protocol argument.
    pub fn with_dispatch(dispatch: impl Fn(&str, &Value) -> Option<Value> + Send + Sync + 'static) -> Self {
        Self { dispatch: Some(Box::new(dispatch)), ..Self::default() }
    }
    pub fn with_permissions(permission_ui: bool) -> Self { Self { permission_ui, ..Self::default() } }

    pub fn reply(&self, id: &str, result: Value) {
        let mut pending = self.pending.lock().unwrap();
        if let Some((expected, value)) = pending.as_mut() {
            if expected == id && value.is_none() { *value = Some(result); self.changed.notify_all(); }
        }
    }
    pub fn execute(&self, run_id: &str, name: &str, arguments: &Value, cancelled: &AtomicBool) -> Result<Value, String> {
        if !is_host_tool(name) && name != "request_permission" { return Err("Unknown host tool".into()); }
        if cancelled.load(Ordering::Relaxed) { return Err("Web request cancelled".into()); }
        let id = format!("host-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        if let Some(result) = self.dispatch.as_ref().and_then(|dispatch| dispatch(name, arguments)) {
            emit(run_id, Event::HostToolCall { id, name: name.into(), arguments: arguments.clone() });
            return Ok(result);
        }
        if name == "request_permission" && !self.permission_ui { return Err("Approval UI unavailable: use an Electron session with an active approval transport".into()); }
        let mut pending = self.pending.lock().unwrap();
        *pending = Some((id.clone(), None));
        emit(run_id, Event::HostToolCall { id: id.clone(), name: name.into(), arguments: arguments.clone() });
        let started = Instant::now();
        loop {
            if cancelled.load(Ordering::Relaxed) { *pending = None; return Err("Web request cancelled".into()); }
            if let Some((_, Some(value))) = pending.take() { return Ok(value); }
            *pending = Some((id.clone(), None));
            let timeout = if name == "request_permission" || name == "web_project" { 330 } else if name == "download_file" || name == "read_document" { 3700 } else { 30 };
            if started.elapsed() > Duration::from_secs(timeout) { *pending = None; return Err(if name == "request_permission" { "Approval response transport timed out without an authorization decision" } else { "Host tool response timed out" }.into()); }
            pending = self.changed.wait_timeout(pending, Duration::from_millis(100)).unwrap().0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn attachment_transport_accepts_readonly_capabilities_without_project_tools() {
        let host = HostTools::with_dispatch(|name, _| Some(serde_json::json!({"tool": name})));
        let cancelled = AtomicBool::new(false);
        for name in ["read_conversation_file", "list_attachments", "attachment_metadata", "search_attachments", "read_document", "document_memory", "save_chat_note", "list_observations", "read_observation"] {
            assert!(is_attachment_tool(name));
            assert_eq!(host.execute("attachments", name, &Value::Null, &cancelled).unwrap()["tool"], name);
        }
        for name in ["read_file", "write_file", "run_terminal", "apply_patch", "read_browser"] {
            assert!(host.execute("attachments", name, &Value::Null, &cancelled).is_err());
        }
    }
    #[test]
    fn permission_transport_deadline_is_distinct_from_an_unavailable_ui() {
        assert_eq!(permission_failure("Approval response transport timed out without an authorization decision", false)["reason"], "timeout");
        assert_eq!(permission_failure("Approval UI unavailable", false)["reason"], "ui_unavailable");
        assert_eq!(permission_failure("Approval response transport timed out", true)["reason"], "cancelled");
    }
    #[test]
    fn replies_are_bound_to_pending_id_and_cancellation_remains_available() {
        let host = Arc::new(HostTools::default());
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_host = host.clone(); let worker_cancel = cancelled.clone();
        let worker = std::thread::spawn(move || worker_host.execute("test", "web_open", &serde_json::json!({"url":"https://example.com"}), &worker_cancel));
        while host.pending.lock().unwrap().is_none() { std::thread::yield_now(); }
        host.reply("wrong-id", serde_json::json!({"content":"invalid"}));
        assert!(host.pending.lock().unwrap().as_ref().unwrap().1.is_none());
        host.reply("host-1", serde_json::json!({"content":"page"}));
        assert_eq!(worker.join().unwrap().unwrap()["content"], "page");
        let worker_host = host.clone(); let worker_cancel = cancelled.clone();
        let worker = std::thread::spawn(move || worker_host.execute("test", "web_read", &serde_json::json!({}), &worker_cancel));
        while host.pending.lock().unwrap().is_none() { std::thread::yield_now(); }
        cancelled.store(true, Ordering::Relaxed);
        assert!(worker.join().unwrap().unwrap_err().contains("cancelled"));
        assert!(host.pending.lock().unwrap().is_none());
        assert!(host.execute("test", "run_terminal", &Value::Null, &cancelled).is_err());
    }
}
