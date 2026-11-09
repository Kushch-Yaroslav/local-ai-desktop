// Local AI Desktop: apply the current chat policy at model request time, without rewriting history.
use crate::conversation::message::{Message, MessageContent};
use std::collections::HashSet;

pub(crate) fn project(messages: &[Message], allow: bool) -> Vec<Message> {
    if allow {
        return messages.to_vec();
    }
    let browser_requests: HashSet<_> = messages
        .iter()
        .flat_map(|m| &m.content)
        .filter_map(|c| {
            let MessageContent::ToolRequest(r) = c else {
                return None;
            };
            let call = r.tool_call.as_ref().ok()?;
            (call.name.contains("browser_screenshot")
                || call.name.contains("browser_describe_area"))
            .then_some(r.id.clone())
        })
        .collect();
    let mut projected = messages.to_vec();
    for message in &mut projected {
        let mut legacy_evidence = false;
        message.content.retain_mut(|block| match block {
            MessageContent::Text(text) => {
                legacy_evidence = text.text.starts_with("Untrusted page evidence follows.");
                if legacy_evidence {text.text=format!("Current chat Vision is Off. Historical browser pixels are withheld; use DOM evidence and do not claim image recognition.\n{}",text.text);}
                true
            }
            MessageContent::Image(image) => {
                if image
                    .meta
                    .as_ref()
                    .is_some_and(|m| m.contains_key("ladBrowserAttachmentId"))
                {
                    legacy_evidence = false;
                    false
                } else {
                    !legacy_evidence
                }
            }
            MessageContent::ToolResponse(response) => {
                if let Ok(result)=&mut response.tool_result {
                    let before=result.content.len();
                    result.content.retain(|c|match c {
                        rmcp::model::ContentBlock::Image(image)=>!(browser_requests.contains(&response.id)||image.meta.as_ref().is_some_and(|m|m.contains_key("ladBrowserImage"))),
                        _=>true
                    });
                    if result.content.len()!=before {result.content.push(rmcp::model::ContentBlock::text("Current chat Vision is Off; historical browser pixels withheld."));}
                }
                true
            }
            _ => true,
        });
    }
    projected
}

pub(crate) async fn allowed(session_id: &str) -> bool {
    if session_id.is_empty() {
        return true;
    }
    let Ok(session) = crate::session::SessionManager::instance()
        .get_session(session_id, false)
        .await
    else {
        return false;
    };
    session
        .extension_data
        .extension_states
        .get("live_browser_policy.v1")
        .and_then(|v| v.get("allowImages"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn off_filters_tagged_tool_pixels_after_request_compaction() {
        let mut meta = rmcp::model::MetaObject::default();
        meta.insert("ladBrowserImage".into(), serde_json::json!(true));
        let image = rmcp::model::ContentBlock::Image(
            rmcp::model::ImageContent::new("browser-pixels", "image/png").with_meta(meta),
        );
        let history = vec![Message::user().with_tool_response(
            "compacted-request",
            Ok(rmcp::model::CallToolResult::success(vec![image])),
        )];
        let projected = project(&history, false);
        let MessageContent::ToolResponse(response) = &projected[0].content[0] else {
            panic!("tool response retained");
        };
        assert!(!response
            .tool_result
            .as_ref()
            .unwrap()
            .content
            .iter()
            .any(|c| matches!(c, rmcp::model::ContentBlock::Image(_))));
        assert!(matches!(
            history[0].content[0],
            MessageContent::ToolResponse(_)
        ));
    }

    #[test]
    fn off_projects_old_browser_pixels_without_deleting_uploads_or_saved_history() {
        let ordinary = Message::user().with_content(MessageContent::Image(
            rmcp::model::ImageContent::new("ordinary-upload", "image/png"),
        ));
        let visual = Message::user()
            .with_text("Untrusted page evidence follows.\nDOM #product")
            .with_content(MessageContent::Image(rmcp::model::ImageContent::new(
                "old-browser-crop",
                "image/png",
            )));
        let history = vec![ordinary, visual];
        let off = project(&history, false);
        assert!(matches!(&off[0].content[0], MessageContent::Image(_)));
        assert_eq!(off[1].content.len(), 1);
        assert_eq!(history[1].content.len(), 2);
        assert_eq!(project(&history, true)[1].content.len(), 2);
    }
}
