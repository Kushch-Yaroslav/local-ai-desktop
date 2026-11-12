// Modified for Local AI Desktop: effective managed context, durable status and error details.
use crate::{
    agents::{
        final_output_tool::FinalOutputTool,
        state_machine::{trailing_error, MAX_TURNS_MESSAGE},
        AgentEvent, SessionConfig, StateMachineServices,
    },
    conversation::{
        message::{ActionRequiredData, Message, MessageContent},
        Conversation,
    },
    prompt_template::render_template,
    session::extension_data::{EnabledExtensionsState, ExtensionState},
    session::{Session, SessionManager, SessionType},
};
use anyhow::{anyhow, Result};
use futures::stream::BoxStream;
use futures::StreamExt;
use goose_agent::subagent::{SubagentOutcome, SubagentUpdate};
use rmcp::model::Role;
use serde::Serialize;
use std::future::Future;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;
use tracing::Instrument;

#[derive(Serialize)]
pub struct SubagentPromptContext {
    pub max_turns: usize,
    pub tool_count: usize,
    pub available_tools: String,
}

pub(crate) async fn prepare_subagent(
    services: &StateMachineServices,
    session: &Session,
) -> Result<SessionConfig> {
    let session_id = &session.id;
    if session.session_type != SessionType::SubAgent {
        return Err(anyhow!("Session {session_id} is not a subagent"));
    }
    let recipe = session
        .recipe
        .as_ref()
        .ok_or_else(|| anyhow!("Subagent {session_id} has no saved recipe"))?;
    let max_turns = recipe
        .settings
        .as_ref()
        .and_then(|settings| settings.max_turns)
        .ok_or_else(|| anyhow!("Subagent {session_id} has no saved turn limit"))?;
    let provider_name = session
        .provider_name
        .as_deref()
        .ok_or_else(|| anyhow!("Subagent {session_id} has no saved provider"))?;
    let model_config = session
        .model_config
        .as_ref()
        .ok_or_else(|| anyhow!("Subagent {session_id} has no saved model"))?;
    session
        .extension_data
        .get_extension_state(
            EnabledExtensionsState::EXTENSION_NAME,
            EnabledExtensionsState::VERSION,
        )
        .ok_or_else(|| anyhow!("Subagent {session_id} has no saved extension selection"))?;

    services
        .switch_provider(session_id, provider_name, model_config.clone())
        .await?;

    let provider = services.provider(session_id).await?;
    let limit = crate::session_context::with_managed_subagent(
        true,
        crate::context_limit::get_context_limit(provider.as_ref(), &model_config.model_name),
    )
    .await?;
    anyhow::ensure!(limit > 0, "Effective subagent context is unavailable; update/reload the managed Desktop provider before delegation");
    super::subagent_monitor::publish(
        &services.session_manager,
        session_id,
        "waiting",
        Some(limit),
        false,
    )
    .await;
    let subagent_prompt = build_subagent_prompt(services, max_turns, session_id).await?;
    services
        .session_manager
        .update(session_id)
        .system_prompt_override(Some(subagent_prompt))
        .apply()
        .await?;
    Ok(SessionConfig {
        id: session_id.to_string(),
        schedule_id: None,
        max_turns: Some(max_turns as u32),
    })
}

#[derive(Clone)]
pub(crate) struct ForegroundSubagentRunner {
    services: Arc<StateMachineServices>,
}

impl ForegroundSubagentRunner {
    pub(crate) fn new(services: Arc<StateMachineServices>) -> Self {
        Self { services }
    }

    fn session_manager(&self) -> &SessionManager {
        &self.services.session_manager
    }

    pub(crate) async fn load(&self, subagent_id: &str) -> Result<Session> {
        self.session_manager().get_session(subagent_id, true).await
    }

    pub(crate) fn spawn(
        &self,
        subagent: Session,
        cancel: CancellationToken,
    ) -> BoxStream<'static, SubagentUpdate> {
        let (to_parent, from_subagent) = mpsc::unbounded_channel();
        let span = tracing::info_span!("subagent", subagent_session_id = %subagent.id, parent_session_id = ?subagent.parent_session_id);
        spawn_run(
            self.clone()
                .run(subagent, cancel, to_parent)
                .instrument(span),
            from_subagent,
        )
    }

    async fn run_to_end(
        &self,
        subagent: &Session,
        cancel: CancellationToken,
        to_parent: &mpsc::UnboundedSender<Message>,
    ) -> Result<()> {
        let parent_id = subagent
            .parent_session_id
            .as_deref()
            .ok_or_else(|| anyhow!("Subagent {} has no parent", subagent.id))?;
        let session_config = prepare_subagent(&self.services, subagent).await?;
        let mut events = self.services.run_subagent_turn(session_config, cancel)?;
        let mut status = "running";
        super::subagent_monitor::publish(self.session_manager(), &subagent.id, status, None, false)
            .await;
        while let Some(event) = events.next().await {
            match event? {
                AgentEvent::Message(message) => {
                    let compacting = message.content.iter().any(|content| matches!(content,
                        MessageContent::SystemNotification(note) if note.msg == "goose is compacting the conversation..."));
                    if compacting {
                        status = "compacting";
                    }
                    if compacting
                        || message.content.iter().any(|content| {
                            matches!(
                                content,
                                MessageContent::ToolRequest(_)
                                    | MessageContent::ToolResponse(_)
                                    | MessageContent::Error(_)
                            )
                        })
                    {
                        super::subagent_monitor::publish(
                            self.session_manager(),
                            &subagent.id,
                            status,
                            None,
                            false,
                        )
                        .await;
                    }
                    if asks_for_a_decision(&message) {
                        let _ = to_parent.send(forwarded(
                            message,
                            parent_id,
                            &subagent.id,
                            self.session_manager(),
                        ));
                    }
                }
                AgentEvent::HistoryReplaced(_) => {
                    let compacted = status == "compacting";
                    status = "running";
                    super::subagent_monitor::publish(
                        self.session_manager(),
                        &subagent.id,
                        status,
                        None,
                        compacted,
                    )
                    .await;
                }
                AgentEvent::Usage(_) => {
                    super::subagent_monitor::publish(
                        self.session_manager(),
                        &subagent.id,
                        status,
                        None,
                        false,
                    )
                    .await
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn run(
        self,
        subagent: Session,
        cancel: CancellationToken,
        to_parent: mpsc::UnboundedSender<Message>,
    ) -> SubagentOutcome {
        let ending = SubagentEnding {
            services: Arc::clone(&self.services),
            subagent_id: subagent.id.clone(),
            ended: false,
        };
        super::subagent_monitor::publish(
            self.session_manager(),
            &subagent.id,
            "waiting",
            None,
            false,
        )
        .await;
        let run_result = self.run_to_end(&subagent, cancel.clone(), &to_parent).await;
        ending.end().await;
        let stopped = cancel.is_cancelled();
        let subagent = match self.session_manager().get_session(&subagent.id, true).await {
            Ok(subagent) => subagent,
            Err(error) => return SubagentOutcome::Failed(error.to_string()),
        };
        let messages = subagent.conversation.as_ref().map(Conversation::messages);
        let outcome = if let Some(output) =
            messages.and_then(|messages| FinalOutputTool::successful_output(messages))
        {
            SubagentOutcome::Completed(output)
        } else if stopped {
            SubagentOutcome::Cancelled
        } else if let Err(error) = run_result {
            SubagentOutcome::Failed(classified_subagent_failure(&error.to_string()))
        } else if subagent
            .conversation
            .as_ref()
            .and_then(trailing_error)
            .is_some()
        {
            let detail = messages
                .into_iter()
                .flatten()
                .rev()
                .flat_map(|message| message.content.iter())
                .find_map(|content| {
                    if let MessageContent::Error(error) = content {
                        Some(error.message.clone())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| "Subagent failed without provider error details".to_string());
            SubagentOutcome::Failed(classified_subagent_failure(&detail))
        } else {
            SubagentOutcome::Failed(missing_final_output_reason(
                messages.map(Vec::as_slice).unwrap_or_default(),
            ))
        };
        let status = match &outcome {
            SubagentOutcome::Completed(_) => "completed",
            SubagentOutcome::Cancelled => "cancelled",
            SubagentOutcome::Failed(_) => "failed",
        };
        super::subagent_monitor::publish(self.session_manager(), &subagent.id, status, None, false)
            .await;
        outcome
    }
}

fn missing_final_output_reason(messages: &[Message]) -> String {
    let reason = failure_reason(messages);
    if reason.starts_with("max turns reached") {
        reason
    } else {
        format!("missing_final_output: {reason}")
    }
}

fn classified_subagent_failure(detail: &str) -> String {
    let kind = subagent_error_kind(detail);
    if kind == "provider_or_tool_error" {
        detail.to_string()
    } else {
        format!("{kind}: {detail}")
    }
}

fn subagent_error_kind(detail: &str) -> &'static str {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("trying to compact")
        || lower.contains("failed to compact")
        || lower.contains("compaction could not")
    {
        "compaction_failed"
    } else if lower.contains("kv pool capacity exceeded")
        || lower.contains("context size has been exceeded")
        || lower.contains("gguf:kvcapacityexceeded")
    {
        "kv_capacity_exceeded"
    } else if lower.contains("invalid tool call")
        || lower.contains("malformed tool call")
        || lower.contains("tool call arguments")
            && (lower.contains("invalid") || lower.contains("parse"))
    {
        "invalid_tool_call"
    } else if lower.contains("gguf:contextexceeded")
        || lower.contains("contextlengthexceeded")
        || lower.contains("context length exceeded")
    {
        "context_exceeded"
    } else if lower.contains("gguf:contextunavailable") {
        "context_unavailable"
    } else if lower.contains("gguf:devicememory") || lower.contains("out of vram") {
        "device_memory"
    } else if lower.contains("gguf:hostmemory") || lower.contains("out of memory") {
        "host_memory"
    } else if lower.contains("gguf:timeout") || lower.contains("timed out") {
        "timeout"
    } else if lower.contains("gguf:streamaborted")
        || lower.contains("stream decode error")
        || lower.contains("error decoding response body")
        || lower.contains("stream ended")
    {
        "stream_interrupted"
    } else if lower.contains("gguf:serverunavailable") || lower.contains("gguf:servererror") {
        "llama_server_error"
    } else if lower.contains("server error:")
        || lower.contains("servererror(")
        || lower.contains("bad request (4")
        || lower.contains("request failed with status")
        || lower.contains("http 4")
        || lower.contains("http 5")
    {
        "upstream_http_error"
    } else {
        "provider_or_tool_error"
    }
}

fn spawn_run(
    run: impl Future<Output = SubagentOutcome> + Send + 'static,
    mut from_subagent: mpsc::UnboundedReceiver<Message>,
) -> BoxStream<'static, SubagentUpdate> {
    let task = AbortOnDropHandle::new(tokio::spawn(run.in_current_span()));
    Box::pin(async_stream::stream! {
        while let Some(message) = from_subagent.recv().await {
            yield SubagentUpdate::ToParent(message);
        }
        yield SubagentUpdate::Finished(
            task.await
                .unwrap_or_else(|error| SubagentOutcome::Failed(error.to_string())),
        );
    })
}

/// Aborting the parent's turn drops a running subagent's task, so the session is also ended
/// from `Drop`.
struct SubagentEnding {
    services: Arc<StateMachineServices>,
    subagent_id: String,
    ended: bool,
}

impl SubagentEnding {
    async fn end(mut self) {
        end_subagent(&self.services, &self.subagent_id).await;
        self.ended = true;
    }
}

impl Drop for SubagentEnding {
    fn drop(&mut self) {
        if self.ended {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let services = Arc::clone(&self.services);
        let subagent_id = std::mem::take(&mut self.subagent_id);
        runtime.spawn(async move {
            super::subagent_monitor::publish(
                &services.session_manager,
                &subagent_id,
                "cancelled",
                None,
                false,
            )
            .await;
            end_subagent(&services, &subagent_id).await;
        });
    }
}

async fn end_subagent(services: &StateMachineServices, subagent_id: &str) {
    services.release_session(subagent_id).await;
    services
        .emit_hook(crate::hooks::HookEvent::SessionEnd, subagent_id)
        .await;
}

fn forwarded(
    mut message: Message,
    parent_id: &str,
    subagent_id: &str,
    session_manager: &SessionManager,
) -> Message {
    for content in &mut message.content {
        if let MessageContent::ActionRequired(action) = content {
            if let ActionRequiredData::ToolConfirmation { id, .. }
            | ActionRequiredData::Elicitation { id, .. } = &mut action.data
            {
                *id = session_manager
                    .action_required()
                    .forward(parent_id, subagent_id, id);
            }
        }
    }
    message
}

fn asks_for_a_decision(message: &Message) -> bool {
    message.content.iter().any(|content| {
        matches!(
            content,
            MessageContent::ActionRequired(action)
                if matches!(
                    action.data,
                    ActionRequiredData::ToolConfirmation { .. }
                        | ActionRequiredData::Elicitation { .. }
                )
        )
    })
}

fn failure_reason(messages: &[Message]) -> String {
    let Some(last) = messages.last() else {
        return "stopped without final output".to_string();
    };
    let last_text = last.as_concat_text();
    if last_text == MAX_TURNS_MESSAGE {
        let last_response = messages
            .iter()
            .rev()
            .filter(|message| message.role == Role::Assistant)
            .map(Message::as_concat_text)
            .find(|text| !text.is_empty() && text != MAX_TURNS_MESSAGE);
        return match last_response {
            Some(text) => format!("max turns reached; last response: {text}"),
            None => "max turns reached".to_string(),
        };
    }
    if last_text.is_empty() {
        "stopped without final output".to_string()
    } else {
        last_text
    }
}

pub const SUBAGENT_TOOL_REQUEST_TYPE: &str = "subagent_tool_request";

async fn build_subagent_prompt(
    services: &StateMachineServices,
    max_turns: usize,
    session_id: &str,
) -> Result<String> {
    let mut tool_names: Vec<_> = services
        .list_tools(session_id, None)
        .await?
        .into_iter()
        .filter(super::reply_parts::is_tool_visible_to_model)
        .map(|t| t.name.to_string())
        .collect();
    tool_names.sort_unstable();
    render_template(
        "subagent_system.md",
        &SubagentPromptContext {
            max_turns,
            tool_count: tool_names.len(),
            available_tools: tool_names.join(", "),
        },
    )
    .map_err(|e| anyhow!("Failed to render subagent system prompt: {}", e))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures::StreamExt;

    use super::{failure_reason, missing_final_output_reason, spawn_run, subagent_error_kind};
    use crate::agents::state_machine::MAX_TURNS_MESSAGE;
    use crate::conversation::message::Message;
    use goose_agent::subagent::{SubagentOutcome, SubagentUpdate};
    use tokio::sync::{mpsc, oneshot};

    #[tokio::test]
    async fn dropping_a_started_run_aborts_its_task() {
        let (alive, aborted) = oneshot::channel::<()>();
        let (to_parent, from_subagent) = mpsc::unbounded_channel();
        let run = spawn_run(
            async move {
                let _alive = alive;
                let _to_parent = to_parent;
                std::future::pending::<SubagentOutcome>().await
            },
            from_subagent,
        );

        drop(run);

        let ended = tokio::time::timeout(Duration::from_secs(5), aborted).await;
        assert!(ended.expect("the task was not aborted").is_err());
    }

    #[tokio::test]
    async fn a_run_reports_what_it_forwarded_then_its_outcome() {
        let (to_parent, from_subagent) = mpsc::unbounded_channel();
        let run = spawn_run(
            async move {
                to_parent
                    .send(Message::assistant().with_text("may I run cargo test?"))
                    .unwrap();
                SubagentOutcome::Completed("done".to_string())
            },
            from_subagent,
        );

        let updates: Vec<_> = run.collect().await;

        assert!(matches!(
            updates.as_slice(),
            [
                SubagentUpdate::ToParent(_),
                SubagentUpdate::Finished(SubagentOutcome::Completed(_))
            ]
        ));
    }

    #[tokio::test]
    async fn a_panicking_run_is_reported_as_failed() {
        let (to_parent, from_subagent) = mpsc::unbounded_channel::<Message>();
        let run = spawn_run(
            async move {
                let _to_parent = to_parent;
                panic!("subagent crashed")
            },
            from_subagent,
        );

        let updates: Vec<_> = run.collect().await;

        assert!(matches!(
            updates.as_slice(),
            [SubagentUpdate::Finished(SubagentOutcome::Failed(_))]
        ));
    }

    #[test]
    fn failure_reason_describes_how_the_subagent_stopped() {
        let max_turns = Message::assistant().with_text(MAX_TURNS_MESSAGE);
        let cases = [
            (vec![], "stopped without final output".to_string()),
            (
                vec![Message::assistant().with_text("")],
                "stopped without final output".to_string(),
            ),
            (
                vec![Message::assistant().with_text("I gave up")],
                "I gave up".to_string(),
            ),
            (
                vec![Message::user().with_text("go"), max_turns.clone()],
                "max turns reached".to_string(),
            ),
            (
                vec![
                    Message::assistant().with_text("halfway there"),
                    Message::user().with_text("tool result"),
                    max_turns,
                ],
                "max turns reached; last response: halfway there".to_string(),
            ),
        ];
        for (messages, expected) in cases {
            assert_eq!(failure_reason(&messages), expected);
        }
    }

    #[test]
    fn subagent_error_kind_labels_runtime_and_tool_failures_without_hiding_details() {
        assert_eq!(
            subagent_error_kind("GGUF:contextExceeded:"),
            "context_exceeded"
        );
        assert_eq!(
            subagent_error_kind("ContextLengthExceeded(\"prompt too long\")"),
            "context_exceeded"
        );
        assert_eq!(
            subagent_error_kind("GGUF:contextUnavailable:"),
            "context_unavailable"
        );
        assert_eq!(
            subagent_error_kind("invalid tool call arguments"),
            "invalid_tool_call"
        );
        assert_eq!(
            subagent_error_kind("GGUF:streamAborted:"),
            "stream_interrupted"
        );
        assert_eq!(
            subagent_error_kind(
                "NetworkError(\"Stream decode error: error decoding response body\")"
            ),
            "stream_interrupted"
        );
        assert_eq!(
            subagent_error_kind("HTTP 503 from local server"),
            "upstream_http_error"
        );
        assert_eq!(
            subagent_error_kind("GGUF:serverUnavailable:"),
            "llama_server_error"
        );
    }

    #[test]
    fn subagent_without_successful_final_output_has_a_distinct_diagnostic() {
        assert_eq!(
            missing_final_output_reason(&[]),
            "missing_final_output: stopped without final output"
        );
    }
}
