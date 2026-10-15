//! Bounded observations, not a work allowance or a model-intent classifier.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LoopNotice {
    pub signature: String,
    pub level: u8,
    pub evidence: String,
    pub guidance: String,
    #[serde(default)]
    pub repair_exhausted: bool,
}
#[derive(Clone, Debug, Default)]
pub struct LoopDetector {
    pub last_signature: Option<String>,
    history: VecDeque<(String, String)>,
    seen: VecDeque<String>,
    announced: BTreeMap<String, u8>,
    pub progress_epoch: usize,
    read_grace: usize,
    pub observations: usize,
    pub guidance_count: usize,
    pub warning_count: usize,
    pub pause_count: usize,
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub fn call_key(name: &str, args: &Value) -> String {
    let mut args = args.clone();
    if matches!(name, "plan" | "deliverables" | "task_memory") {
        if args.get("action").and_then(Value::as_str) == Some("view") {
            // View always returns this logical task's whole snapshot. Ignored
            // id/note/other fields cannot turn it into a different operation.
            args = serde_json::json!({"action":"view"});
        }
        if let Some(object) = args.as_object_mut() {
            object.remove("revision");
            if name == "plan" {
                object.remove("note");
            }
        }
    }
    // BTree serialization prevents object key order from evading detection.
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(k, v)| (k.clone(), canonical(v)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
            _ => value.clone(),
        }
    }
    format!("{name}:{}", hash(&canonical(&args).to_string()))
}
impl LoopDetector {
    pub fn recovering_reads(&self) -> bool {
        self.read_grace > 0
    }
    pub fn compacted(&mut self) {
        self.read_grace = 8;
        self.history
            .retain(|(key, _)| !key.starts_with("read_file:"));
    }
    pub fn progress(&mut self) {
        self.last_signature = None;
        self.progress_epoch = self.progress_epoch.saturating_add(1);
        self.history.clear();
        self.announced.clear();
    }
    /// Explicit continuation begins a new observation window; it is not
    /// progress and never disables detection for this or another signature.
    pub fn rearm(&mut self) {
        self.history.clear();
        self.announced.clear();
    }
    pub fn observe(
        &mut self,
        name: &str,
        args: &Value,
        result: &Value,
        changed: bool,
    ) -> Option<LoopNotice> {
        self.observations = self.observations.saturating_add(1);
        if changed {
            self.progress();
        }
        let unavailable_resource = matches!(
            result.get("code").and_then(Value::as_str),
            Some("HTTP_NOT_FOUND" | "AUTH_REQUIRED" | "RESOURCE_NOT_FOUND")
        ) || matches!(
            result.get("status").and_then(Value::as_u64),
            Some(401 | 403 | 404)
        );
        let key = if unavailable_resource && args.get("url").is_some() {
            call_key(
                name,
                &serde_json::json!({"url":args.get("url"),"headers":args.get("headers"),"method":args.get("method")}),
            )
        } else {
            call_key(name, args)
        };
        let execution = result.get("execution").unwrap_or(result);
        let failure = result.get("error").is_some()
            || execution
                .get("exit_code")
                .and_then(Value::as_i64)
                .is_some_and(|code| code != 0);
        let deterministic = result.get("retrySameArguments") == Some(&Value::Bool(false))
            || result.get("stage").and_then(Value::as_str) == Some("validation")
            || failure
                && matches!(
                    name,
                    "apply_patch"
                        | "replace_text"
                        | "create_file"
                        | "write_file"
                        | "delete_file"
                        | "plan"
                        | "deliverables"
                );
        // Temporary failure retries, permission transport interrupts and context
        // recovery are not evidence of a cycle.
        if failure && !deterministic {
            return None;
        }
        if name == "observation_read" || name == "observation_index" {
            return None;
        }
        if name == "read_file" && self.read_grace > 0 && !failure {
            self.read_grace -= 1;
            return None;
        }
        let planning = matches!(name, "plan" | "deliverables" | "task_memory");
        let outcome = if name == "run_terminal" {
            serde_json::json!({"stdout":execution.get("stdout"),"stderr":execution.get("stderr"),"code":result.get("code"),"exit":execution.get("exit_code"),"status":execution.get("status"),"task_id":execution.get("task_id")}).to_string()
        } else if planning {
            fn stable(value: &Value) -> Value {
                match value {
                    Value::Object(object) => Value::Object(object.iter().filter(|(key, _)| !matches!(key.as_str(), "revision" | "updated")).map(|(key, value)| (key.clone(), stable(value))).collect()),
                    Value::Array(array) => Value::Array(array.iter().map(stable).collect()),
                    _ => value.clone(),
                }
            }
            stable(result).to_string()
        } else {
            let mut v = result.clone();
            if let Some(o) = v.as_object_mut() {
                for k in ["backup", "backups", "revision", "observation_id"] {
                    o.remove(k);
                }
            }
            v.to_string()
        };
        let outcome = hash(&outcome);
        let identity = format!("{key}:{outcome}");
        let novel = !self.seen.contains(&identity);
        if novel {
            self.seen.push_back(identity);
            if self.seen.len() > 96 {
                self.seen.pop_front();
            }
        }
        let informative = name == "run_terminal" || name.starts_with("read_") || name.starts_with("list_")
            || name.starts_with("web_") || matches!(name, "project_knowledge_read" | "project_knowledge_index" | "attachment_read_rows");
        if novel && !failure && !planning && informative && result.get("unchanged") != Some(&Value::Bool(true)) {
            self.progress();
        }
        self.history.push_back((key.clone(), outcome.clone()));
        if self.history.len() > 96 {
            self.history.pop_front();
        }
        let repeated = self
            .history
            .iter()
            .filter(|entry| entry.0 == key && entry.1 == outcome)
            .count();
        let mut signature = hash(&format!("same:{key}:{outcome}"));
        let mut count = repeated;
        let target = if unavailable_resource {
            ["url", "path", "command", "action"]
        } else {
            ["path", "url", "command", "action"]
        }
        .iter()
        .find_map(|key| args.get(key).and_then(Value::as_str))
        .unwrap_or("same target")
        .chars()
        .take(160)
        .collect::<String>();
        let mut evidence = format!(
            "{name} ({target}) returned the same {} {repeated} times with unchanged arguments",
            if failure {
                "deterministic failure"
            } else {
                "observation"
            }
        );
        // Exact alternating cycles with no intervening new observations.
        for period in 2..=4 {
            let history: Vec<_> = self.history.iter().collect();
            if history.len() < period * 3 {
                continue;
            }
            let tail = &history[history.len() - period..];
            let cycles = history
                .rchunks_exact(period)
                .take_while(|chunk| *chunk == tail)
                .count();
            if cycles >= 3 && cycles * 2 > count {
                let mut cycle: Vec<_> = tail.iter().map(|e| format!("{}:{}", e.0, e.1)).collect();
                cycle.sort();
                signature = hash(&cycle.join("|"));
                count = cycles * 2;
                evidence = format!("The same {period}-action sequence repeated {cycles} times without a new observation");
            }
        }
        self.last_signature = Some(signature.clone());
        let level = if count >= 20 {
            3
        } else if count >= 10 {
            2
        } else if count >= 5 {
            1
        } else {
            return None;
        };
        if self
                .announced
                .get(&signature)
                .is_some_and(|old| *old >= level)
        {
            return None;
        }
        if self.announced.len() >= 32 {
            self.announced.clear();
        }
        self.announced.insert(signature.clone(), level);
        match level { 1 => self.guidance_count += 1, 2 => self.warning_count += 1, _ => self.pause_count += 1 }
        let next = if planning {
            "This is task metadata only: view/implemented do not edit project files. Reuse the existing task snapshot and file observations. Compare the latest user request with actual files, choose an authorized project edit or relevant check when needed, and only then update metadata. Do not mark code implemented before editing it."
        } else if failure {
            "Use the existing error and current file/resource observation to identify the missing prerequisite or invalid argument. Correct it before retrying; do not repeat an unchanged deterministic failure or bypass permissions."
        } else {
            "Reuse the existing observation. Choose a different task-relevant action that can produce new information, an authorized change or a check; another identical inspection adds no information."
        };
        Some(LoopNotice { signature,level,evidence: evidence.clone(),guidance: format!("Agent runtime notice: {evidence}. {next} Preserve the latest user request, task ownership and verification requirements. An acknowledgement in reasoning is not observed progress. If you cannot make progress, explain the blocker instead of repeating."), repair_exhausted: false })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn compaction_keeps_successful_terminal_repetition_and_ignores_lifecycle_noise() {
        let mut detector=LoopDetector::default(); let mut levels=Vec::new();
        for index in 0..10 {
            if index==5 { detector.compacted(); }
            if let Some(notice)=detector.observe("run_terminal", &serde_json::json!({"command":"printf same"}),
                &serde_json::json!({"stdout":"same","stderr":"","exit_code":0,"status":"completed","pid":index+10,"started_at":index*100,"finished_at":index*100+20}),false) { levels.push(notice.level); }
        }
        assert_eq!(levels,vec![1,2]);
        assert_eq!(detector.progress_epoch,1,"rerunning the same observation is not progress");
    }
    #[test]
    fn gated_or_missing_resource_does_not_become_new_information_by_changing_the_destination() {
        for status in [401, 403, 404] {
            let mut detector = LoopDetector::default();
            let mut levels = Vec::new();
            for i in 0..25 {
                if let Some(n)=detector.observe("download_file",&json!({"url":"https://models.example/missing","path":format!("retry-{i}.bin")}),&json!({"error":"unavailable","status":status,"retrySameArguments":false}),false){levels.push(n.level);}
            }
            assert_eq!(levels, vec![1, 2, 3]);
            assert!(detector.observe("download_file",&json!({"url":"https://models.example/missing","headers":{"Authorization":"changed"}}),&json!({"error":"unavailable","status":status,"retrySameArguments":false}),false).is_none());
        }
    }
    #[test]
    fn unchanged_reads_escalate_once_and_edits_or_compaction_are_legitimate() {
        let mut d = LoopDetector::default();
        let mut levels = vec![];
        for _ in 0..25 {
            if let Some(n) = d.observe(
                "read_file",
                &json!({"path":"app.js"}),
                &json!({"content":"same"}),
                false,
            ) {
                levels.push(n.level);
            }
        }
        assert_eq!(levels, vec![1, 2, 3]);
        assert!(d
            .observe(
                "read_file",
                &json!({"path":"app.js"}),
                &json!({"content":"edited"}),
                true
            )
            .is_none());
        d.compacted();
        for _ in 0..8 {
            assert!(d
                .observe(
                    "read_file",
                    &json!({"path":"app.js"}),
                    &json!({"content":"edited"}),
                    false
                )
                .is_none());
        }
    }
    #[test]
    fn deterministic_errors_survive_compaction_but_transient_retries_do_not_warn() {
        let mut d = LoopDetector::default();
        for _ in 0..100 {
            assert!(d
                .observe(
                    "download_file",
                    &json!({"url":"https://example.com"}),
                    &json!({"error":"temporary","retrySameArguments":true}),
                    false
                )
                .is_none());
        }
        let mut levels = vec![];
        for _ in 0..25 {
            d.compacted();
            if let Some(n) = d.observe(
                "download_file",
                &json!({"url":"https://example.com"}),
                &json!({"error":"404","retrySameArguments":false}),
                false,
            ) {
                levels.push(n.level);
            }
        }
        assert_eq!(levels, vec![1, 2, 3]);
    }
    #[test]
    fn every_continuation_rearms_exact_thresholds_and_actual_progress_breaks_repetition() {
        let mut detector = LoopDetector::default();
        for _ in 0..3 {
            let mut warnings = Vec::new();
            for index in 1..=20 {
                if let Some(notice) = detector.observe("deliverables", &json!({"action":"view","id":format!("ignored-{index}")}), &json!({"deliverables":{"items":[],"revision":index}}), false) {
                    warnings.push((index, notice.level));
                    assert!(notice.guidance.contains("metadata only"));
                }
            }
            assert_eq!(warnings, [(5,1),(10,2),(20,3)]);
            detector.rearm();
        }
        for index in 0..80 {
            assert!(detector.observe("read_file", &json!({"path":"a"}), &json!({"content":index}), false).is_none());
            assert!(detector.observe("run_terminal", &json!({"task_action":"status","task_id":"owned"}), &json!({"status":"running","stdout":format!("progress {index}")}), false).is_none());
        }
        for index in 0..30 {
            assert!(detector.observe("deliverables", &json!({"action":"view"}), &json!({"items":[index]}), false).is_none(), "different actual results are not an identical observation");
        }
        let before = detector.progress_epoch;
        for index in 0..30 {
            detector.observe("write_file", &json!({"path":"same.txt","content":"same", "extra":index}), &json!({"unchanged":true}), false);
        }
        assert_eq!(detector.progress_epoch, before, "novel no-op arguments cannot pretend to be recovery progress");
    }
    #[test]
    fn cycles_are_bounded_and_continue_rearms_detection() {
        let mut d = LoopDetector::default();
        let mut last = None;
        for i in 0..50 {
            if let Some(n)=d.observe("plan",&json!({"action":"update","status":if i%2==0 {"pending"}else{"in_progress"},"note":format!("attempt {i}")}),&json!({}),false){last=Some(n);}
        }
        assert!(last.is_some());
        let progress = d.progress_epoch;
        d.rearm();
        assert_eq!(d.progress_epoch, progress);
        assert!(d.history.len() <= 96);
        for i in 0..2000 {
            d.observe(
                "read_file",
                &json!({"path":format!("unique-{i}")}),
                &json!({"content":i}),
                false,
            );
        }
        assert!(d.history.len() <= 96 && d.seen.len() <= 96);
    }
}
