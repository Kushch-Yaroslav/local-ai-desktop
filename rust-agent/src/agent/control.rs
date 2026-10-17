use super::permissions::Permissions;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopAction {
    Correct,
    Continue,
    Pause,
    CorrectResume,
    ContinueAnyway,
}
#[derive(Clone, Debug)]
pub struct LoopCommand {
    pub id: Option<String>,
    pub action: LoopAction,
    pub signature: String,
}
#[derive(Clone, Debug, Default)]
pub struct ExecutionControl {
    pub reasoning: Option<(String, serde_json::Value, serde_json::Value)>,
    pub permissions: Permissions,
    pub permissions_epoch: usize,
    pub commands: VecDeque<LoopCommand>,
    pub interactive: bool,
    pub active_signature: Option<String>,
}
