//! Durable, append-only accepted events. Large tool bodies live in immutable
//! files; the journal contains only metadata and references to those files.
use crate::agent::transcript::{Entry, ToolResultPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Observation {
    pub id: String,
    pub event_id: String,
    pub call_id: String,
    pub tool: String,
    pub source: Option<String>,
    pub source_revision: Option<String>,
    pub requested_range: Option<String>,
    pub returned_range: Option<String>,
    pub error: bool,
    pub body_sha256: String,
    pub body_bytes: usize,
}

impl Observation {
    pub fn index_line(&self) -> String {
        let revision = self.source_revision.as_deref().unwrap_or("unknown");
        let short_revision = revision.chars().take(12).collect::<String>();
        format!(
            "{} {} {} source={} rev={} range={}",
            self.id,
            self.tool,
            if self.error { "error" } else { "ok" },
            self.source.as_deref().unwrap_or("none"),
            short_revision,
            self.returned_range.as_deref().unwrap_or("unknown")
        )
    }
    pub fn receipt(&self) -> String {
        format!(
            "[historical tool observation] id={} tool={} outcome={} source={} revision={} requested={} returned={} bytes={} sha256={}\nStored historical evidence. Recover with observation_read(id=\"{}\") only for a specific missing exact detail or contradiction; findings you rely on belong in Task Memory.",
            self.id, self.tool, if self.error { "error/blocker" } else { "success" },
            self.source.as_deref().unwrap_or("none"),
            self.source_revision.as_deref().unwrap_or("unknown"),
            self.requested_range.as_deref().unwrap_or("all"),
            self.returned_range.as_deref().unwrap_or("unknown"),
            self.body_bytes, self.body_sha256, self.id
        )
    }
}

pub fn requested_read_range(arguments: &Value) -> String {
    let start = arguments.get("start_line").and_then(Value::as_u64);
    let end = arguments.get("end_line").and_then(Value::as_u64);
    let lines = if start.is_some() || end.is_some() {
        format!("lines {}-{}", start.unwrap_or(1).max(1), end.map_or("end".into(), |n| n.max(1).to_string()))
    } else { "all".into() };
    format!("{lines} offset_chars={}", arguments.get("offset_chars").and_then(Value::as_u64).unwrap_or(0))
}

fn returned_range(parsed: &Value) -> Option<String> {
    let range = parsed
        .get("start_line")
        .and_then(Value::as_u64)
        .map(|start| {
            format!(
                "lines {}-{}",
                start,
                parsed
                    .get("end_line")
                    .and_then(Value::as_u64)
                    .map_or("end".into(), |end| end.to_string())
            )
        })
        .or_else(|| {
            if parsed.get("start_line").is_some() {
                None
            } else {
                parsed
                    .get("total_lines")
                    .and_then(Value::as_u64)
                    .map(|lines| format!("lines 1-{lines}"))
            }
        })?;
    let range = match (
        parsed
            .get("starts_mid_line")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        parsed
            .get("ends_mid_line")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    ) {
        (true, true) => format!("{range} (partial first and last lines)"),
        (true, false) => format!("{range} (partial first line)"),
        (false, true) => format!("{range} (partial last line)"),
        (false, false) => range,
    };
    Some(
        if let Some(next) = parsed.get("next_offset_chars").and_then(Value::as_u64) {
            format!(
                "{range} next_offset_chars={next} truncated={}",
                parsed
                    .get("truncated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            )
        } else {
            range
        },
    )
}

pub fn classify_source_read<'a>(
    current: &Observation,
    prior: impl Iterator<Item = &'a Observation>,
) -> &'static str {
    if current.error {
        return "failed_read";
    }
    let Some(source) = current.source.as_deref() else {
        return "unknown_source";
    };
    let same = prior
        .filter(|o| !o.error && o.source.as_deref() == Some(source))
        .collect::<Vec<_>>();
    if same.is_empty() {
        return "first_read";
    }
    if same.iter().any(|o| {
        o.source_revision == current.source_revision && o.requested_range == current.requested_range
    }) {
        return "unchanged_duplicate";
    }
    if same
        .iter()
        .any(|o| o.source_revision == current.source_revision)
    {
        return "new_range";
    }
    "changed_source"
}

#[derive(Serialize, Deserialize)]
struct JournalLine {
    event_id: String,
    entry: Entry,
    observation: Option<Observation>,
}

#[derive(Serialize, Deserialize)]
struct Active {
    run_dir: String,
    expected_history_hash: String,
}

pub struct EvidenceStore {
    dir: PathBuf,
    run_id: String,
    root: Option<PathBuf>,
    secondary_root: Option<PathBuf>,
    journal: File,
    next_event: usize,
    next_observation: usize,
    pub observations: Vec<Observation>,
    previous_active: Option<Vec<u8>>,
}

pub fn history_hash(history: &[Value]) -> String {
    // Native payloads are rehydrated only when needed. Stable attachment IDs
    // distinguish changed inputs without hashing transport blobs or breaking
    // Continue when a follow-up no longer needs a prior image.
    let mut canonical = Value::Array(history.iter().cloned().map(|mut message| {
        if let Some(object) = message.as_object_mut() { object.remove("images"); }
        message
    }).collect());
    // Persisted lineage hashes predate order-preserving tool schema serialization.
    canonical.sort_all_objects();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical).unwrap_or_default())
    )
}

impl EvidenceStore {
    /// Matching V2 history resumes exact events. An edited/legacy chat starts a
    /// new lineage without deleting the older files.
    pub fn open(
        base: &Path,
        run_id: &str,
        history: &[Value],
        root: Option<&str>,
    ) -> Result<(Self, Vec<Entry>), String> {
        Self::open_with_recovery(base,run_id,history,root,false)
    }

    pub fn open_with_recovery(base: &Path, run_id: &str, history: &[Value], root: Option<&str>, recover_completed: bool) -> Result<(Self,Vec<Entry>),String> {
        fs::create_dir_all(base).map_err(|e| e.to_string())?;
        let active_path = base.join("active.json");
        let previous_active = fs::read(&active_path).ok();
        let active = previous_active.as_ref().and_then(|bytes| serde_json::from_slice::<Active>(bytes).ok());
        let hash = history_hash(history);
        let mut active = active;
        let mut resume = active.as_ref().is_some_and(|a| {
            a.expected_history_hash == hash || can_resume_interrupted(base, a, history)
        });
        if !resume && recover_completed {
            let candidates:Vec<_> = fs::read_dir(base).map_err(|e|e.to_string())?.filter_map(Result::ok).filter(|e|e.file_type().is_ok_and(|kind|kind.is_dir())).filter(|e| legacy_completed_matches(&e.path(),history)).collect();
            // Recovery is allowed only for one exact UI-history match within
            // this host-owned logical-task directory, never by observation ID.
            if candidates.len()==1 {
                active=Some(Active{run_dir:candidates[0].file_name().to_string_lossy().into_owned(),expected_history_hash:hash.clone()});
                resume=true;
            }
        }
        let run_dir = if resume {
            active.unwrap().run_dir
        } else {
            safe_name(run_id)
        };
        let dir = base.join(run_dir);
        let canonical_root = root.and_then(|r| fs::canonicalize(r).ok());
        fs::create_dir_all(dir.join("observations")).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        let mut observations = Vec::new();
        let journal_path = dir.join("events.jsonl");
        if resume && journal_path.exists() {
            let bytes = fs::read(&journal_path).map_err(|e| e.to_string())?;
            let mut valid_bytes = 0;
            for line in bytes.split_inclusive(|byte| *byte == b'\n') {
                if !line.ends_with(b"\n") {
                    break;
                }
                let Ok(mut item) = serde_json::from_slice::<JournalLine>(line) else {
                    break;
                }; // tolerate an interrupted final append
                if let Some(meta) = item.observation.take() {
                    let body = fs::read_to_string(
                        dir.join("observations").join(format!("{}.txt", meta.id)),
                    )
                    .map_err(|e| e.to_string())?;
                    if format!("{:x}", Sha256::digest(body.as_bytes())) != meta.body_sha256 {
                        return Err(format!("observation {} checksum mismatch", meta.id));
                    }
                    if let Entry::Message(message) = &mut item.entry {
                        message["content"] = json!(body);
                        message["_observation_id"] = json!(meta.id);
                    }
                    observations.push(meta);
                }
                if let Entry::Message(message) = &mut item.entry {
                    if ToolResultPolicy::from_message(message) == ToolResultPolicy::Rehydrated {
                        let reference = message
                            .get("_rehydration")
                            .ok_or("missing rehydration locator")?;
                        let id = reference
                            .get("id")
                            .and_then(Value::as_str)
                            .ok_or("missing source observation")?;
                        let offset = reference
                            .get("offset_chars")
                            .and_then(Value::as_u64)
                            .ok_or("missing recovery offset")?
                            as usize;
                        let limit = reference
                            .get("max_chars")
                            .and_then(Value::as_u64)
                            .ok_or("missing recovery limit")?
                            as usize;
                        let result = read_stored_observation(
                            &dir,
                            canonical_root.as_deref(),
                            &observations,
                            id,
                            offset,
                            limit,
                        )?;
                        let mut accepted: Value = serde_json::from_str(
                            message
                                .get("content")
                                .and_then(Value::as_str)
                                .ok_or("missing recovery snapshot")?,
                        )
                        .map_err(|e| e.to_string())?;
                        accepted["content"] = result["content"].clone();
                        message["content"] = json!(accepted.to_string());
                    }
                }
                entries.push(item.entry);
                valid_bytes += line.len();
            }
            if valid_bytes < bytes.len() {
                OpenOptions::new()
                    .write(true)
                    .open(&journal_path)
                    .map_err(|e| e.to_string())?
                    .set_len(valid_bytes as u64)
                    .map_err(|e| e.to_string())?;
            }
        }
        let journal = OpenOptions::new()
            .create(true)
            .append(true)
            .open(journal_path)
            .map_err(|e| e.to_string())?;
        // This attempt's exact input prefix becomes the interruption anchor,
        // including when continuing an already completed logical-task lineage.
        {
            let active = Active {
                run_dir: dir.file_name().unwrap().to_string_lossy().into_owned(),
                expected_history_hash: hash,
            };
            let tmp = base.join("active.json.tmp");
            fs::write(
                &tmp,
                serde_json::to_vec(&active).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            fs::rename(tmp, &active_path).map_err(|e| e.to_string())?;
        }
        let next_event = entries.len() + 1;
        let next_observation = fs::read_dir(dir.join("observations"))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                entry.file_name().to_str().and_then(|name| {
                    name.strip_prefix("obs-")
                        .and_then(|s| s.strip_suffix(".txt"))
                        .and_then(|n| n.parse::<usize>().ok())
                })
            })
            .max()
            .unwrap_or(0)
            + 1;
        Ok((
            Self {
                dir,
                run_id: run_id.into(),
                root: canonical_root,
                secondary_root: None,
                journal,
                next_event,
                next_observation,
                observations,
                previous_active,
            },
            entries,
        ))
    }

    /// Failed startup must not replace the last valid journal anchor.
    pub fn rollback_open(&self, base: &Path) -> Result<(), String> {
        let path=base.join("active.json");
        if let Some(previous)=&self.previous_active {
            let tmp=base.join("active.json.tmp");
            fs::write(&tmp,previous).map_err(|e|e.to_string())?;
            fs::rename(tmp,path).map_err(|e|e.to_string())
        } else {
            fs::remove_file(path).map_err(|e|e.to_string())
        }
    }

    pub fn append(
        &mut self,
        entry: &Entry,
        call_args: Option<&Value>,
    ) -> Result<Option<Observation>, String> {
        let event_id = format!("evt-{:08}", self.next_event);
        let mut stored = entry.clone();
        let mut observation = None;
        if let Entry::Message(message) = &mut stored {
            if message.get("role").and_then(Value::as_str) == Some("tool") {
                if ToolResultPolicy::from_message(message) == ToolResultPolicy::Rehydrated {
                    // This event points at an earlier immutable observation.
                    // Persist accepted provenance/status metadata but no
                    // second copy of the exact historical payload slice.
                    let mut snapshot: Value = serde_json::from_str(
                        message
                            .get("content")
                            .and_then(Value::as_str)
                            .ok_or("missing recovery result")?,
                    )
                    .map_err(|e| e.to_string())?;
                    snapshot["content"] = Value::Null;
                    message["content"] = json!(snapshot.to_string());
                } else if ToolResultPolicy::from_message(message) == ToolResultPolicy::Archivable {
                    let body = message.get("content").and_then(Value::as_str).unwrap_or("");
                    let id = format!("obs-{:08}", self.next_observation);
                    let tool = message
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_owned();
                    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                    let source = parsed
                        .get("path")
                        .or_else(|| call_args.and_then(|a| a.get("path")))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    // A read result describes its captured bytes, not a later
                    // file version that may have changed before journal append.
                    let captured_revision = (tool == "read_file").then(|| parsed["source_revision"].as_str()).flatten();
                    let source_revision = captured_revision.map(str::to_owned).or_else(|| source.as_ref().and_then(|p| {
                        self.secondary_root
                            .as_ref()
                            .filter(|root| Path::new(p).starts_with(root))
                            .or(self.root.as_ref())
                            .and_then(|root| {
                                let file = fs::canonicalize(root.join(p)).ok()?;
                                if !file.starts_with(root) {
                                    return None;
                                }
                                fs::read(file)
                                    .ok()
                                    .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                            })
                    }));
                    let requested_range = call_args.map(requested_read_range);
                    let returned_range = returned_range(&parsed);
                    let meta = Observation {
                        id: id.clone(),
                        event_id: event_id.clone(),
                        call_id: message
                            .get("tool_call_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .into(),
                        tool,
                        source,
                        source_revision,
                        requested_range,
                        returned_range,
                        error: parsed.get("error").is_some() || body.starts_with("ERROR"),
                        body_sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
                        body_bytes: body.len(),
                    };
                    let path = self.dir.join("observations").join(format!("{id}.txt"));
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(path)
                        .map_err(|e| e.to_string())?;
                    file.write_all(body.as_bytes())
                        .and_then(|_| file.sync_all())
                        .map_err(|e| e.to_string())?;
                    message["content"] = json!(format!("[exact result stored as {id}]"));
                    observation = Some(meta);
                }
            }
        }
        let line = JournalLine {
            event_id: event_id.clone(),
            entry: stored,
            observation: observation.clone(),
        };
        serde_json::to_writer(&mut self.journal, &line).map_err(|e| e.to_string())?;
        self.journal
            .write_all(b"\n")
            .and_then(|_| self.journal.sync_all())
            .map_err(|e| e.to_string())?;
        self.next_event += 1;
        if let Ok(path) = std::env::var("LOCAL_AI_AGENT_TRACE_PATH") {
            let kind = match entry {
                Entry::Message(m) => m.get("role").and_then(Value::as_str).unwrap_or("message"),
                Entry::RunUser(_) => "run_user",
                Entry::Compaction { .. } => "compaction",
                Entry::Steering(_) => "steering",
                Entry::Reminder(_) => "reminder",
                Entry::ClearReminders => "clear_reminders",
                Entry::PromptTail(_) => "prompt_tail",
                Entry::Finalizing => "finalizing",
                Entry::CloseoutRequested => "closeout_requested",
                Entry::RunComplete => "run_complete",
                Entry::RuntimeNotice { .. } => "runtime_notice",
                Entry::PauseCheckpoint { .. } => "pause_checkpoint",
                Entry::WorkBudget(_) => "work_budget",
                Entry::ContextExclusion { .. } => "context_exclusion",
                Entry::LanguagePreference(_) => "language_preference",
                Entry::Evidence(_) => "established_evidence",
                Entry::EvidenceRejection { .. } => "evidence_rejection",
                Entry::Frontier(_) => "evidence_frontier",
                Entry::FrontierDisposition(_) => "frontier_disposition",
            };
            let record = json!({"run_id":self.run_id,"kind":"canonical_event","data":{
                "event_id":event_id,"event_type":kind,"observation_id":observation.as_ref().map(|o|&o.id),
                "tool_call_id":observation.as_ref().map(|o|&o.call_id),"source":observation.as_ref().and_then(|o|o.source.as_ref()),
                "revision":observation.as_ref().and_then(|o|o.source_revision.as_ref()),"body_bytes":observation.as_ref().map(|o|o.body_bytes)
            }});
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{record}");
            }
        }
        if let Some(meta) = &observation {
            self.next_observation += 1;
            self.observations.push(meta.clone());
        }
        Ok(observation)
    }

    pub fn finish(
        &self,
        base: &Path,
        history: &[Value],
        user: &str,
        image_refs: &[String],
        steering: &[String],
        final_text: &str,
    ) -> Result<(), String> {
        let mut next = history.to_vec();
        let mut current = json!({"role":"user","content":user});
        if !image_refs.is_empty() { current["image_refs"] = json!(image_refs); }
        next.push(current);
        for content in steering {
            next.push(json!({"role":"user","content":content}));
        }
        next.push(json!({"role":"assistant","content":final_text}));
        let active = Active {
            run_dir: self.dir.file_name().unwrap().to_string_lossy().into_owned(),
            expected_history_hash: history_hash(&next),
        };
        let tmp = base.join("active.json.tmp");
        fs::write(
            &tmp,
            serde_json::to_vec(&active).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(tmp, base.join("active.json")).map_err(|e| e.to_string())
    }

    pub fn read(&self, id: &str, offset: usize, limit: usize) -> Result<Value, String> {
        let root = self
            .observations
            .iter()
            .find(|observation| {
                observation.id == id
                    || observation
                        .id
                        .trim_start_matches("obs-")
                        .parse::<usize>()
                        .ok()
                        == id.trim_start_matches("obs-").parse::<usize>().ok()
            })
            .and_then(|observation| observation.source.as_deref())
            .and_then(|source| {
                self.secondary_root
                    .as_deref()
                    .filter(|root| Path::new(source).starts_with(root))
            })
            .or(self.root.as_deref());
        read_stored_observation(&self.dir, root, &self.observations, id, offset, limit)
    }

    pub fn set_secondary_root(&mut self, root: Option<&Path>) {
        self.secondary_root = root.and_then(|root| root.canonicalize().ok());
    }
}

/// Compatibility for journals whose final history anchor included host-only
/// prompt enrichment. No user text is normalized: match the full original
/// prefix and presented model answer against persisted UI history. The
/// separate host status paragraph is not model evidence or user requirements.
fn legacy_completed_matches(dir: &Path, history: &[Value]) -> bool {
    let Ok(bytes)=fs::read(dir.join("events.jsonl")) else { return false };
    let mut prefix=Vec::new(); let mut user=None; let mut answer=None; let mut complete=false; let mut references=std::collections::BTreeMap::new();
    for line in bytes.split(|b|*b==b'\n').filter(|line|!line.is_empty()) {
        let Ok(item)=serde_json::from_slice::<JournalLine>(line) else {return false};
        if let Some(observation)=item.observation {
            let source=observation.source.unwrap_or_else(||format!("{} result",observation.tool));
            references.insert(observation.id.clone(),source.clone());
            if let Some(number)=observation.id.strip_prefix("obs-").and_then(|id|id.parse::<u64>().ok()){references.insert(format!("obs-{number}"),source);}
        }
        match item.entry {
            Entry::Message(message) if user.is_none()=>prefix.push(message),
            Entry::RunUser(message)=>{if user.is_some(){return false}user=Some(message);},
            Entry::Message(message) if message.get("role").and_then(Value::as_str)==Some("assistant") && message.get("tool_calls").is_none()=>answer=Some(message),
            Entry::RunComplete=>complete=true,
            _=>{}
        }
    }
    if !complete || history.len()<prefix.len()+2 || history_hash(&prefix)!=history_hash(&history[..prefix.len()]) {return false}
    let Some(user)=user else {return false}; let Some(answer)=answer else {return false};
    let presented=crate::agent::presentation::project_answer(answer.get("content").and_then(Value::as_str).unwrap_or(""),&references);
    if presented.trim().is_empty() {return false}
    let actual=history[prefix.len()+1].get("content").and_then(Value::as_str).unwrap_or("");
    let answer_matches=actual.strip_prefix(&presented).is_some_and(|tail|tail.is_empty() || ((tail.starts_with("\n\n**Agent V2 status:** ") || tail.starts_with("\n\n**Статус Agent V2:** ")) && !tail[2..].contains('\n')));
    let current=&history[prefix.len()];
    let Some(raw)=current.get("content").and_then(Value::as_str) else {return false};
    if raw.trim().is_empty() {return false}
    let Some(enriched)=user.get("content").and_then(Value::as_str) else {return false};
    let suffix=enriched.strip_prefix(raw);
    let host_suffix=suffix.is_some_and(|s|s.is_empty() || s.starts_with("\n\n<original_task_request>\nOriginal user wording for this logical task;") || s.starts_with("\n\n<resume_progress>\nRuntime checkpoint for this same task,") || s.starts_with("\n\n<turn_evidence>\nScoped reference data for this message;"));
    let mut projected=user.clone();projected["content"]=json!(raw);projected.as_object_mut().unwrap().remove("_history_content");projected.as_object_mut().unwrap().remove("images");
    host_suffix && history_hash(&[projected])==history_hash(&[current.clone()]) && answer_matches
        && history[prefix.len()+2..].iter().all(|m|m.get("role").and_then(Value::as_str)==Some("user"))
}

/// A stopped worker can leave a partial assistant answer in Electron history
/// without calling `finish`. The next worker may extend the same conversation
/// lineage if the original history and user turn still match exactly. An edit
/// of that prefix starts a fresh lineage instead of attaching unrelated data.
fn can_resume_interrupted(base: &Path, active: &Active, history: &[Value]) -> bool {
    let Ok(bytes) = fs::read(base.join(&active.run_dir).join("events.jsonl")) else {
        return false;
    };
    let mut latest_user = None;
    let mut completed = false;
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let Ok(item) = serde_json::from_slice::<JournalLine>(line) else {
            return false;
        };
        match item.entry {
            Entry::RunComplete => completed = true,
            Entry::RunUser(value) => { latest_user = Some(value); completed = false; },
            _ => {}
        }
    }
    if completed { return false; }
    let Some(mut user) = latest_user else { return false };
    // Host metadata is journal-only; compare exact persisted UI input, without
    // normalizing or stripping arbitrary user-authored tags.
    if let Some(raw) = user.get("_history_content").cloned() {
        user["content"] = raw;
        user.as_object_mut().unwrap().remove("_history_content");
    }
    history.iter().enumerate().any(|(index, current)|
        history_hash(&history[..index]) == active.expected_history_hash
            && history_hash(&[current.clone()]) == history_hash(&[user.clone()]))
}

fn read_stored_observation(
    dir: &Path,
    root: Option<&Path>,
    observations: &[Observation],
    id: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    // Models sometimes omit or add zeroes when copying an indexed ID. Resolve
    // only a numeric spelling of an already indexed observation; never infer a
    // different observation or read an arbitrary path from an ID argument.
    let canonical = id
        .strip_prefix("obs-")
        .and_then(|digits| {
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
        })
        .and_then(|digits| digits.parse::<usize>().ok())
        .map(|number| format!("obs-{number:08}"));
    let meta = observations
        .iter()
        .find(|m| m.id == id || canonical.as_deref() == Some(m.id.as_str()))
        .ok_or_else(|| format!("unknown observation id: {id}; use an ID from observation_index"))?;
    let body = fs::read_to_string(dir.join("observations").join(format!("{}.txt", meta.id)))
        .map_err(|e| e.to_string())?;
    if format!("{:x}", Sha256::digest(body.as_bytes())) != meta.body_sha256 {
        return Err("historical observation checksum mismatch".into());
    }
    let chars: Vec<char> = body.chars().collect();
    let start = offset.min(chars.len());
    let end = (start + limit.min(16_000)).min(chars.len());
    let live = meta.source.as_ref().and_then(|p| {
        root.and_then(|root| {
            let path = fs::canonicalize(root.join(p)).ok()?;
            if !path.starts_with(root) {
                return None;
            }
            fs::read(path)
                .ok()
                .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        })
    });
    let freshness = match (&meta.source, &meta.source_revision, &live) {
        (Some(_), _, None) => "missing",
        (_, Some(old), Some(now)) if old == now => "unchanged",
        (_, Some(_), Some(_)) => "changed",
        _ => "unknown",
    };
    Ok(
        json!({"observation":meta,"historical":true,"content":chars[start..end].iter().collect::<String>(),"offset_chars":start,"total_chars":chars.len(),"more":end<chars.len(),"live_source_revision":live,"live_source_status":freshness,"source_changed":matches!(freshness,"changed"|"missing")}),
    )
}

fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_then_multiple_interruptions_keep_exact_task_lineage() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("evidence-resume-{}-{stamp}", std::process::id()));
        let first_user = json!({"role":"user","content":"first task"});
        let second_user = json!({"role":"user","content":"continue task"});
        let third_user = json!({"role":"user","content":"resume after Stop"});
        let (mut first, _) = EvidenceStore::open(&base,"first",&[],None).unwrap();
        first.append(&Entry::RunUser(first_user.clone()),None).unwrap();
        first.append(&Entry::RunComplete,None).unwrap();
        first.finish(&base,&[],"first task",&[],&[],"first answer").unwrap(); drop(first);
        let mut history = vec![first_user,json!({"role":"assistant","content":"first answer"})];
        let (mut second, entries) = EvidenceStore::open(&base,"second",&history,None).unwrap();
        assert_eq!(entries.len(),2); let lineage = second.dir.clone();
        second.append(&Entry::RunUser(second_user.clone()),None).unwrap(); drop(second);
        history.push(second_user);
        let (mut resumed, entries) = EvidenceStore::open(&base,"third",&history,None).unwrap();
        assert_eq!(resumed.dir,lineage); assert_eq!(entries.len(),3);
        resumed.append(&Entry::RunUser(third_user.clone()),None).unwrap(); drop(resumed);
        history.push(third_user);
        let (resumed, entries) = EvidenceStore::open(&base,"fourth",&history,None).unwrap();
        assert_eq!(resumed.dir,lineage); assert_eq!(entries.len(),4); drop(resumed);
        history[0]["content"] = json!("edited / unrelated task");
        let (changed, entries) = EvidenceStore::open(&base,"changed",&history,None).unwrap();
        assert_ne!(changed.dir,lineage); assert!(entries.is_empty(),"edited history cannot adopt existing evidence");
        drop(changed); fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn host_envelope_does_not_change_ui_history_identity() {
        let base = std::env::temp_dir().join(format!("evidence-host-envelope-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let raw = "Continue <turn_evidence>user-authored text</turn_evidence>";
        let enriched = format!("{raw}\n<resume_progress>host checkpoint</resume_progress>");
        let (mut first, _) = EvidenceStore::open(&base, "first", &[], None).unwrap();
        first.append(&Entry::RunUser(json!({"role":"user","content":enriched,"_history_content":raw})), None).unwrap();
        drop(first);
        let partial = vec![json!({"role":"user","content":raw}),json!({"role":"assistant","content":"partial"})];
        let (mut resumed, entries) = EvidenceStore::open(&base,"stopped",&partial,None).unwrap();
        assert_eq!(entries.len(),1,"Stop restores the exact original UI input despite the host envelope");
        resumed.append(&Entry::RunComplete,None).unwrap();
        resumed.finish(&base,&[],raw,&[],&[],"done").unwrap();drop(resumed);
        let history = vec![json!({"role":"user","content":raw}),json!({"role":"assistant","content":"done"})];
        let (again, entries) = EvidenceStore::open(&base,"completed",&history,None).unwrap();
        assert_eq!(entries.len(),2,"completed Continue retains the journal");drop(again);
        let mut edited=history;edited[0]["content"]=json!("edited task");
        let (other, entries)=EvidenceStore::open(&base,"edited",&edited,None).unwrap();
        assert!(entries.is_empty(),"user-authored tags and edited history must not be normalized away");drop(other);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn legacy_recovery_requires_exact_prefix_answer_and_unique_task_journal() {
        let base=std::env::temp_dir().join(format!("evidence-legacy-{}",std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let prefix=json!({"role":"user","content":"original route constraints"});
        let (mut first,_)=EvidenceStore::open(&base,"old",&[prefix.clone()],None).unwrap();
        first.append(&Entry::Message(prefix.clone()),None).unwrap();
        first.append(&Entry::RunUser(json!({"role":"user","content":"continue\n\n<resume_progress>\nRuntime checkpoint for this same task, not a new implementation request."})),None).unwrap();
        first.append(&Entry::Message(json!({"role":"assistant","content":"done"})),None).unwrap();
        first.append(&Entry::RunComplete,None).unwrap();
        drop(first);
        let history=vec![prefix,json!({"role":"user","content":"continue"}),json!({"role":"assistant","content":"done"})];
        let (failed,_)=EvidenceStore::open(&base,"failed",&history,None).unwrap();
        failed.rollback_open(&base).unwrap();drop(failed);
        let (recovered,entries)=EvidenceStore::open_with_recovery(&base,"retry",&history,None,true).unwrap();
        assert_eq!(recovered.dir.file_name().unwrap(),"old");assert_eq!(entries.len(),4);drop(recovered);
        let mut edited=history.clone();edited[0]["content"]=json!("different constraints");
        let (other,entries)=EvidenceStore::open_with_recovery(&base,"edited",&edited,None,true).unwrap();assert!(entries.is_empty());other.rollback_open(&base).unwrap();drop(other);
        let mut wrong_answer=history.clone();wrong_answer[2]["content"]=json!("different answer");
        let (other,entries)=EvidenceStore::open_with_recovery(&base,"answer",&wrong_answer,None,true).unwrap();assert!(entries.is_empty());other.rollback_open(&base).unwrap();drop(other);
        fs::create_dir_all(base.join("duplicate")).unwrap();fs::copy(base.join("old/events.jsonl"),base.join("duplicate/events.jsonl")).unwrap();
        // Force a legacy hash mismatch again; ambiguity cannot select a journal.
        fs::write(base.join("active.json"),br#"{"run_dir":"failed","expected_history_hash":"legacy"}"#).unwrap();
        let (other,entries)=EvidenceStore::open_with_recovery(&base,"ambiguous",&history,None,true).unwrap();assert!(entries.is_empty());drop(other);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn history_hash_preserves_legacy_sorted_object_identity() {
        let history = vec![serde_json::json!({
            "role": "assistant",
            "content": "saved",
            "metadata": {"z": 1, "a": 2}
        })];
        let legacy = br#"[{"content":"saved","metadata":{"a":2,"z":1},"role":"assistant"}]"#;
        assert_eq!(
            history_hash(&history),
            format!("{:x}", Sha256::digest(legacy))
        );
        let reordered: Vec<Value> = serde_json::from_slice(legacy).unwrap();
        assert_eq!(history_hash(&history), history_hash(&reordered));
    }

    #[test]
    fn chunked_observation_records_its_line_range_and_partial_boundaries() {
        let parsed = json!({
            "start_line": 42,
            "end_line": 50,
            "starts_mid_line": true,
            "ends_mid_line": true,
            "next_offset_chars": 8182,
            "truncated": true
        });
        assert_eq!(
            returned_range(&parsed).as_deref(),
            Some(
                "lines 42-50 (partial first and last lines) next_offset_chars=8182 truncated=true"
            )
        );
    }

    #[test]
    fn empty_chunk_does_not_claim_the_entire_source_as_returned() {
        let parsed = json!({
            "start_line": null,
            "end_line": null,
            "total_lines": 664
        });
        assert_eq!(returned_range(&parsed), None);
    }
}

#[cfg(test)]
mod image_identity_regression {
    use super::*;
    #[test]
    fn history_tracks_attachment_identity_not_transient_binary_rehydration() {
        let stable = json!({"role":"user","content":"look","image_refs":["image-1"]});
        let mut rehydrated = stable.clone(); rehydrated["images"] = json!(["data:image/jpeg;base64,/9j/"]);
        assert_eq!(history_hash(&[stable.clone()]), history_hash(&[rehydrated]));
        let mut changed = stable.clone(); changed["image_refs"] = json!(["image-2"]);
        assert_ne!(history_hash(&[stable]), history_hash(&[changed]));
    }
}
