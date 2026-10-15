use serde_json::Value;
use std::path::Path;
pub fn execute(
    root: &Path,
    args: &Value,
    authorized: bool,
    cancelled: impl Fn() -> bool,
    started_event: impl FnMut(u32, u32, u32, u128),
    output: impl FnMut(&str, &str),
) -> Result<Value, String> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "command is required".to_owned())?;
    if !authorized && crate::agent::policy::requires_approval_in_root(crate::agent::policy::RunPolicy::Auto, "run_terminal", args, Some(root)) {
        return Err("PERMISSION_DENIED: explicit terminal authorization required".into());
    }
    let timeout = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(120_000);
    Ok(crate::process::runner::run_streaming_authorized(
        command,
        &root.display().to_string(),
        timeout,
        authorized,
        cancelled,
        started_event,
        output,
    ))
}
