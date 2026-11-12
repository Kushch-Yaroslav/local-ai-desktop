// Local AI Desktop: persisted child-session status and lightweight ACP invalidations.
use crate::session::SessionManager;
use serde_json::{json, Value};
use std::sync::LazyLock;
use tokio::sync::broadcast;

static OWNER: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());
pub(crate) fn owner() -> &'static str {
    &OWNER
}
static UPDATES: LazyLock<broadcast::Sender<Value>> = LazyLock::new(|| broadcast::channel(256).0);
pub(crate) fn subscribe() -> broadcast::Receiver<Value> {
    UPDATES.subscribe()
}

pub(crate) async fn publish(
    manager: &SessionManager,
    id: &str,
    status: &str,
    limit: Option<usize>,
    compacted: bool,
) {
    let Ok(session) = manager.get_session(id, false).await else {
        return;
    };
    let previous = session
        .extension_data
        .get_extension_state("subagent_monitor", "v1")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let now = chrono::Utc::now().to_rfc3339();
    let title = session
        .recipe
        .as_ref()
        .and_then(|recipe| recipe.prompt.as_deref())
        .and_then(|prompt| prompt.lines().find(|line| !line.trim().is_empty()))
        .map(|title| crate::utils::safe_truncate(title, 100).to_string())
        .unwrap_or(session.name.clone());
    let state = json!({
        "owner": owner(), "id": id, "parentId": session.parent_session_id, "title": title, "status": status,
        "contextLimit": limit.map(|v| json!(v)).unwrap_or_else(|| previous["contextLimit"].clone()),
        "totalTokens": session.usage.total_tokens,
        "compactions": previous["compactions"].as_u64().unwrap_or(0) + u64::from(compacted),
        "lastCompactionAt": if compacted { json!(now) } else { previous["lastCompactionAt"].clone() },
        "updatedAt": now,
    });
    if manager
        .set_extension_value(id, "subagent_monitor", "v1", state.clone())
        .await
        .is_ok()
    {
        let _ = UPDATES.send(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn status_and_compaction_survive_reload_without_copying_history() {
        let root = tempfile::tempdir().unwrap();
        let manager = SessionManager::new(root.path().to_path_buf());
        let child = manager
            .create_session(
                root.path().to_path_buf(),
                "child".into(),
                crate::session::SessionType::SubAgent,
                crate::config::GooseMode::Auto,
            )
            .await
            .unwrap();
        manager
            .update(&child.id)
            .parent_session_id(Some("parent".into()))
            .apply()
            .await
            .unwrap();
        publish(&manager, &child.id, "running", Some(28672), false).await;
        publish(&manager, &child.id, "compacting", None, false).await;
        publish(&manager, &child.id, "running", None, true).await;
        publish(&manager, &child.id, "cancelled", None, false).await;
        let loaded = manager.get_session(&child.id, true).await.unwrap();
        let state = loaded
            .extension_data
            .get_extension_state("subagent_monitor", "v1")
            .unwrap();
        assert_eq!(state["status"], "cancelled");
        assert_eq!(state["contextLimit"], 28672);
        assert_eq!(state["compactions"], 1);
        assert!(state["lastCompactionAt"].is_string());
        assert!(loaded.conversation.unwrap().messages().is_empty());
    }
}
// Local AI Desktop: publish persisted subagent lifecycle and logical context metadata.
