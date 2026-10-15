use serde_json::{json, Value};

/// Classification is evidence about an operation's outcome, never an intent
/// recognizer. Only known diagnostics stop an identical deterministic retry.
pub fn terminal(value: Value) -> Value {
    if value.get("code").and_then(Value::as_str) == Some(crate::process::isolation::CODE) { return value; }
    if matches!(value.get("code").and_then(Value::as_str), Some("PERMISSION_DENIED" | "MANDATORY_POLICY_BLOCKED")) {
        let mut refusal = value; refusal["retrySameArguments"] = json!(false); return refusal;
    }
    let stderr = value.get("stderr").and_then(Value::as_str).unwrap_or("");
    let (code, retry) = if value.get("cancelled") == Some(&json!(true)) { ("CANCELLED", false) }
        else if value.get("timed_out") == Some(&json!(true)) { ("COMMAND_TIMEOUT", true) }
        else if stderr.contains("CUDA out of memory") || stderr.contains("torch.OutOfMemoryError") { ("GPU_MEMORY_CONFLICT", false) }
        else if stderr.contains("GatedRepoError") || stderr.contains("HTTP Error 401") || stderr.contains("HTTP Error 403") || stderr.contains("could not read Username") { ("AUTH_REQUIRED", false) }
        else if stderr.contains("HTTP Error 404") || stderr.contains("returned error: 404") || stderr.contains("RepositoryNotFoundError") || stderr.contains("repository") && stderr.contains("not found") { ("RESOURCE_NOT_FOUND", false) }
        else if stderr.contains("not a git repository") { ("INVALID_REPOSITORY", false) }
        else if stderr.contains("is not a git command") || stderr.contains("unrecognized option") || stderr.contains("unknown option") { ("INVALID_COMMAND", false) }
        else if stderr.contains("ModuleNotFoundError") || stderr.contains("command not found") { ("MISSING_DEPENDENCY", false) }
        else if stderr.contains("Permission denied") { ("PERMISSION_DENIED", false) }
        else { ("COMMAND_FAILED", true) };
    json!({"error":"terminal execution failed","code":code,"retrySameArguments":retry,"execution":value})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_diagnostics_stop_retries_and_transient_failures_remain_retryable() {
        for (stderr, code) in [
            ("GatedRepoError: HTTP 401", "AUTH_REQUIRED"),
            ("torch.OutOfMemoryError: CUDA out of memory", "GPU_MEMORY_CONFLICT"),
            ("fatal: could not read Username", "AUTH_REQUIRED"),
            ("HTTP Error 404: Not Found", "RESOURCE_NOT_FOUND"),
            ("fatal: not a git repository", "INVALID_REPOSITORY"),
            ("git: broken is not a git command", "INVALID_COMMAND"),
            ("ModuleNotFoundError: dependency", "MISSING_DEPENDENCY"),
            ("Permission denied", "PERMISSION_DENIED"),
        ] {
            let classified = terminal(json!({"stderr":stderr,"exit_code":1}));
            assert_eq!(classified["code"], code);
            assert_eq!(classified["retrySameArguments"], false);
            assert_eq!(classified["execution"]["stderr"], stderr);
        }
        assert_eq!(terminal(json!({"timed_out":true}))["retrySameArguments"], true);
        assert_eq!(terminal(json!({"timed_out":true}))["code"], "COMMAND_TIMEOUT", "a local command deadline does not prove a network failure");
        assert_eq!(terminal(json!({"cancelled":true}))["code"], "CANCELLED");
        assert_eq!(terminal(json!({"stderr":"connection temporarily unavailable"}))["retrySameArguments"], true);
        let denied = json!({"error":"not authorized","code":"PERMISSION_DENIED","approved":false,"reason":"user_rejected","retrySameArguments":false});
        assert_eq!(serde_json::from_str::<Value>(&concise(&denied.to_string())).unwrap(), denied);
        for reason in ["ui_unavailable", "timeout", "cancelled", "user_rejected"] {
            let denial = json!({"code":"PERMISSION_DENIED","approved":false,"reason":reason,"retrySameArguments":false});
            assert_eq!(terminal(denial.clone()), denial);
        }

    }
}

pub fn concise(message: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(message) {
        if value.get("error").is_some() { return value.to_string(); }
    }
    if message.starts_with("patch does not match current content:")
        || message.starts_with("hunk ") || message.starts_with("old_text ")
        || message.contains("Format: *** Begin Patch") || message == "patch is required"
        || message == "new_text must be a string"
        || message.starts_with("file already exists:") && message.contains("Use *** Update File")
        || message.starts_with("cannot update ") && message.contains("use *** Add File") {
        return json!({"error":message,"code":"INVALID_EDIT_ARGUMENTS","retrySameArguments":false,
            "next":"Read the current file/range (or its unchanged cached observation), then correct the exact old_text or patch context/indentation. Use a unique anchor; do not retry the same mismatching edit. No file was written."}).to_string();
    }
    if message.starts_with("File changed since your last read.")
        || message.starts_with("File changed while staging the edit;")
        || message.starts_with("Read the file before using replace_text;") {
        return json!({"error":message,"code":"STALE_FILE_REVISION","retrySameArguments":false,
            "next":"Read the latest file version, then construct the edit against that content. Do not reuse stale arguments."}).to_string();
    }
    let code = if message.starts_with("PERMISSION_DENIED:") || message.contains("path escapes project scope") { "PERMISSION_DENIED" }
        else if message.contains("No such file or directory") { "FILE_NOT_FOUND" }
        else if message.contains("cancelled") { "CANCELLED" }
        else { "TOOL_ERROR" };
    let cached_read = message.starts_with("This exact read is already stored as observation obs-");
    json!({"error":message.trim().chars().take(1200).collect::<String>(),"code":code,"retrySameArguments":code == "TOOL_ERROR" && !cached_read}).to_string()
}

/// These metadata operations need corrected input or changed prerequisites,
/// not an immediate identical retry. This only describes the existing refusal;
/// validation, evidence associations and permission decisions stay unchanged.
pub fn deliverables(message: &str) -> String {
    let next = if message.starts_with("task is too long (") {
        Some("Shorten task to the schema maxLength; keep detailed requirements in text.")
    } else if message.starts_with("unknown evidence '") {
        Some("Use only runtime-issued IDs listed in verification_state, or the existing observation for a readback claim. Do not invent or renumber IDs.")
    } else if message.starts_with("deliverable '") && message.contains("is pending: only an implemented deliverable") {
        Some("Finish the implementation, call action=implemented for this id, then verify with fresh evidence.")
    } else if message.starts_with("ev-") && message.contains("is stale:") {
        Some("Finish changes and rerun the relevant check with deliverable_ids. Then verify using its new evidence ID.")
    } else if message.starts_with("INTEGRITY_EVIDENCE_UNAVAILABLE:") {
        Some("Leave the non-modification claim implemented but unverified and report the missing trusted baseline/journal. Do not substitute tests, readback, or a retroactive baseline.")
    } else if message.starts_with("unsupported deliverables action:") {
        Some("Use a supported metadata action: add, implemented, verify, block, drop or view. This tool never edits project code. Use existing file observations to perform an authorized file edit/check when the user requested code changes; an unchanged view adds no information.")
    } else if message.contains("No fresh passing") || message.starts_with("ev-") || message.starts_with("In Deep mode name the evidence") {
        Some("Read verification_state, complete any edits, and run the relevant scoped check with deliverable_ids. Use its fresh passing evidence ID; repeating verify with the same evidence cannot resolve this refusal.")
    } else {
        Some("View the recorded deliverables and verification_state. Correct the arguments or complete the missing prerequisite before retrying; an identical metadata call cannot fix this refusal.")
    };
    match next {
        Some(next) => json!({"error":message,"code":if message.starts_with("INTEGRITY_EVIDENCE_UNAVAILABLE:") { "INTEGRITY_EVIDENCE_UNAVAILABLE" } else { "TOOL_ERROR" },"retrySameArguments":false,"next":next}).to_string(),
        None => concise(message),
    }
}

#[cfg(test)]
mod deliverable_diagnostic_tests {
    use super::*;
    #[test]
    fn cached_read_refusal_never_suggests_repeating_the_same_read() {
        let message="This exact read is already stored as observation obs-00000003; the file contents and requested range are unchanged. Use observation_read instead.";
        let value: Value=serde_json::from_str(&concise(message)).unwrap();
        assert_eq!(value["error"],message);
        assert_eq!(value["retrySameArguments"],false);
        assert_eq!(value["code"],"TOOL_ERROR");
    }
    #[test]
    fn state_dependent_rejections_require_a_corrective_step_and_keep_the_reason() {
        for message in [
            "task is too long (81 characters, limit 80): keep it to one short line",
            "unknown evidence 'ev-039': ids are issued by the runtime",
            "deliverable 'd5' is pending: only an implemented deliverable can be verified (use action implemented first)",
            "ev-017 is stale: the project changed after it was recorded. Run the check again.",
            "No fresh passing runtime evidence exists after the last change. Run the code.",
            "Evidence scope does not cover deliverable 'b'.",
            "INTEGRITY_EVIDENCE_UNAVAILABLE: No trusted baseline exists.",
        ] {
            let value: Value = serde_json::from_str(&deliverables(message)).unwrap();
            assert_eq!(value["error"],message);
            assert_eq!(value["retrySameArguments"],false);
            assert!(value["next"].as_str().unwrap().len()>10);
            assert_eq!(concise(&value.to_string()),value.to_string());
        }
        assert_eq!(serde_json::from_str::<Value>(&deliverables("other validation error")).unwrap()["retrySameArguments"], false);
    }
    #[test]
    fn invalid_file_edits_require_corrected_input_not_identical_retries() {
        for message in [
            "patch does not match current content: app.py (hunk 1: surrounding lines differ)",
            "patch must start with *** Begin Patch. Format: *** Begin Patch, then file sections",
            "patch is required",
            "hunk 2 for app.py matches 2 places: add context",
            "old_text does not exactly match current content; no file was written",
            "old_text matches more than one place; include a larger exact snippet; no file was written",
            "File changed since your last read. Read the latest version before replacing text.",
            "Read the file before using replace_text; model-supplied revisions are not accepted",
        ] {
            let value: Value = serde_json::from_str(&concise(message)).unwrap();
            assert_eq!(value["error"], message);
            assert_eq!(value["retrySameArguments"], false);
            assert!(value["next"].as_str().unwrap().contains("Read"));
            assert_eq!(concise(&value.to_string()), value.to_string());
        }
    }
}
