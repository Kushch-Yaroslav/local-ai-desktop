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
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
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
    invalid_qa: BTreeMap<String, usize>,
    mutation_cycle: VecDeque<(String,String)>,
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
    pub fn continued(&mut self) {
        // Retain the observation window while allowing an unchanged strong
        // signature to stop the new execution again. Only real progress clears it.
        self.announced.clear();
    }
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
        // Recreating/deleting exactly the same helper is not new target
        // progress. Keep this separate from read/QA windows cleared by writes.
        if changed && matches!(name,"create_file"|"write_file"|"delete_file"|"replace_text") && result.get("error").is_none() {
            if let Some(path)=args["path"].as_str() {
                if self.mutation_cycle.back().is_some_and(|(p,_)|p!=path){self.mutation_cycle.clear();}
                let signature=if name=="delete_file"{"delete".to_owned()}else{call_key("put",&serde_json::json!({"content":args.get("content"),"old_text":args.get("old_text"),"new_text":args.get("new_text")}))};
                self.mutation_cycle.push_back((path.into(),signature.clone()));while self.mutation_cycle.len()>12{self.mutation_cycle.pop_front();}
                let repetitions=self.mutation_cycle.iter().filter(|(_,s)|s==&signature).count();
                if repetitions>=3 && self.mutation_cycle.iter().any(|(_,s)|s=="delete") && self.mutation_cycle.iter().any(|(_,s)|s!="delete") {
                    let level=if repetitions>=4{3}else{1};
                    return Some(LoopNotice{signature:hash(&format!("mutation-cycle:{path}")),level,evidence:format!("Repeated creation/deletion of {path} without a change to another target"),guidance:"Stop recreating the same helper solely to obtain proof. Reuse fresh source-scoped browser evidence or finish honestly with verification incomplete. Editing a real target with new content resets this cycle.".into(),repair_exhausted:true});
                }
            }
        }
        if changed {
            self.progress();
            self.invalid_qa.clear();
        }
        // Validation never reached Chromium or the QA report guard. Group the
        // failure by its actionable category and actual scenario conditions,
        // not labels, tool-call ids, or irrelevant JSON variations.
        if name == "web_project" && args.get("action").and_then(Value::as_str) == Some("qa") {
            let code = result.get("code").and_then(Value::as_str).unwrap_or("");
            if code == "INVALID_QA_ARGUMENTS" {
                let category = result.get("category").and_then(Value::as_str).unwrap_or("qa_schema");
                let conditions = args.get("scenarios").and_then(Value::as_array).map(|scenarios| scenarios.iter().map(|s| serde_json::json!({"target":s.get("target"),"source":s.pointer("/assertion/source")})).collect::<Vec<_>>());
                let signature = hash(&serde_json::json!({"conditions":conditions,"url":args.get("url"),"path":args.get("path")}).to_string());
                let count = self.invalid_qa.entry(signature.clone()).or_default();
                *count += 1;
                let count = *count;
                if self.invalid_qa.len() > 64 { self.invalid_qa.clear(); self.invalid_qa.insert(signature.clone(), count); }
                if count < 3 { return None; }
                let level = if count >= 4 { 3 } else { 1 };
                if level == 1 { self.guidance_count += 1; } else { self.pause_count += 1; }
                return Some(LoopNotice { signature, level,
                    evidence: format!("Browser QA validation ({category}) repeated {count} times without a project change"),
                    guidance: "The QA arguments are invalid, not evidence that the UI defect remains. Use the exact example from the error, inspect the real selector/geometry/styles, or finish with verification incomplete. Do not repeat equivalent malformed assertions. The next equivalent failure stops this run with a checkpoint; continuation retains this guard until actual progress.".into(),
                    repair_exhausted: true });
            }
            if result.get("error").is_none() && result.get("qa").is_some() { self.invalid_qa.clear(); }
        }
        if name=="web_project" && result.get("retrySameArguments")==Some(&Value::Bool(false)) && matches!(result.get("code").and_then(Value::as_str),Some("SCREENSHOT_LIMIT"|"INVALID_CROP"|"INVALID_SELECTOR"|"REGION_ROUTE_MISMATCH"|"DUPLICATE_FAILED_OPERATION"|"PREVIEW_ORIGIN_SCOPE_MISMATCH"|"BROWSER_NAVIGATION_FAILED")) {
            let signature=hash("browser-blocked-strategy");
            let count=self.invalid_qa.entry(signature.clone()).or_default();*count+=1;let count=*count;
            if count<3{return None;}
            let level=if count>=4{3}else{1};
            return Some(LoopNotice{signature,level,evidence:format!("Browser capability refused {} equivalent attempts",count),guidance:"This operation is unavailable under current conditions. Use inspect for bounded DOM/computed styles, a supported assertion and the approved original URL/viewport, or finish with verification incomplete. For REGION_ROUTE_MISMATCH explicitly open a returned saved URL; for a selector error inspect real DOM before changing it. Equivalent rejected actions across error categories are not progress. Do not alternate failed strategies or expand to unrelated routes. Continuation retains the blocker; screenshot budget is task-scoped.".into(),repair_exhausted:true});
        }
        if name=="deliverables" && result["code"]=="INVALID_STYLE_CRITERION" {
            // IDs, descriptions and alternating invalid fields are not progress.
            let signature=hash("invalid-style-criterion");
            let count=self.invalid_qa.entry(signature.clone()).or_default();*count+=1;let count=*count;
            if count<3{return None;}
            let level=if count>=4{3}else{1};
            return Some(LoopNotice{signature,level,evidence:format!("Browser QA validation: invalid immutable style criterion repeated {count} times"),guidance:"Nothing was registered. Use the complete corrected example, inspect live computed styles, or finish with the actual observation and limits. Do not create helper scripts merely for a Verified label. Continuation retains this guard until project progress.".into(),repair_exhausted:true});
        }
        // The browser's pre-execution guard already suppresses no-progress QA.
        // First offer alternatives; ignoring the same blocker is a resumable stop.
        if name == "web_project" && result.get("code").and_then(Value::as_str) == Some("QA_NO_PROGRESS") {
            let signature = hash(&format!("qa-local:{}", result.get("loop").and_then(|v|v.get("key")).unwrap_or(&Value::Null)));
            let count = self.invalid_qa.entry(signature.clone()).or_default(); *count += 1;
            let count = *count;
            if count == 2 || count == 3 { return None; }
            let level = if count >= 4 { 3 } else { 1 };
            if level == 3 { self.pause_count += 1; } else { self.guidance_count += 1; }
            return Some(LoopNotice { signature, level,
                evidence: "Browser QA revisited known evidence without a meaningful revision or state change".into(),
                guidance: "The QA loop is blocked locally. Preserve previous evidence; do not call the same QA again or bypass it with fill(body), hidden inputs or browser relaunches. Fix a concrete issue, change the scenario meaningfully, continue other work, or finish honestly with partial verification. A user request can authorize a fresh observation window.".into(),
                repair_exhausted: false });
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
            || name.starts_with("web_") || name == "attachment_read_rows";
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
    fn alternating_browser_refusals_share_a_bounded_guard() {
        let mut detector=LoopDetector::default();
        for (i,code) in ["REGION_ROUTE_MISMATCH","INVALID_SELECTOR","DUPLICATE_FAILED_OPERATION","REGION_ROUTE_MISMATCH"].iter().enumerate() {
            let notice=detector.observe("web_project",&serde_json::json!({"action":if i%2==0{"inspect"}else{"read"}}),&serde_json::json!({"code":code,"error":"blocked","retrySameArguments":false}),false);
            if i<2{assert!(notice.is_none());}else{assert_eq!(notice.unwrap().level,if i==2{1}else{3});}
        }
        detector.continued();
        assert_eq!(detector.observe("web_project",&serde_json::json!({"action":"inspect"}),&serde_json::json!({"code":"REGION_ROUTE_MISMATCH","error":"blocked","retrySameArguments":false}),false).unwrap().level,3);
    }
    #[test]
    fn recreating_the_same_check_file_does_not_reset_loop_detection() {
        let mut detector=LoopDetector::default();
        for n in 0..4 {
            let notice=detector.observe("create_file",&json!({"path":"check.js","content":"same check"}),&json!({"ok":true}),true);
            if n==2 {assert_eq!(notice.as_ref().unwrap().level,1);}if n==3 {assert_eq!(notice.unwrap().level,3);}
            detector.observe("delete_file",&json!({"path":"check.js"}),&json!({"ok":true}),true);
        }
        detector.observe("replace_text",&json!({"path":"real.css","old_text":"2px","new_text":"28px"}),&json!({"ok":true}),true);
        assert!(detector.observe("create_file",&json!({"path":"check.js","content":"same check"}),&json!({"ok":true}),true).is_none());
    }

    #[test]
    fn malformed_criteria_cannot_evade_guard_by_changing_ids_or_fields() {
        let mut detector=LoopDetector::default();
        for n in 0..4 {
            let notice=detector.observe("deliverables",&json!({"action":"criteria","id":format!("new-{n}")}),&json!({"error":"Invalid style","code":"INVALID_STYLE_CRITERION","field":format!("field-{n}"),"retrySameArguments":false}),false);
            if n<2{assert!(notice.is_none());}else{assert_eq!(notice.unwrap().level,if n==2{1}else{3});}
        }
        let mut resumed:LoopDetector=serde_json::from_value(serde_json::to_value(detector).unwrap()).unwrap();resumed.continued();
        assert_eq!(resumed.observe("deliverables",&json!({"action":"criteria"}),&json!({"error":"Invalid","code":"INVALID_STYLE_CRITERION"}),false).unwrap().level,3);
    }

    #[test]
    fn equivalent_invalid_qa_is_bounded_and_survives_continuation() {
        let mut detector = LoopDetector::default();
        let result = json!({"code":"INVALID_QA_ARGUMENTS","error":"Missing selector","category":"selector","retrySameArguments":false});
        let args = |n| json!({"action":"qa","scenarios":[{"id":format!("check-{n}"),"goal":format!("attempt {n}"),"target":"http://localhost/#/shop?q=1","viewport":{"width":1920,"height":1080},"assertion":{"source":"visible","expected":true}}]});
        assert!(detector.observe("web_project", &args(1), &result, false).is_none());
        assert!(detector.observe("web_project", &args(2), &result, false).is_none());
        assert_eq!(detector.observe("web_project", &args(3), &result, false).unwrap().level, 1);
        let mut resumed: LoopDetector = serde_json::from_value(serde_json::to_value(detector).unwrap()).unwrap();
        resumed.rearm(); // UI continuation is not observed project progress.
        assert_eq!(resumed.observe("web_project", &args(4), &result, false).unwrap().level, 3);
        resumed.observe("replace_text", &json!({"path":"style.css"}), &json!({"ok":true}), true);
        assert!(resumed.observe("web_project", &args(5), &result, false).is_none());
        let mut mobile = args(6); mobile["scenarios"][0]["viewport"]["width"] = json!(390);
        assert!(resumed.observe("web_project", &mobile, &result, false).is_none());
    }

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
    fn browser_qa_block_offers_alternatives_then_stops_repeated_bypass() {
        let mut detector = LoopDetector::default();
        let result = json!({"code":"QA_NO_PROGRESS","retrySameArguments":false,"loop":{"key":"revision-scenario"}});
        let first = detector.observe("web_project", &json!({"action":"qa"}), &result, false).unwrap();
        assert_eq!(first.level, 1);
        for _ in 0..2 { assert!(detector.observe("web_project", &json!({"action":"qa"}), &result, false).is_none()); }
        assert_eq!(detector.observe("web_project", &json!({"action":"qa"}), &result, false).unwrap().level, 3);
        assert_eq!(detector.pause_count, 1);
        assert_eq!(detector.guidance_count, 1);
        assert!(detector.observe("read_file", &json!({"path":"other.js"}), &json!({"content":"new useful work"}), false).is_none());
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
