//! End-to-end regressions for the agent loop against a scripted OpenAI-style
//! provider. They assert runtime-owned behavior only: what the model is offered
//! and told, when a tool-free reply completes the run, and that the run can
//! never be blocked from answering. They contain no project- or model-specific

use local_ai_agent_runtime::agent::loop_runtime::{
    run, Config,
};
use local_ai_agent_runtime::agent::policy::RunPolicy;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn unsupported_saved_confirmed_memory_never_reaches_provider() {
    let fixture = Workspace::new(&[("source.txt", "observed source")]);
    let provider = Provider::start(|_, _| panic!("invalid saved memory reached provider"));
    let mut config = fixture.config(&provider.endpoint, "Continue investigation");
    config.task_memory = Some(json!({"entries":[{
        "id":"saved","finding":"unsupported","status":"confirmed","evidence":"obs-99999999"
    }],"revision":1}));
    run(config);
    assert!(provider.requests().is_empty());
}

#[test]
fn confirmed_memory_rejection_is_visible_and_retry_preserves_state() {
    let fixture = Workspace::new(&[("source.txt", "observed source")]);
    let provider = Provider::start(move |request, turn| {
        let parameters = &request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "task_memory")
            .unwrap()["function"]["parameters"];
        assert_eq!(parameters["type"], "object");
        assert_eq!(parameters["properties"]["finding"]["type"], "string");
        assert_eq!(parameters["required"], json!(["action"]));
        assert!(parameters.get("oneOf").is_none());
        match turn {
            0 => Reply::Tools(vec![("read_file", json!({"path":"source.txt"}))]),
            1 => Reply::Tools(vec![("task_memory", json!({"action":"unsupported"}))]),
            2 => Reply::Tools(vec![("task_memory", json!({"action":"record"}))]),
            3 => Reply::Tools(vec![("task_memory", json!({}))]),
            4 => Reply::Tools(vec![(
                "task_memory",
                json!({
                    "action":"record","id":"fact","finding":"invalid candidate","status":"confirmed","evidence":"obs-99999999"
                }),
            )]),
            5 => {
                let messages = request["messages"].as_array().unwrap();
                assert!(messages.iter().any(|message| message["role"] == "tool"
                    && message["content"]
                        .as_str()
                        .is_some_and(|body| body.contains("unknown observation")
                            && body.contains("no memory was changed"))));
                assert!(!messages.iter().any(|message| message["role"] == "user"
                    && message["content"]
                        .as_str()
                        .is_some_and(|body| body.contains("fact [confirmed]"))));
                Reply::Tools(vec![(
                    "task_memory",
                    json!({
                        "action":"record","id":"fact","finding":"observed source","status":"confirmed","evidence":"obs-00000001"
                    }),
                )])
            }
            _ => {
                let result = request["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|message| message["role"] == "tool")
                    .unwrap();
                let body = result["content"].as_str().unwrap();
                let end = body.find("\n[observation").unwrap_or(body.len());
                let memory: Value = serde_json::from_str(&body[..end]).unwrap();
                assert_eq!(memory["task_memory"]["revision"], 1);
                assert_eq!(
                    memory["task_memory"]["entries"].as_array().unwrap().len(),
                    1
                );
                assert_eq!(
                    memory["task_memory"]["entries"][0]["finding"],
                    "observed source"
                );
                Reply::Text("Completed after a recoverable invalid evidence write.".into())
            }
        }
    });
    run(fixture.config(
        &provider.endpoint,
        "Read-only source inspection with memory",
    ));
    assert_eq!(provider.requests().len(), 7);
}

fn last_tool_result(request: &Value) -> String {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .and_then(|m| m["content"].as_str())
        .unwrap_or("")
        .to_owned()
}

fn memory_json(body: &str) -> Value {
    let end = body.find("\n[observation").unwrap_or(body.len());
    serde_json::from_str(&body[..end]).unwrap()
}

#[test]
fn task_memory_supports_create_observe_revise_cite_revise() {
    let fixture = Workspace::new(&[("source.txt", "observed source")]);
    let provider = Provider::start(|_, turn| match turn {
        // create: no id, an alias action, status still open
        0 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"add","finding":"how checkout works is not known","status":"open","next":"read source.txt"}),
        )]),
        1 => Reply::Tools(vec![("read_file", json!({"path":"source.txt"}))]),
        // a status-only update of an unknown id is explained, not silently created
        2 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"update","id":"tm-077","status":"confirmed"}),
        )]),
        // revise with an unpadded reference and a compact evidence run
        3 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"revise","id":"tm-001","finding":"checkout reads source.txt","status":"verified","evidence":"obs-1"}),
        )]),
        // revise only one field: everything else must survive
        4 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"update","id":"tm-001","next":"","implication":"nothing else to read"}),
        )]),
        // a fabricated reference is rejected with valid ones named
        5 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"record","id":"fake","finding":"made up","status":"confirmed","observations":["obs-00000099"]}),
        )]),
        // cite through the array form and revise the confirmed finding
        6 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"update","id":"tm-001","finding":"checkout reads source.txt only","observations":["obs-00000001"]}),
        )]),
        _ => Reply::Text("Checkout reads source.txt.".into()),
    });
    run(fixture.config(&provider.endpoint, "Investigate checkout and keep notes"));
    let requests = provider.requests();
    assert_eq!(requests.len(), 8);

    let created = memory_json(&last_tool_result(&requests[1]));
    assert_eq!(created["id"], "tm-001");
    assert_eq!(created["task_memory"]["entries"][0]["status"], "unknown");

    let unknown = last_tool_result(&requests[3]);
    assert!(
        unknown.contains("no entry 'tm-077'") || unknown.contains("There is no entry 'tm-077'"),
        "{unknown}"
    );
    assert!(
        unknown.contains("tm-001"),
        "the error must list existing ids: {unknown}"
    );

    let cited = memory_json(&last_tool_result(&requests[4]));
    let entry = &cited["task_memory"]["entries"][0];
    assert_eq!(entry["status"], "confirmed");
    assert_eq!(
        entry["evidence"], "obs-00000001",
        "an unpadded reference must be normalized"
    );
    assert_eq!(entry["next"], "read source.txt");

    let partial = memory_json(&last_tool_result(&requests[5]));
    let entry = &partial["task_memory"]["entries"][0];
    assert_eq!(
        entry["finding"], "checkout reads source.txt",
        "an update without finding must keep it"
    );
    assert_eq!(entry["evidence"], "obs-00000001");
    assert_eq!(entry["status"], "confirmed");
    assert_eq!(entry["next"], "", "an empty string clears a field");
    assert_eq!(entry["implication"], "nothing else to read");

    let rejected = last_tool_result(&requests[6]);
    assert!(
        rejected.contains("obs-00000099") && rejected.contains("obs-00000001"),
        "{rejected}"
    );
    assert!(rejected.contains("no memory was changed"));

    let revised = memory_json(&last_tool_result(&requests[7]));
    assert_eq!(
        revised["task_memory"]["entries"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        revised["task_memory"]["entries"][0]["finding"],
        "checkout reads source.txt only"
    );
    assert_eq!(
        revised["task_memory"]["entries"][0]["evidence"],
        "obs-00000001"
    );
}

#[test]
fn two_project_reads_have_distinct_evidence_and_model_visible_scope() {
    let fixture = Workspace::new(&[("first-only.txt", "primary identity")]);
    let secondary = fixture.base.join("secondary");
    std::fs::create_dir_all(&secondary).unwrap();
    std::fs::write(secondary.join("second-only.txt"), "secondary identity").unwrap();
    let secondary_name = secondary.to_string_lossy().into_owned();
    let expected = secondary_name.clone();
    let provider = Provider::start(move |request, turn| {
        assert!(request["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains(&expected));
        if turn == 0 {
            assert!(request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == "read_file"
                    && tool["function"]["parameters"]["properties"]["project"]["enum"]
                        == json!([1, 2])));
            Reply::Tools(vec![
                ("read_file", json!({"path":"first-only.txt","project":1})),
                ("read_file", json!({"path":"second-only.txt","project":2})),
            ])
        } else {
            let tools = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["role"] == "tool")
                .map(|entry| entry["content"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert!(tools.iter().any(|body| body.contains("primary identity")));
            assert!(tools.iter().any(|body| body.contains("secondary identity")));
            Reply::Text("Project 1: obs-00000001. Project 2: obs-00000002.".into())
        }
    });
    let mut config = fixture.config(&provider.endpoint, "read-only compare two projects");
    config.secondary_root = Some(secondary_name.clone());
    run(config);
    let evidence = fixture.base.join("evidence");
    let active: Value =
        serde_json::from_slice(&std::fs::read(evidence.join("active.json")).unwrap()).unwrap();
    let journal = std::fs::read_to_string(
        evidence
            .join(active["run_dir"].as_str().unwrap())
            .join("events.jsonl"),
    )
    .unwrap();
    let observations = journal
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter_map(|entry| {
            entry
                .get("observation")
                .filter(|observation| !observation.is_null())
                .cloned()
        })
        .collect::<Vec<_>>();
    assert_eq!(observations.len(), 2);
    assert_eq!(observations[0]["source"], "first-only.txt");
    assert_eq!(
        observations[1]["source"],
        format!("{secondary_name}/second-only.txt")
    );
    assert!(observations
        .iter()
        .all(|observation| observation["source_revision"].as_str().is_some()));
}

#[test]
fn steering_at_completion_is_applied_before_final_and_replays() {
    let fixture = Workspace::new(&[("identity.txt", "steering evidence")]);
    let queue = Arc::new(Mutex::new(Vec::new()));
    let incoming = queue.clone();
    let provider = Provider::start(move |request, turn| {
        if turn == 0 {
            incoming
                .lock()
                .unwrap()
                .push("Read identity.txt before answering; include STEER_OK.".into());
            Reply::Text("Premature answer".into())
        } else if turn == 1 {
            assert!(request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["role"] == "user"
                    && entry["content"]
                        .as_str()
                        .is_some_and(|text| text.contains("STEER_OK"))));
            Reply::Tools(vec![("read_file", json!({"path":"identity.txt"}))])
        } else {
            Reply::Text("STEER_OK".into())
        }
    });
    let mut config = fixture.config(&provider.endpoint, "inspect");
    config.steering = queue;
    run(config);
    let history = vec![
        json!({"role":"user","content":"inspect"}),
        json!({"role":"user","content":"Read identity.txt before answering; include STEER_OK."}),
        json!({"role":"assistant","content":"STEER_OK"}),
    ];
    let restored = local_ai_agent_runtime::agent::transcript::Transcript::durable(
        &fixture.base.join("evidence"),
        "next-run",
        &history,
        fixture.root.to_str(),
    )
    .unwrap();
    assert!(restored.entries().iter().any(|entry| matches!(entry, local_ai_agent_runtime::agent::transcript::Entry::Steering(content) if content.contains("STEER_OK"))));
    assert_eq!(restored.observations().len(), 1);
}

/// Explicit Pause persists the runtime snapshot without asking the model to repair old plans.
#[test]
fn a_structured_pause_checkpoints_and_ends_without_resuming_guidance() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let pause = Arc::new(AtomicBool::new(false));
    let flag = pause.clone();
    let provider = Provider::start(move |_, n| match n {
        0 => add_both(),
        1 => Reply::Tools(vec![("write_file", json!({"path":"a.txt","content":"changed"}))]),
        2 => { flag.store(true, Ordering::Relaxed); Reply::Tools(vec![("write_file", json!({"path":"a.txt","content":"must not execute"}))]) },
        _ => panic!("Pause must not request a model-generated checkpoint"),
    });
    let mut config = workspace.config(&provider.endpoint, TWO_PART_REQUEST);
    config.pause_requested = pause;
    run(config);
    assert_eq!(std::fs::read_to_string(workspace.root.join("a.txt")).unwrap(), "changed");
    let journal = workspace.journal();
    let checkpoint = journal.iter().find_map(|e| e.get("PauseCheckpoint")).expect("durable runtime checkpoint");
    assert!(checkpoint.to_string().contains("theme switch"));
    assert!(!completed(&journal), "Paused work must not be marked complete in the journal");
    assert_eq!(provider.requests().len(), 3);
}

#[test]
fn pause_received_during_generation_blocks_new_mutations_before_the_checkpoint() {
    let workspace = Workspace::new(&[("a.txt", "original")]);
    let pause = Arc::new(AtomicBool::new(false));
    let flag = pause.clone();
    let provider = Provider::start(move |_, _| {
        flag.store(true, Ordering::Relaxed);
        Reply::Tools(vec![("write_file", json!({"path":"a.txt","content":"must not execute"}))])
    });
    let mut config = workspace.config(&provider.endpoint, "edit a.txt");
    config.pause_requested = pause;
    let started = std::time::Instant::now();
    run(config);
    eprintln!("Pause during generation: {:?}", started.elapsed());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(std::fs::read_to_string(workspace.root.join("a.txt")).unwrap(), "original");
    assert!(workspace.journal().iter().any(|e| e.get("PauseCheckpoint").is_some()));
    assert_eq!(provider.requests().len(), 1);
}

#[test]
fn a_pause_is_bounded_even_if_the_model_keeps_calling_tools_or_stays_silent() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, _| panic!("No model request allowed after accepting Pause"));
    let mut config = workspace.config(&provider.endpoint, "Do a long task");
    config.pause_requested = Arc::new(AtomicBool::new(true));
    let started = std::time::Instant::now();
    run(config);
    eprintln!("Pause before next step: {:?}", started.elapsed());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert!(workspace.journal().iter().any(|e| e.get("PauseCheckpoint").is_some()));
    assert!(provider.requests().is_empty());
}

/// Natural-language classification belongs to the model: the pause tool is offered only right after a steering
/// message, an ordinary clarification keeps the run going, and a call outside that window is refused.
#[test]
fn the_pause_tool_is_offered_only_after_steering_and_a_clarification_does_not_pause() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let queue = Arc::new(Mutex::new(Vec::new()));
    let incoming = queue.clone();
    let provider = Provider::start(move |request, n| match n {
        0 => {
            assert!(!tool_names(request).contains(&"pause_run".to_owned()));
            incoming
                .lock()
                .unwrap()
                .push("Не останавливайся, проверь ещё b.txt".into());
            Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))])
        }
        1 => {
            assert!(tool_names(request).contains(&"pause_run".to_owned()));
            assert!(user_turn_context(request).contains("pause_run"));
            Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))])
        }
        2 => {
            assert!(!tool_names(request).contains(&"pause_run".to_owned()));
            Reply::Tools(vec![("pause_run", json!({}))])
        }
        3 => {
            let refused = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "tool")
                .unwrap();
            assert!(refused["content"].as_str().unwrap().contains("unavailable"));
            assert!(
                tool_names(request).contains(&"read_file".to_owned()),
                "a refused pause_run must not restrict the run"
            );
            Reply::Text("Checked, continuing normally.".into())
        }
        _ => unreachable!(),
    });
    let mut config = workspace.config(&provider.endpoint, "Inspect a.txt");
    config.steering = queue;
    run(config);
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(), 4);
}

#[test]
fn a_model_classified_pause_restricts_tools_and_ends_the_run() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let queue = Arc::new(Mutex::new(Vec::new()));
    let incoming = queue.clone();
    let provider = Provider::start(move |request, n| match n {
        0 => {
            incoming
                .lock()
                .unwrap()
                .push("Хватит, остановись на этом месте".into());
            Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))])
        }
        1 => Reply::Tools(vec![("pause_run", json!({}))]),
        2 => {
            assert!(!tool_names(request).contains(&"read_file".to_owned()));
            assert!(request.to_string().contains("<run_paused>"));
            Reply::Text("Paused after reading a.txt.".into())
        }
        _ => unreachable!(),
    });
    let mut config = workspace.config(&provider.endpoint, "Inspect a.txt thoroughly");
    config.steering = queue;
    run(config);
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(), 3);
}

/// A hard cancel keeps priority over the graceful lifecycle.
#[test]
fn hard_cancel_still_stops_a_pausing_run_without_another_request() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, _| Reply::Text("never requested".into()));
    let mut config = workspace.config(&provider.endpoint, "task");
    config.steering = Arc::new(Mutex::new(vec!["Пауза".to_owned()]));
    config.pause_requested = Arc::new(AtomicBool::new(true));
    config.cancelled = Arc::new(AtomicBool::new(true));
    run(config);
    assert!(provider.requests().is_empty());
    assert!(!completed(&workspace.journal_or_empty()));
}

#[test]
fn same_relative_path_in_two_projects_is_not_an_unchanged_duplicate() {
    let fixture = Workspace::new(&[("shared.txt", "primary content")]);
    let secondary = fixture.base.join("secondary");
    std::fs::create_dir_all(&secondary).unwrap();
    std::fs::write(secondary.join("shared.txt"), "secondary content").unwrap();
    let provider = Provider::start(|request, turn| match turn {
        0 => Reply::Tools(vec![("read_file", json!({"path":"shared.txt","project":1}))]),
        1 => Reply::Tools(vec![("read_file", json!({"path":"shared.txt","project":2}))]),
        _ => {
            let result = request["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "tool").unwrap();
            assert!(result["content"].as_str().unwrap().contains("secondary content"), "{result}");
            Reply::Text("Compared both actual project files.".into())
        }
    });
    let mut config = fixture.config(&provider.endpoint, "Read-only compare shared.txt in both projects");
    config.secondary_root = Some(secondary.to_string_lossy().into_owned());
    run(config);
    assert_eq!(provider.requests().len(), 3);
}

enum Reply {
    Text(String),
    /// Only reasoning, no content and no structured call.
    Reasoning(String),
    Tools(Vec<(&'static str, Value)>),
    ProgressTools(String, Vec<(&'static str, Value)>),
    /// Reasoning streamed first, then structured calls.
    ReasonedTools(String, Vec<(&'static str, Value)>),
    /// Reasoning streamed first, then visible content.
    ReasonedText(String, String),
}

struct Provider {
    endpoint: String,
    requests: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
}

impl Provider {
    fn start(mut script: impl FnMut(&Value, usize) -> Reply + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (log, halt) = (requests.clone(), stop.clone());
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let mut served = 0_usize;
            while !halt.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                let mut raw = Vec::new();
                let mut chunk = [0_u8; 8192];
                let (body_start, length) = loop {
                    let read = stream.read(&mut chunk).unwrap();
                    raw.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while raw.len() < body_start + length {
                    let read = stream.read(&mut chunk).unwrap();
                    raw.extend_from_slice(&chunk[..read]);
                }
                let request: Value =
                    serde_json::from_slice(&raw[body_start..body_start + length]).unwrap();
                assert_template_turns(&request);
                let reply = script(&request, served);
                log.lock().unwrap().push(request);
                served += 1;
                let mut out = String::from("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                let frame = |delta: Value, finish: Option<&str>| {
                    format!(
                        "data: {}\n\n",
                        json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
                    )
                };
                match reply {
                    Reply::Text(text) => {
                        out.push_str(&frame(json!({"content": text}), None));
                        out.push_str(&frame(json!({}), Some("stop")));
                    }
                    Reply::Reasoning(text) => {
                        out.push_str(&frame(json!({"reasoning_content": text}), None));
                        out.push_str(&frame(json!({}), Some("stop")));
                    }
                    Reply::ReasonedText(reasoning, text) => {
                        out.push_str(&frame(json!({"reasoning_content": reasoning}), None));
                        out.push_str(&frame(json!({"content": text}), None));
                        out.push_str(&frame(json!({}), Some("stop")));
                    }
                    Reply::ReasonedTools(reasoning, calls) => {
                        out.push_str(&frame(json!({"reasoning_content": reasoning}), None));
                        let calls = calls
                            .into_iter()
                            .enumerate()
                            .map(|(index, (name, arguments))| json!({"index":index,"id":format!("call_{served}_{index}"),"type":"function","function":{"name":name,"arguments":arguments.to_string()}}))
                            .collect::<Vec<_>>();
                        out.push_str(&frame(json!({"tool_calls": calls}), None));
                        out.push_str(&frame(json!({}), Some("tool_calls")));
                    }
                    Reply::ProgressTools(text, calls) => {
                        out.push_str(&frame(json!({"content": text}), None));
                        let calls = calls.into_iter().enumerate()
                            .map(|(index, (name, arguments))| json!({"index":index,"id":format!("call_{served}_{index}"),"type":"function","function":{"name":name,"arguments":arguments.to_string()}})).collect::<Vec<_>>();
                        out.push_str(&frame(json!({"tool_calls":calls}), None));
                        out.push_str(&frame(json!({}), Some("tool_calls")));
                    }
                    Reply::Tools(calls) => {
                        let calls = calls
                            .into_iter()
                            .enumerate()
                            .map(|(index, (name, arguments))| json!({"index":index,"id":format!("call_{served}_{index}"),"type":"function","function":{"name":name,"arguments":arguments.to_string()}}))
                            .collect::<Vec<_>>();
                        out.push_str(&frame(json!({"tool_calls": calls}), None));
                        out.push_str(&frame(json!({}), Some("tool_calls")));
                    }
                }
                out.push_str("data: [DONE]\n\n");
                let _ = stream.write_all(out.as_bytes());
            }
        });
        Self {
            endpoint,
            requests,
            stop,
        }
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

struct Workspace {
    base: PathBuf,
    root: PathBuf,
}

impl Workspace {
    fn new(files: &[(&str, &str)]) -> Self {
        let base = std::env::temp_dir().join(format!(
            "agent-loop-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let root = base.join("project");
        for (path, content) in files {
            let full = root.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, content).unwrap();
        }
        Self {
            root: root.canonicalize().unwrap(),
            base,
        }
    }

    fn config(&self, endpoint: &str, user: &str) -> Config {
        Config {
            run_id: format!("run-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
            endpoint: endpoint.into(),
            model: "scripted".into(),
            system: "system".into(),
            ui_language: None,
            user: user.into(),
            user_images: Vec::new(), user_image_refs: Vec::new(), web_tools: Vec::new(), artifact_tools: Vec::new(), attachment_tools: Vec::new(), host_tools: Some(Arc::new(local_ai_agent_runtime::tools::web::HostTools::with_dispatch(|name, args| {
                if name != "request_permission" { return None; }
                // Scripted fixture user authorizes project execution/deletion;
                // Git mutations remain denied in refusal regressions.
                let command = args.pointer("/arguments/command").and_then(Value::as_str).unwrap_or("");
                let target=args.pointer("/arguments/path").and_then(Value::as_str).map(PathBuf::from);
                let root=args.get("root").and_then(Value::as_str).map(PathBuf::from);
                let outside=target.as_ref().is_some_and(|p|p.is_absolute() && !root.as_ref().is_some_and(|root|p.starts_with(root)));
                let approved = !outside && !command.contains("git ") && command != "echo a && echo b";
                Some(json!({"approved":approved,"reason":if approved { "once" } else { "user_rejected" }}))
            }))),
            root: Some(self.root.to_string_lossy().into_owned()),
            secondary_root: None,
            workspace_roots: Vec::new(),
            context_limit: 65_536,
            reasoning_mode: "fast".into(),
            supports_reasoning: true,
            reasoning_options: None,
            policy: RunPolicy::Auto,
            history: Vec::new(),
            evidence_dir: Some(self.base.join("evidence").to_string_lossy().into_owned()),
            task_memory: None,
            provider_max_output: None,
            browser_capability: Some(false),
            browser_qa: false,
            cancelled: Arc::new(AtomicBool::new(false)),
            steering: Arc::new(Mutex::new(Vec::new())),
            steering_closed: Arc::new(AtomicBool::new(false)),
            pause_requested: Arc::new(AtomicBool::new(false)),
            control: Arc::new(Mutex::new(Default::default())),
        }
    }

    fn journal_or_empty(&self) -> Vec<Value> {
        if self.base.join("evidence").join("active.json").exists() {
            self.journal()
        } else {
            Vec::new()
        }
    }

    fn journal(&self) -> Vec<Value> {
        let evidence = self.base.join("evidence");
        let active: Value =
            serde_json::from_slice(&std::fs::read(evidence.join("active.json")).unwrap()).unwrap();
        let path = evidence
            .join(active["run_dir"].as_str().unwrap())
            .join("events.jsonl");
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["entry"].clone())
            .collect()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

const READ_ONLY: &str =
    "Audit the product, architecture, backend, history and quality. Do not modify files.";

fn withheld_drafts(journal: &[Value]) -> usize {
    journal
        .iter()
        .filter(|entry| entry.pointer("/Message/_runtime_draft_status").is_some())
        .count()
}

fn completed(journal: &[Value]) -> bool {
    journal.iter().any(|entry| entry == &json!("RunComplete"))
}

// Enforce the embedded Devstral template's ordinary-turn parity for every
// production loop fixture, including all existing Stage A/verification tests.
// Tool calls/results continue the assistant turn and do not advance parity.
fn assert_template_turns(request: &Value) {
    let messages = request["messages"].as_array().unwrap();
    assert_eq!(messages[0]["role"], "system");
    let mut expects_user = true;
    for message in messages.iter().skip(1) {
        let calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty());
        assert_ne!(message["role"], "system", "only one initial system turn");
        if message["role"] == "user" || (message["role"] == "assistant" && !calls) {
            assert_eq!(
                message["role"] == "user",
                expects_user,
                "invalid template sequence: {messages:?}"
            );
            expects_user = !expects_user;
        }
    }
}

#[test]
fn registered_and_future_families_share_valid_initial_and_multiple_tool_turns() {
    for model in [
        "qwen3.8:27b-q4_K_M",
        "huihui-qwen3.8:27b-ud-dw-q4_k_m",
        "devstral-small-2:24b-q4_k_m",
        "gemma4:31b-it-q4_k_m",
        "future-registered-model",
    ] {
        let fixture = Workspace::new(&[("a.txt", "a"), ("b.txt", "b")]);
        let provider = Provider::start(|request, n| {
            assert_template_turns(request);
            match n {
                0 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
                1 => Reply::Tools(vec![("read_file", json!({"path":"b.txt"}))]),
                2 => Reply::Tools(vec![("list_directory", json!({"path":"."}))]),
                _ => Reply::Text("Both files inspected.".into()),
            }
        });
        let mut config = fixture.config(&provider.endpoint, READ_ONLY);
        config.model = model.to_owned();
        config.supports_reasoning = !model.starts_with("devstral");
        run(config);
        assert!(completed(&fixture.journal()), "{model}");
        assert_eq!(provider.requests().len(), 4, "{model}");
        let requests = provider.requests();
        assert_eq!(requests[0]["messages"].as_array().unwrap().len(), 2);
        assert_eq!(
            requests[3]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "tool")
                .count(),
            3
        );
    }
}

fn latest_runtime_section(request: &Value, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let cleared = format!("Runtime section cleared: {tag}.");
    for message in request["messages"].as_array().unwrap().iter().rev() {
        let text = message["content"].as_str().unwrap_or("");
        if text.contains(&cleared) { return String::new(); }
        if let Some(start) = text.rfind(&open) {
            if let Some(end) = text[start..].find(&close) {
                return text[start..start + end + close.len()].to_owned();
            }
        }
    }
    String::new()
}

fn user_turn_context(request: &Value) -> String {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        // Runtime-owned state is attached to tool boundaries; actual steering
        // retains its explicit continued-user attribution.
        .filter(|m| m["role"] == "user" || m["role"] == "tool")
        .filter_map(|m| {
            let text = m["content"].as_str().unwrap_or("");
            if m["role"] == "user" {
                Some(text.to_owned())
            } else {
                text.split_once("[AGENT RUNTIME STATE — NOT A USER MESSAGE]\n")
                    .or_else(|| text.split_once("[CONTINUED USER TURN — NOT TOOL OUTPUT]\n"))
                    .map(|(_, tail)| tail.to_owned())
            }
        })
        .collect::<Vec<_>>()
        .join("\n---\n")
}

fn tool_names(request: &Value) -> Vec<String> {
    request["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| {
                    t.pointer("/function/name")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

const SHOP: &[(&str, &str)] = &[
    ("package.json", "{\"name\":\"shop\"}"),
    (
        "src/Form.tsx",
        "export const send = () => fetch('api.php', { method: 'POST' });",
    ),
    ("src/Home.tsx", "export const home = 1;"),
    ("public/api.php", "<?php echo 'ok';"),
];

/// Failure shape: prose naming requested areas (a plan note, narration) used to
/// be graded as coverage, which drove closeout/finalization transitions and
/// blocked or forced final answers. A tool-free reply must simply complete.
#[test]
fn a_tool_free_answer_completes_regardless_of_plan_notes_and_area_words() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            ("read_file", json!({"path":"src/Home.tsx"})),
            ("read_file", json!({"path":"package.json"})),
        ]),
        1 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"record","finding":"Plan: audit product, architecture, backend order flow, history and quality","evidence":"obs-00000001, obs-00000002","next":"read backend"}),
        )]),
        _ => Reply::Text("Final audit: product, architecture, backend, history, quality.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 0, "no draft may be withheld");
    let requests = provider.requests();
    assert_eq!(requests.len(), 3, "answer on the first tool-free reply");
    for request in &requests {
        let text = request.to_string();
        for removed in [
            "closeout_gap",
            "closeout_reason",
            "evidence_record",
            "evidence_frontier",
            "begin_finalization",
            "verification_of",
        ] {
            assert!(!text.contains(removed), "{removed}");
        }
        assert!(tool_names(request).contains(&"read_file".to_owned()));
    }
}

/// Failure shape: a final answer must never be blocked by a condition the
/// model cannot see or satisfy. The only deviation from "tool-free completes"
/// is one bounded reminder, and it names concrete files.
#[test]
fn unopened_requested_files_get_exactly_one_reminder_and_never_block_the_answer() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"src/Form.tsx"}))]),
        1 => Reply::Text("Draft A: there is no backend.".into()),
        _ => Reply::Text("Draft B: the form posts to api.php, which I did not inspect.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(
        withheld_drafts(&journal),
        1,
        "only the first draft is held back"
    );
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    let reminded = user_turn_context(&requests[2]);
    assert!(reminded.contains("Before finishing"), "{reminded}");
    assert!(reminded.contains("public/api.php"), "{reminded}");
    assert!(
        !user_turn_context(&requests[1]).contains("Before finishing"),
        "no reminder before a draft exists"
    );
    // the state the model sees names the unopened target on every turn
    assert!(user_turn_context(&requests[1])
        .contains("public/api.php <- request/submit target 'api.php'"));
    let accepted = journal
        .iter()
        .rev()
        .find_map(|e| {
            e.pointer("/Message/content")
                .and_then(Value::as_str)
                .filter(|c| c.starts_with("Draft"))
        })
        .unwrap();
    assert!(accepted.starts_with("Draft B"));
}

#[test]
fn opening_the_requested_file_removes_the_reminder_and_answer_is_accepted_immediately() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"src/Form.tsx"}))]),
        1 => Reply::Tools(vec![("read_file", json!({"path":"public/api.php"}))]),
        _ => Reply::Text("The form posts to api.php, which echoes ok.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 0);
    assert_eq!(provider.requests().len(), 3);
}

#[test]
fn no_reminder_without_a_concrete_unopened_request() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"src/Home.tsx"}))]),
        _ => Reply::Text("Home exports a constant.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert_eq!(withheld_drafts(&workspace.journal()), 0);
    assert_eq!(provider.requests().len(), 2);
}

/// Repeated identical actions pause a CLI run without exhausting productive work.
#[test]
fn repeated_observations_checkpoint_but_do_not_reintroduce_a_work_allowance() {
    let workspace=Workspace::new(SHOP);
    let provider=Provider::start(|request,_| {
        if request.get("tools").is_some(){Reply::Tools(vec![("list_directory",json!({"path":"."}))])}
        else {Reply::Text("Paused after repeated identical observations; task unfinished.".into())}
    });
    run(workspace.config(&provider.endpoint,READ_ONLY));
    assert!(provider.requests().len()<30);
    let journal=workspace.journal();
    assert!(journal.iter().any(|e|e.get("RuntimeNotice").is_some()));
    assert_eq!(saved_work_budget(&workspace).limit,0);
}

/// Failure shape: a turn that produced neither content nor a structured call
/// (a tool call written inside the reasoning stream is never executed) used to
/// complete the run with an empty answer.
#[test]
fn an_empty_response_never_completes_the_run() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| {
        match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"src/Home.tsx"}))]),
        1 => Reply::Reasoning("Next I will read more.<tool_call>read_file<arg_key>path</arg_key><arg_value>src</arg_value></tool_call>".into()),
        _ => Reply::Text("The real answer.".into()),
    }
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    let journal = workspace.journal();
    assert!(completed(&journal));
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    assert!(
        user_turn_context(&requests[2]).contains("neither an answer nor a structured tool call")
    );
    assert!(tool_names(&requests[2]).contains(&"read_file".to_owned()));
    let answers = journal
        .iter()
        .filter_map(|e| e.pointer("/Message/content").and_then(Value::as_str))
        .filter(|c| c.contains("The real answer"))
        .count();
    assert_eq!(answers, 1);
}

#[test]
fn persistent_empty_responses_force_a_tool_free_answer_turn() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|request, _| {
        if request.get("tools").is_some() {
            Reply::Text(String::new())
        } else {
            Reply::Text("Answer once tools were withdrawn.".into())
        }
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert_eq!(requests.len(), 4);
    let last = requests.last().unwrap();
    assert!(last.get("tools").is_none());
    assert!(user_turn_context(last).contains("MODE: FINALIZING"));
}

#[test]
fn reasoning_only_finalizing_turn_retries_without_reasoning_and_accepts_visible_answer() {
    let workspace = Workspace::new(SHOP);
    let mut config = workspace.config("unused", READ_ONLY);
    config.reasoning_mode = "deep".into();
    let provider = Provider::start(|request, _| {
        if request.pointer("/chat_template_kwargs/enable_thinking") == Some(&json!(false)) {
            Reply::Text("Visible final answer.".into())
        } else {
            Reply::Reasoning("I will synthesize the answer now.".into())
        }
    });
    config.endpoint = provider.endpoint.clone();
    run(config);
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert!(requests.len() >= 2);
    assert_eq!(
        requests.last().unwrap()["chat_template_kwargs"]["enable_thinking"],
        false,
        "finalizing request must explicitly disable supported reasoning"
    );
    assert!(requests.last().unwrap().get("tools").is_none());
    assert!(workspace.journal().iter().any(|entry| {
        entry
            .pointer("/Message/content")
            .and_then(Value::as_str)
            .is_some_and(|content| content.contains("Visible final answer"))
    }));
}

/// Failure shape: a single turn of parallel reads larger than the whole window
/// (here 8 files of 60 KB against a 16K window). Results are now bounded by the
/// window at creation and carry a continuation offset, instead of being
/// replaced by receipts later and recovered with `observation_read` bursts
/// that, being exact, could not be fitted (a `context_budget` run failure).
#[test]
fn a_burst_of_large_reads_cannot_exceed_a_small_window() {
    let big = "x".repeat(60_000);
    let files = (0..8)
        .map(|i| (format!("data/file{i}.json"), big.clone()))
        .collect::<Vec<_>>();
    let refs = files
        .iter()
        .map(|(p, c)| (p.as_str(), c.as_str()))
        .collect::<Vec<_>>();
    let workspace = Workspace::new(&refs);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(
            (0..8)
                .map(|i| ("read_file", json!({"path": format!("data/file{i}.json")})))
                .collect(),
        ),
        _ => Reply::Text("Summary of the data files.".into()),
    });
    let mut config = workspace.config(
        &provider.endpoint,
        "Summarize the data files. Do not modify files.",
    );
    config.context_limit = 16_384;
    run(config);
    let journal = workspace.journal();
    assert!(completed(&journal), "the run must survive the burst");
    let second = &provider.requests()[1];
    let tool_chars = second["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| m["content"].as_str().unwrap_or("").chars().count())
        .sum::<usize>();
    assert!(
        tool_chars < 16_384 * 3 / 2,
        "results must fit the window: {tool_chars} chars"
    );
    let first_result = second["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    // Provider projection may use the bounded historical receipt. Its
    // continuation metadata must survive; exact results remain in immutable observations.
    assert!(first_result.contains("\"truncated\":true") || first_result.contains("truncated=true"));
    let evidence = workspace.base.join("evidence");
    let active: Value = serde_json::from_slice(&std::fs::read(evidence.join("active.json")).unwrap()).unwrap();
    let observations = evidence.join(active["run_dir"].as_str().unwrap()).join("observations");
    for index in 1..=8 {
        let body=std::fs::read_to_string(observations.join(format!("obs-{index:08}.txt"))).unwrap();
        let exact: Value=serde_json::from_str(body.lines().next().unwrap()).unwrap();
        assert_eq!(exact["truncated"],true,"read {index} must remain bounded in durable storage");
        assert!(exact["next_offset_chars"].as_u64().unwrap()>0,"read {index} needs a continuation");
    }
    assert!(first_result.contains("next_offset_chars"));
}

/// Failure shape: reasoning was dropped from the record, so a thinking model's
/// template rendered every earlier assistant turn with empty thinking and the
/// model re-derived its plan on each step.
#[test]
fn reasoning_is_recorded_and_replayed_with_the_assistant_turn_that_produced_it() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::ReasonedTools(
            "PLAN-ALPHA: read the form first".into(),
            vec![("read_file", json!({"path":"src/Form.tsx"}))],
        ),
        1 => Reply::ReasonedTools(
            "PLAN-BETA: then the endpoint".into(),
            vec![("read_file", json!({"path":"public/api.php"}))],
        ),
        _ => Reply::ReasonedText("ALL-DONE".into(), "The form posts to api.php.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    let assistants = |request: &Value| {
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "assistant")
            .map(|m| {
                m.get("reasoning_content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            })
            .collect::<Vec<_>>()
    };
    assert!(assistants(&requests[0]).is_empty());
    assert_eq!(
        assistants(&requests[1]),
        vec!["PLAN-ALPHA: read the form first"]
    );
    assert_eq!(
        assistants(&requests[2]),
        vec![
            "PLAN-ALPHA: read the form first",
            "PLAN-BETA: then the endpoint"
        ]
    );
    // The durable record keeps it too, so a restart replays the same bytes.
    let journal = workspace.journal();
    assert!(journal.iter().any(|entry| entry
        .pointer("/Message/reasoning_content")
        .and_then(Value::as_str)
        == Some("PLAN-BETA: then the endpoint")));
}

/// Failure shape: a turn with only reasoning left no trace, so the retry
/// regenerated the same reasoning from nothing, indefinitely.
#[test]
fn a_reasoning_only_turn_is_visible_to_the_retry() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Reasoning("DRAFT-IN-THINKING: the report is: form posts to api.php".into()),
        _ => Reply::Text("The form posts to api.php.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    let retry = requests[1]["messages"].as_array().unwrap();
    assert!(
        retry.iter().any(|m| m["role"] == "assistant"
            && m["reasoning_content"] == "DRAFT-IN-THINKING: the report is: form posts to api.php"),
        "the retry did not carry the reasoning-only turn"
    );
    assert!(
        user_turn_context(&requests[1]).contains("neither an answer nor a structured tool call")
    );
}

#[test]
fn a_provider_without_reasoning_never_receives_replayed_reasoning() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::ReasonedTools(
            "hidden".into(),
            vec![("read_file", json!({"path":"src/Form.tsx"}))],
        ),
        _ => Reply::Text("done".into()),
    });
    let mut config = workspace.config(&provider.endpoint, READ_ONLY);
    config.supports_reasoning = false;
    run(config);
    assert!(!provider.requests()[1]
        .to_string()
        .contains("reasoning_content"));
}

fn tool_result_text(request: &Value) -> String {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| m["content"].as_str().unwrap_or("").to_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

const EXECUTION_TOOLS: &[&str] = &[
    "apply_patch",
    "create_file",
    "delete_file",
    "list_directory",
    "read_file",
    "replace_text",
    "run_terminal",
    "write_file",
];

/// No selected project, but the user named a directory: the model must receive
/// execution tools scoped to it, actually run them, and see the real result.
#[test]
fn explicit_directory_without_a_project_exposes_execution_tools_and_really_executes() {
    let workspace = Workspace::new(&[("granted/keep.txt", "keep")]);
    let granted = workspace.root.join("granted");
    let target = granted.join("Шашки");
    let outside = workspace.root.join("outside.txt");
    let (target_arg, outside_arg) = (
        target.to_string_lossy().into_owned(),
        outside.to_string_lossy().into_owned(),
    );
    let provider = Provider::start(move |_, n| match n {
        0 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command": format!("mkdir '{target_arg}'")}),
        )]),
        1 => Reply::Tools(vec![(
            "create_file",
            json!({"path": outside_arg, "content": "must not exist"}),
        )]),
        2 => Reply::Tools(vec![("list_directory", json!({"path": "."}))]),
        _ => Reply::Text("done".into()),
    });
    let mut config = workspace.config(&provider.endpoint, "create the folder");
    config.root = None;
    config.workspace_roots = vec![granted.to_string_lossy().into_owned()];
    run(config);
    assert!(target.is_dir(), "the terminal command did not run");
    assert!(
        !outside.exists(),
        "a file tool escaped the granted directory"
    );
    let requests = provider.requests();
    let names = tool_names(&requests[0]);
    for tool in EXECUTION_TOOLS {
        assert!(
            names.contains(&(*tool).to_owned()),
            "{tool} missing: {names:?}"
        );
    }
    assert!(requests[0]
        .to_string()
        .contains(&granted.to_string_lossy().into_owned()));
    assert!(
        tool_result_text(&requests[2]).contains("PERMISSION_DENIED"),
        "the refusal was not reported"
    );
    assert!(
        tool_result_text(&requests[3]).contains("Шашки"),
        "the real listing was not returned"
    );
    assert!(completed(&workspace.journal()));
    assert!(
        !workspace.root.join(".ai-framework").exists(),
        "agent runs must not create the retired memory directory"
    );
}

/// Availability discovery must use the terminal's effective directory, even
/// when the user granted a path without selecting a persisted project. Finding
/// a driver is capability discovery, never passing browser evidence.
#[test]
fn explicit_workspace_discovers_browser_capability_without_fabricating_proof() {
    for mode in ["fast", "deep"] {
        let workspace = Workspace::new(&[("node_modules/puppeteer/package.json", "{}")]);
        let provider = Provider::start(|request, n| match n {
            0 => Reply::Tools(vec![deliverable("add", json!({"text":"page responds to interaction","check":"browser"}))]),
            1 => Reply::Tools(vec![
                ("create_file", json!({"path":"index.html","content":"<button>test</button>"})),
                deliverable("implemented", json!({"id":"d-001","evidence":"page created"})),
            ]),
            2 => Reply::Tools(vec![verify("d-001", None)]),
            _ => {
                let context = user_turn_context(request);
                assert!(!context.contains("none available"), "{context}");
                assert!(context.contains("not verified"));
                assert!(!latest_runtime_section(request, "deliverables").contains("[verified]"));
                Reply::Text("Implemented, not verified: no browser interaction ran.".into())
            }
        });
        let mut config = workspace.config(&provider.endpoint, "create and check the page");
        config.root = None;
        config.workspace_roots = vec![workspace.root.to_string_lossy().into_owned()];
        config.browser_capability = None;
        config.reasoning_mode = mode.into();
        run(config);
        assert_eq!(provider.requests().len(), if mode == "deep" { 6 } else { 5 });
        assert_eq!(withheld_drafts(&workspace.journal()), if mode == "deep" { 2 } else { 1 });
        assert!(completed(&workspace.journal()));
    }
}

/// Neither a project nor a named directory: no execution tools, and the model
/// is told so rather than being left to guess.
#[test]
fn without_any_scope_no_execution_tools_are_exposed_and_the_model_is_told() {
    let workspace = Workspace::new(&[("unused.txt", "")]);
    let provider = Provider::start(|_, _| Reply::Text("I need a directory.".into()));
    let mut config = workspace.config(&provider.endpoint, "create a folder");
    config.root = None;
    run(config);
    let requests = provider.requests();
    let names = tool_names(&requests[0]);
    for tool in EXECUTION_TOOLS {
        assert!(
            !names.contains(&(*tool).to_owned()),
            "{tool} leaked into an unscoped run"
        );
    }
    assert!(names.contains(&"task_memory".to_owned()));
    assert!(requests[0]
        .to_string()
        .contains("not available in this run"));
}

/// A selected project keeps its full toolset, and named directories only add
/// scope: absolute paths inside them work, others are refused.
#[test]
fn project_scope_keeps_all_tools_and_named_directories_extend_file_scope() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let extra = workspace.base.join("extra");
    std::fs::create_dir_all(&extra).unwrap();
    let extra = extra.canonicalize().unwrap();
    let written = extra.join("out.txt");
    let written_arg = written.to_string_lossy().into_owned();
    let provider = Provider::start(move |_, n| match n {
        0 => Reply::Tools(vec![(
            "write_file",
            json!({"path": written_arg, "content": "hello"}),
        )]),
        _ => Reply::Text("done".into()),
    });
    let mut config = workspace.config(&provider.endpoint, "write a file");
    config.workspace_roots = vec![extra.to_string_lossy().into_owned()];
    let allowed=extra.clone();
    config.host_tools=Some(Arc::new(local_ai_agent_runtime::tools::web::HostTools::with_dispatch(move|name,args| {
        if name!="request_permission" {return None;}
        Some(json!({"approved":args.pointer("/arguments/path").and_then(Value::as_str).is_some_and(|path|Path::new(path).starts_with(&allowed)),"reason":"once"}))
    })));
    run(config);
    assert_eq!(std::fs::read_to_string(written).unwrap(), "hello");
    let names = tool_names(&provider.requests()[0]);
    for tool in EXECUTION_TOOLS {
        assert!(names.contains(&(*tool).to_owned()), "{tool}");
    }
}

/// Reasoning mode is a model setting; it must never change which tools the
/// model is given.
#[test]
fn tool_exposure_does_not_depend_on_the_reasoning_mode() {
    let mut exposed = Vec::new();
    for mode in ["fast", "deep"] {
        let workspace = Workspace::new(&[("a.txt", "a")]);
        let provider = Provider::start(|_, _| Reply::Text("done".into()));
        let mut config = workspace.config(&provider.endpoint, "do the task");
        config.reasoning_mode = mode.into();
        run(config);
        let mut names = tool_names(&provider.requests()[0]);
        names.sort();
        exposed.push(names);
    }
    assert_eq!(exposed[0], exposed[1]);
    assert!(exposed[0].contains(&"run_terminal".to_owned()));
}

/// A failing command, an invalid path, a path outside the scope, a disallowed
/// command shape and an unavailable tool must each reach the model as an
/// honest error (never as a success), and the run must continue to an answer.
#[test]
fn failures_and_refusals_are_reported_honestly_and_the_run_still_completes() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let outside = workspace.base.join("outside.txt");
    std::fs::write(&outside, "keep").unwrap();
    let outside_arg = outside.to_string_lossy().into_owned();
    let provider = Provider::start(move |_, n| match n {
        0 => Reply::Tools(vec![("run_terminal", json!({"command":"exit 3"}))]),
        1 => Reply::Tools(vec![("read_file", json!({"path":"missing/none.txt"}))]),
        2 => Reply::Tools(vec![("delete_file", json!({"path": outside_arg}))]),
        3 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command":"echo a && echo b"}),
        )]),
        4 => Reply::Tools(vec![("format_disk", json!({}))]),
        _ => Reply::Text("reported".into()),
    });
    run(workspace.config(&provider.endpoint, "exercise failures"));
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert_eq!(requests.len(), 6);
    let failed_command = tool_result_text(&requests[1]);
    assert!(
        failed_command.contains("\"exit_code\":3") || failed_command.contains("exit_code"),
        "{failed_command}"
    );
    assert!(
        !failed_command.contains("\"status\":\"completed\""),
        "{failed_command}"
    );
    assert!(
        tool_result_text(&requests[2])
            .to_lowercase()
            .contains("no such file")
            || tool_result_text(&requests[2]).contains("error")
    );
    assert!(tool_result_text(&requests[3]).contains("PERMISSION_DENIED"));
    assert!(tool_result_text(&requests[4]).contains("PERMISSION_DENIED"));
    assert!(
        tool_result_text(&requests[5])
            .to_lowercase()
            .contains("format_disk"),
        "{}",
        tool_result_text(&requests[5])
    );
}

/// Cancelling while a terminal command runs ends the run promptly and does
/// not leave the command running.
#[test]
fn cancelling_during_a_running_terminal_command_stops_the_run_and_the_process() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("run_terminal", json!({"command":"sleep 47.31"}))]),
        _ => Reply::Text("unreachable".into()),
    });
    let config = workspace.config(&provider.endpoint, "run something slow");
    let cancelled = config.cancelled.clone();
    let started = std::time::Instant::now();
    let worker = std::thread::spawn(move || run(config));
    std::thread::sleep(std::time::Duration::from_millis(700));
    cancelled.store(true, Ordering::Relaxed);
    worker.join().unwrap();
    assert!(
        started.elapsed().as_secs() < 20,
        "cancellation was not prompt"
    );
    std::thread::sleep(std::time::Duration::from_millis(300));
    let leftover = std::process::Command::new("pgrep")
        .args(["-f", "sleep 47.31"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&leftover.stdout).trim().is_empty(),
        "the cancelled command is still running"
    );
}

/// Tool calls and results of an execution run are journaled as a matched pair,
/// so a restart or Continue replays the same state.
#[test]
fn execution_tool_calls_and_results_are_persisted_as_matched_pairs() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![(
            "create_file",
            json!({"path":"new/dir/b.txt","content":"b"}),
        )]),
        _ => Reply::Text("created".into()),
    });
    run(workspace.config(&provider.endpoint, "create a file"));
    assert_eq!(
        std::fs::read_to_string(workspace.root.join("new/dir/b.txt")).unwrap(),
        "b"
    );
    let journal = workspace.journal();
    assert!(completed(&journal));
    let calls: Vec<String> = journal
        .iter()
        .filter_map(|entry| entry.pointer("/Message/tool_calls"))
        .flat_map(|calls| calls.as_array().cloned().unwrap_or_default())
        .filter_map(|call| call["id"].as_str().map(str::to_owned))
        .collect();
    let results: Vec<String> = journal
        .iter()
        .filter(|entry| entry.pointer("/Message/role").and_then(Value::as_str) == Some("tool"))
        .filter_map(|entry| {
            entry
                .pointer("/Message/tool_call_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    assert_eq!(calls.len(), 1, "{journal:?}");
    assert_eq!(calls, results, "a tool call has no persisted result");
}

fn tree(root: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push((
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    std::fs::read(&path).unwrap(),
                ));
            }
        }
    }
    files.sort();
    files
}

/// Reading a reference project (Project 2) must leave it byte-identical.
#[test]
fn reading_the_secondary_project_never_modifies_it_while_writes_land_in_the_primary() {
    let fixture = Workspace::new(&[("a.txt", "primary")]);
    let secondary = fixture.base.join("reference");
    std::fs::create_dir_all(secondary.join("src")).unwrap();
    std::fs::write(secondary.join("src/theme.css"), ":root{--c:#0a0}").unwrap();
    std::fs::write(secondary.join("index.html"), "<html></html>").unwrap();
    let before = tree(&secondary);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            ("list_directory", json!({"path":".","project":2})),
            ("read_file", json!({"path":"src/theme.css","project":2})),
        ]),
        1 => Reply::Tools(vec![(
            "create_file",
            json!({"path":"theme.css","content":":root{--c:#0a0}","project":1}),
        )]),
        _ => Reply::Text("done".into()),
    });
    let mut config = fixture.config(&provider.endpoint, "adapt the reference theme");
    config.secondary_root = Some(secondary.to_string_lossy().into_owned());
    run(config);
    assert_eq!(
        tree(&secondary),
        before,
        "the reference project was modified"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("theme.css")).unwrap(),
        ":root{--c:#0a0}"
    );
    assert!(completed(&fixture.journal()));
}

const TWO_PART_REQUEST: &str =
    "Do two things: add a bot mode to the game, and add a theme switch to the game.";

fn deliverable(action: &str, fields: Value) -> (&'static str, Value) {
    let mut arguments = fields;
    arguments["action"] = json!(action);
    ("deliverables", arguments)
}

fn add_both() -> Reply {
    Reply::Tools(vec![
        deliverable(
            "add",
            json!({"task":"bot","text":"bot opponent is selectable in the UI"}),
        ),
        deliverable(
            "add",
            json!({"task":"theme","text":"theme switch changes the theme"}),
        ),
    ])
}

/// The failure this guards against: the run recorded two requested deliverables,
/// finished one, and tried to end. It must be sent back once (Fast) naming
/// exactly what is unfinished, and the second answer is accepted so the review
/// can never deadlock a run.
#[test]
fn fast_sends_a_run_with_unfinished_deliverables_back_once_then_accepts() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => add_both(),
        1 => Reply::Tools(vec![deliverable(
            "done",
            json!({"id":"d-001","evidence":"saw it work"}),
        )]),
        2 => Reply::Text("Everything is finished.".into()),
        _ => Reply::Text("The theme switch is not done: out of time.".into()),
    });
    run(workspace.config(&provider.endpoint, TWO_PART_REQUEST));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(
        withheld_drafts(&journal),
        1,
        "the premature answer must be withheld exactly once"
    );
    let requests = provider.requests();
    assert_eq!(requests.len(), 4);
    let reminder = user_turn_context(&requests[3]);
    assert!(reminder.contains("not all complete"), "{reminder}");
    assert!(
        reminder.contains("d-002 theme switch changes the theme (theme)"),
        "{reminder}"
    );
    let review = reminder
        .split("Before finishing:")
        .nth(1)
        .and_then(|rest| rest.split("Continue with").next())
        .unwrap_or_default();
    assert!(
        !review.contains("d-001"),
        "finished work must not be listed as pending: {review}"
    );
    assert!(requests[3].to_string().contains("<deliverables>"));
}

/// Marking an item blocked with a concrete reason is an honest way to end: no review is needed.
#[test]
fn blocked_with_a_reason_ends_without_a_review() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => add_both(),
        1 => Reply::Tools(vec![
            deliverable("done", json!({"id":"d-001","evidence":"verified"})),
            deliverable(
                "block",
                json!({"id":"d-002","reason":"the theme assets cannot be reached from this environment"}),
            ),
        ]),
        _ => Reply::Text("Bot done; theme blocked, see the reason.".into()),
    });
    run(workspace.config(&provider.endpoint, TWO_PART_REQUEST));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 0);
    assert_eq!(provider.requests().len(), 3);
}

/// Deep checks completion harder: it may be sent back twice, and `done` needs evidence that cites something observed.
#[test]
fn deep_requires_cited_evidence_for_done_and_reviews_twice() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => add_both(),
        1 => Reply::Tools(vec![deliverable(
            "done",
            json!({"id":"d-001","evidence":"I believe it works"}),
        )]),
        2 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
        3 => Reply::Tools(vec![deliverable(
            "done",
            json!({"id":"d-001","evidence":"obs-00000001 shows it"}),
        )]),
        4 | 5 => Reply::Text("Finished everything.".into()),
        _ => Reply::Text("Theme switch remains unfinished.".into()),
    });
    let mut config = workspace.config(&provider.endpoint, TWO_PART_REQUEST);
    config.reasoning_mode = "deep".into();
    run(config);
    let requests = provider.requests();
    assert!(
        tool_result_text(&requests[2]).contains("In Deep mode"),
        "uncited evidence was accepted: {}",
        tool_result_text(&requests[2])
    );
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(
        withheld_drafts(&journal),
        2,
        "Deep reviews an unfinished list twice"
    );
    assert_eq!(requests.len(), 7);
    assert!(user_turn_context(&requests[6]).contains("cite the observation"));
}

/// Trivial and analysis-only prompts must stay lean: the runtime never creates a list on its own, so nothing is reviewed.
#[test]
fn a_run_that_never_records_deliverables_is_never_reviewed() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
        _ => Reply::Text("It says a.".into()),
    });
    run(workspace.config(&provider.endpoint, "what does a.txt say?"));
    assert_eq!(withheld_drafts(&workspace.journal()), 0);
    assert_eq!(provider.requests().len(), 2);
    assert!(!provider.requests()[1]
        .to_string()
        .contains("<deliverables>"));
}

/// The list is persisted with Task Memory: a later run (Continue after an interruption) sees it, and a fresh run
/// (Regenerate starts without saved memory) does not.
#[test]
fn saved_deliverables_return_on_continue_and_a_fresh_run_starts_empty() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, _| Reply::Text("ok".into()));
    let mut resumed = workspace.config(&provider.endpoint, "continue");
    resumed.task_memory = Some(json!({"entries":[],"revision":0,"deliverables":{"items":[
        {"id":"d-001","task":"bot","text":"bot opponent is selectable in the UI","status":"pending","evidence":"","reason":""}
    ],"revision":1}}));
    run(resumed);
    assert!(provider.requests()[0]
        .to_string()
        .contains("bot opponent is selectable in the UI"));

    let fresh_workspace = Workspace::new(&[("a.txt", "a")]);
    let fresh_provider = Provider::start(|_, _| Reply::Text("ok".into()));
    run(fresh_workspace.config(&fresh_provider.endpoint, "start over"));
    assert!(!fresh_provider.requests()[0]
        .to_string()
        .contains("<deliverables>"));
}

/// Read-only requests retain contract metadata, while project mutations remain unavailable.
#[test]
fn read_only_requests_keep_deliverable_metadata_without_project_mutations() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, _| Reply::Text("ok".into()));
    run(workspace.config(&provider.endpoint, "do the work"));
    assert!(tool_names(&provider.requests()[0]).contains(&"deliverables".to_owned()));
    let read_only_provider = Provider::start(|_, _| Reply::Text("ok".into()));
    let read_only_workspace = Workspace::new(&[("a.txt", "a")]);
    run(read_only_workspace.config(&read_only_provider.endpoint, READ_ONLY));
    let offered = tool_names(&read_only_provider.requests()[0]);
    assert!(offered.contains(&"deliverables".to_owned()));
    for mutation in ["write_file", "create_file", "replace_text", "apply_patch", "delete_file"] {
        assert!(!offered.contains(&mutation.to_owned()), "read-only request exposed {mutation}");
    }
}

/// Files the run created stay visible, and a pending review points at them so scratch files are not forgotten.
#[test]
fn files_created_in_the_run_are_listed_and_named_in_the_review() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"the feature works end to end"})),
            (
                "create_file",
                json!({"path":"scratch-check.js","content":"1"}),
            ),
            ("write_file", json!({"path":"a.txt","content":"changed"})),
        ]),
        1 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command":"echo run test ok"}),
        )]),
        2 => Reply::Text("done".into()),
        3 => Reply::Tools(vec![("delete_file", json!({"path":"scratch-check.js"}))]),
        _ => Reply::Text("done again".into()),
    });
    run(workspace.config(&provider.endpoint, "build the feature"));
    let requests = provider.requests();
    assert!(requests[1]
        .to_string()
        .contains("<files_created_this_run>scratch-check.js</files_created_this_run>"));
    assert!(
        !requests[1]
            .to_string()
            .contains("a.txt</files_created_this_run>"),
        "an existing file is not a created file"
    );
    let review = user_turn_context(&requests[3]);
    assert!(
        review.contains("Files you created in this run: scratch-check.js"),
        "{review}"
    );
    assert!(
        latest_runtime_section(&requests[4], "files_created_this_run").is_empty(),
        "a deleted file must leave the list"
    );
}

/// A file the model just read must be writable: the write is not a repeated read.
#[test]
fn write_file_after_reading_the_same_path_really_writes() {
    let workspace = Workspace::new(&[("a.txt", "old")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
        1 => Reply::Tools(vec![(
            "write_file",
            json!({"path":"a.txt","content":"new"}),
        )]),
        2 => Reply::Tools(vec![(
            "write_file",
            json!({"path":"a.txt","content":"newer"}),
        )]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "rewrite a.txt"));
    assert_eq!(
        std::fs::read_to_string(workspace.root.join("a.txt")).unwrap(),
        "newer"
    );
    let requests = provider.requests();
    assert!(
        !tool_result_text(&requests[2]).contains("already stored"),
        "{}",
        tool_result_text(&requests[2])
    );
}

/// A write over a file that changed after the model's last read is refused with
/// one concise instruction; reading again makes it writable.
#[test]
fn write_file_over_a_file_changed_since_the_read_is_refused_until_read_again() {
    let workspace = Workspace::new(&[("a.txt", "old")]);
    let file = workspace.root.join("a.txt");
    let provider = Provider::start(move |_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
        1 => {
            // Another process (the user, a build) edits the file between the read and the write.
            std::fs::write(&file, "changed-elsewhere").unwrap();
            Reply::Tools(vec![("list_directory", json!({"path":"."}))])
        }
        2 => Reply::Tools(vec![(
            "write_file",
            json!({"path":"a.txt","content":"mine"}),
        )]),
        3 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
        4 => Reply::Tools(vec![(
            "write_file",
            json!({"path":"a.txt","content":"mine"}),
        )]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "rewrite a.txt"));
    let requests = provider.requests();
    let refusal = tool_result_text(&requests[3]);
    assert!(
        refusal
            .contains("File changed since your last read. Read the latest version before writing."),
        "{refusal}"
    );
    assert!(refusal.contains("STALE_FILE_REVISION"), "the concise instruction retains specific error metadata: {refusal}");
    assert!(refusal.contains("\"retrySameArguments\":false"), "stale edits require new arguments: {refusal}");
    assert_eq!(
        std::fs::read_to_string(workspace.root.join("a.txt")).unwrap(),
        "mine"
    );
}

/// A write to a file the model never read is not blocked just for ceremony.
#[test]
fn write_file_to_an_unread_file_is_allowed() {
    let workspace = Workspace::new(&[("a.txt", "old")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![(
            "write_file",
            json!({"path":"a.txt","content":"new"}),
        )]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "rewrite a.txt"));
    assert_eq!(
        std::fs::read_to_string(workspace.root.join("a.txt")).unwrap(),
        "new"
    );
}

fn plan(arguments: Value) -> (&'static str, Value) {
    ("plan", arguments)
}

#[test]
fn fresh_small_patch_succeeds_and_stale_or_malformed_patch_does_not_write() {
    let workspace = Workspace::new(&[("a.txt", "    value = 1;\n")]);
    let file = workspace.root.join("a.txt");
    let external = file.clone();
    let provider = Provider::start(move |request, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
        1 => {
            assert!(last_tool_result(request).contains("value = 1"));
            Reply::Tools(vec![("apply_patch", json!({"patch":"*** Begin Patch\n*** Update File: a.txt\n@@\n-    value = 1;\n+    value = 2;\n*** End Patch"}))])
        }
        2 => {
            assert_eq!(std::fs::read_to_string(&external).unwrap(), "    value = 2;\n");
            std::fs::write(&external, "    value = 3;\n").unwrap();
            Reply::Tools(vec![("apply_patch", json!({"patch":"*** Begin Patch\n*** Update File: a.txt\n@@\n-    value = 2;\n+    value = 4;\n*** End Patch"}))])
        }
        3 => {
            assert!(last_tool_result(request).contains("does not match current content"));
            assert!(last_tool_result(request).contains("hunk 1"));
            Reply::Tools(vec![("apply_patch", json!({"patch":"not a patch"}))])
        }
        _ => {
            assert!(last_tool_result(request).contains("must start with *** Begin Patch"));
            Reply::Text("Applied the fresh edit; later conflicting edits were refused.".into())
        }
    });
    run(workspace.config(&provider.endpoint, "edit this text file"));
    assert_eq!(std::fs::read_to_string(file).unwrap(), "    value = 3;\n");
    assert_eq!(provider.requests().len(), 5);
    assert!(completed(&workspace.journal()));
}

#[test]
fn literal_replacement_requires_runtime_read_revision_and_demotes_verification() {
    let workspace = Workspace::new(APP);
    let file = workspace.root.join("app.js");
    std::fs::write(&file, BAD).unwrap();
    let external = file.clone();
    let provider = Provider::start(move |request, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"add returns the correct result"})),
            ("replace_text", json!({"path":"app.js","old_text":"a - b","new_text":"a + b","_expected_revision":"forged"})),
        ]),
        1 => {
            assert!(last_tool_result(request).contains("Read the file before"));
            Reply::Tools(vec![("read_file", json!({"path":"app.js"}))])
        }
        2 => Reply::Tools(vec![
            ("replace_text", json!({"path":"app.js","old_text":"a - b","new_text":"a + b"})),
            deliverable("implemented", json!({"id":"d-001","evidence":"edited app.js"})),
        ]),
        3 => {
            assert!(std::fs::read_to_string(&external).unwrap().contains("a + b"));
            Reply::Tools(vec![run_check()])
        }
        4 => Reply::Tools(vec![verify("d-001", None)]),
        5 => {
            assert!(latest_runtime_section(request, "deliverables").contains("[verified] d-001"));
            Reply::Tools(vec![("replace_text", json!({"path":"app.js","old_text":"a + b","new_text":"b + a"}))])
        }
        6 => {
            assert!(!latest_runtime_section(request, "deliverables").contains("[verified] d-001"));
            assert!(latest_runtime_section(request, "verification_state").contains("stale"));
            std::fs::write(&external, "module.exports = (a, b) => a * b;\n").unwrap();
            Reply::Tools(vec![("replace_text", json!({"path":"app.js","old_text":"a * b","new_text":"a + b","_expected_revision":"forged"}))])
        }
        _ => {
            assert!(last_tool_result(request).contains("changed since your last read"));
            Reply::Text("Implemented, not verified after the later changes.".into())
        }
    });
    run(workspace.config(&provider.endpoint, "fix the addition function"));
    assert_eq!(std::fs::read_to_string(file).unwrap(), "module.exports = (a, b) => a * b;\n");
    assert!(completed(&workspace.journal()));
}

#[test]
fn runtime_plan_updates_and_visible_progress_do_not_create_human_turns_or_extra_requests() {
    let workspace = Workspace::new(&[("a.txt", "a"), ("b.txt", "b")]);
    let provider = Provider::start(|request, n| {
        let messages = request["messages"].as_array().unwrap();
        assert_eq!(messages.iter().filter(|m| m["role"] == "user").count(), 1);
        assert!(!request.to_string().contains("CONTINUED USER TURN"));
        match n {
            0 => Reply::ProgressTools("Inspecting the sources.".into(), vec![plan(
                json!({"action":"set","steps":["inspect","report"]}),
            )]),
            1 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
            2 => Reply::Tools(vec![plan(json!({"action":"update","id":"s1","status":"completed"}))]),
            3 => Reply::Tools(vec![("read_file", json!({"path":"b.txt"}))]),
            _ => Reply::Text("Both sources inspected.".into()),
        }
    });
    run(workspace.config(&provider.endpoint, "inspect these two files"));
    let requests = provider.requests();
    assert_eq!(requests.len(), 5, "progress is part of a tool response, not a new generation");
    for pair in requests.windows(2) {
        let old = pair[0]["messages"].as_array().unwrap();
        let new = pair[1]["messages"].as_array().unwrap();
        assert_eq!(&new[..old.len()], old.as_slice(), "accepted prompt prefix must be immutable");
    }
    assert!(requests[1]["messages"].as_array().unwrap().iter().any(|m| {
        m["role"] == "assistant" && m["content"] == "Inspecting the sources."
    }));
    assert!(completed(&workspace.journal()));
    assert_eq!(workspace.journal().iter().filter(|e| e.get("RunUser").is_some()).count(), 1);
}

/// The plan is its own state: it is shown back every turn, never mistaken for the deliverables, and its result is compact.
#[test]
fn the_plan_is_set_shown_back_and_kept_apart_from_deliverables() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![plan(
            json!({"action":"set","steps":["inspect a.txt","change it","check it"]}),
        )]),
        1 => Reply::Tools(vec![plan(
            json!({"action":"update","id":"s1","status":"completed"}),
        )]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "change a.txt"));
    let requests = provider.requests();
    assert!(tool_names(&requests[0]).contains(&"plan".to_owned()));
    assert!(!requests[0].to_string().contains("<plan>"));
    let second = user_turn_context(&requests[1]);
    assert!(second.contains("<plan>"), "{second}");
    assert!(second.contains("[>] s1 inspect a.txt"), "{second}");
    let third = user_turn_context(&requests[2]);
    assert!(third.contains("[x] s1 inspect a.txt"), "{third}");
    assert!(third.contains("[>] s2 change it"), "{third}");
    assert!(
        !third.contains("<deliverables>"),
        "a plan is not a deliverable list: {third}"
    );
    assert!(completed(&workspace.journal()));
}

/// A malformed plan call is a recoverable tool error, not a failed run.
#[test]
fn a_bad_plan_call_is_a_tool_error_and_the_run_continues() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![plan(json!({"action":"set"}))]),
        1 => Reply::Tools(vec![plan(
            json!({"action":"update","id":"s9","status":"completed"}),
        )]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "change a.txt"));
    assert!(completed(&workspace.journal()));
    let result = tool_result_text(&provider.requests()[2]);
    assert!(result.contains("s9"), "{result}");
}

/// Saved plans come back on Continue, in a pause tail too; a fresh run starts empty.
#[test]
fn a_saved_plan_returns_on_continue_and_a_fresh_run_starts_empty() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, _| Reply::Text("ok".into()));
    let mut resumed = workspace.config(&provider.endpoint, "continue");
    resumed.task_memory = Some(json!({"entries":[],"revision":0,"plan":{"steps":[
        {"id":"s1","text":"wire the bot","status":"completed"},
        {"id":"s2","text":"add the theme switch","status":"in_progress"}
    ],"revision":2}}));
    run(resumed);
    let first = provider.requests()[0].to_string();
    assert!(first.contains("add the theme switch"), "{first}");

    let fresh_workspace = Workspace::new(&[("a.txt", "a")]);
    let fresh_provider = Provider::start(|_, _| Reply::Text("ok".into()));
    run(fresh_workspace.config(&fresh_provider.endpoint, "start over"));
    assert!(!fresh_provider.requests()[0].to_string().contains("<plan>"));
}

const APP: &[(&str, &str)] = &[
    ("app.js", "module.exports = (a, b) => a + b;\n"),
    (
        "check.js",
        "const add = require('./app.js');\nif (add(1, 2) !== 3) { console.error('add is wrong'); process.exit(1); }\nconsole.log('ok');\n",
    ),
];

fn edit_app(content: &str) -> (&'static str, Value) {
    ("write_file", json!({"path":"app.js","content":content}))
}

fn run_check() -> (&'static str, Value) {
    (
        "run_terminal",
        json!({"command":"node check.js","deliverable_ids":["d-001"]}),
    )
}

fn verify(id: &str, proof: Option<&str>) -> (&'static str, Value) {
    let mut fields = json!({"id": id});
    if let Some(proof) = proof {
        fields["evidence"] = json!(proof);
    }
    deliverable("verify", fields)
}

const GOOD: &str = "module.exports = (a, b) => a + b;\n// edited\n";
const BAD: &str = "module.exports = (a, b) => a - b;\n";

/// Editing code and ending without any check is the core failure: the claim is
/// sent back once, naming what is unverified; the second answer is accepted so
/// the gate can never deadlock a run.
#[test]
fn an_edit_with_no_check_is_sent_back_once_and_then_accepted() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"add keeps adding"})),
            edit_app(GOOD),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"edited app.js"}),
            ),
        ]),
        1 => Reply::Text("It works.".into()),
        _ => Reply::Text("Implemented, but I did not run it.".into()),
    });
    run(workspace.config(&provider.endpoint, "make add work"));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 1);
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    let reminder = user_turn_context(&requests[2]);
    assert!(
        reminder.contains("not seen your work verified"),
        "{reminder}"
    );
    assert!(reminder.contains("d-001"), "{reminder}");
    let text = requests[1].to_string();
    assert!(text.contains("[implemented] d-001"), "{text}");
    assert!(text.contains("<verification_state>"), "{text}");
}

/// A passing check after the last edit, cited by the model, verifies the item
/// and ends the run with no review.
#[test]
fn a_passing_check_after_the_edit_verifies_and_ends_without_a_review() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"add keeps adding"})),
            edit_app(GOOD),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"edited app.js"}),
            ),
        ]),
        1 => Reply::Tools(vec![run_check()]),
        2 => Reply::Tools(vec![verify("d-001", None)]),
        _ => Reply::Text("Verified by node check.js.".into()),
    });
    run(workspace.config(&provider.endpoint, "make add work"));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 0);
    let requests = provider.requests();
    assert_eq!(requests.len(), 4);
    assert!(requests[2].to_string().contains("[run pass]"));
    let last = requests[3].to_string();
    assert!(last.contains("[verified] d-001"), "{last}");
    assert!(last.contains("proof: ev-"), "{last}");
}

/// The production loop must settle the acceptance claim without fixing a
/// separate project warning, in both strategies. The inverse remains blocked.
#[test]
fn scoped_runtime_acceptance_and_baseline_project_warning_in_fast_and_deep() {
    for deep in [false, true] {
        for passing in [false, true] {
            let mut files = APP.to_vec();
            files.push((
                "suite.js",
                "console.error('independent quality assertion'); process.exit(1);\n",
            ));
            files.push(("package.json", r#"{"scripts":{"test":"node suite.js"}}"#));
            let workspace = Workspace::new(&files);
            let provider = Provider::start(move |_, n| match n {
                0 => Reply::Tools(vec![
                    deliverable(
                        "add",
                        json!({"text":"runtime responds correctly","check":"runtime"}),
                    ),
                    term("npm test"),
                ]),
                1 => Reply::Tools(vec![
                    edit_app(if passing { GOOD } else { BAD }),
                    deliverable(
                        "implemented",
                        json!({"id":"d-001","evidence":"edited app.js"}),
                    ),
                ]),
                2 => Reply::Tools(vec![run_check(), term("npm test")]),
                3 => Reply::Tools(vec![verify(
                    "d-001",
                    if deep { Some("ev-003") } else { None },
                )]),
                _ => Reply::Text(
                    if passing {
                        "Runtime verified; project suite still fails as it did before the change."
                    } else {
                        "Implemented, not verified: the runtime assertion failed."
                    }
                    .into(),
                ),
            });
            let mut config = workspace.config(&provider.endpoint, "fix runtime response");
            if deep {
                config.reasoning_mode = "deep".into();
            }
            run(config);
            let requests = provider.requests();
            let tail = requests.last().unwrap().to_string();
            assert!(
                tail.contains("independent quality assertion"),
                "warning lost: {tail}"
            );
            assert!(
                tail.contains("pre-existing observed failure"),
                "baseline relation lost: {tail}"
            );
            assert!(tail.contains("scope: d-001"), "selection lost: {tail}");
            assert_eq!(tail.contains("[verified] d-001"), passing, "{tail}");
            assert!(completed(&workspace.journal()));
            if passing {
                assert_eq!(
                    withheld_drafts(&workspace.journal()),
                    0,
                    "project warnings must not trigger scope creep"
                );
                assert_eq!(requests.len(), 5);
            } else {
                assert!(last_tool_result(&requests[4]).contains("relevant failed check"));
                assert!(withheld_drafts(&workspace.journal()) > 0);
            }
        }
    }
}

/// Optional real-browser regression of the production agent loop. Uses only
/// isolated temporary projects, a deterministic provider and installed Chrome.
#[test]
#[ignore = "requires installed Chrome and the desktop project's playwright-core"]
fn live_scoped_browser_acceptance_with_project_warning_and_inverse() {
    let driver = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("node_modules/playwright-core");
    assert!(driver.is_dir(), "install the desktop dependencies first");
    let browser =
        std::env::var("LOCAL_AI_TEST_BROWSER").unwrap_or_else(|_| "/usr/bin/google-chrome".into());
    assert!(
        std::path::Path::new(&browser).is_file(),
        "Chrome is required for the live regression"
    );
    let browser_script = format!(
        r#"
const {{ chromium }} = require({driver});
const assert = require('node:assert/strict');
(async () => {{
  const browser = await chromium.launch({{ executablePath: {browser}, headless: true }});
  try {{
    const page = await browser.newPage();
    await page.goto('file://' + process.cwd() + '/index.html');
    for (let turn = 1; turn <= 3; turn++) {{
      await page.locator('#human').click();
      await page.waitForFunction((turn) => window.responses === turn, turn, {{ timeout: 1000 }});
      assert.equal(await page.evaluate(() => window.humans), turn);
    }}
    console.log('PASS: human action, automatic response, three turns continued without freeze');
  }} finally {{ await browser.close(); }}
}})().catch((error) => {{ console.error(error.message); process.exitCode = 1; }});
"#,
        driver = json!(driver.to_string_lossy()),
        browser = json!(browser)
    );
    for deep in [false, true] {
        for passing in [false, true] {
            let workspace = Workspace::new(&[
                (
                    "index.html",
                    "<button id='human'>Human action</button><script src='app.js'></script>",
                ),
                ("app.js", "window.humans=0; window.responses=0;"),
                ("browser-check.cjs", &browser_script),
                (
                    "suite.js",
                    "console.error('separate quality expectation failed'); process.exit(1);",
                ),
                ("package.json", r#"{"scripts":{"test":"node suite.js"}}"#),
            ]);
            let provider = Provider::start(move |_, n| {
                match n {
                0 => Reply::Tools(vec![deliverable("add", json!({"text":"automatic response follows the human action without freezing","check":"browser"})), term("npm test")]),
                1 => Reply::Tools(vec![
                    edit_app(if passing { "window.humans=0; window.responses=0; document.querySelector('#human').onclick=()=>{window.humans++; setTimeout(()=>window.responses++,10);};" } else { "window.humans=0; window.responses=0; document.querySelector('#human').onclick=()=>{window.humans++;};" }),
                    deliverable("implemented", json!({"id":"d-001","evidence":"edited app.js"})),
                ]),
                2 => Reply::Tools(vec![("run_terminal", json!({"command":"node browser-check.cjs","deliverable_ids":["d-001"]})), term("npm test")]),
                3 => Reply::Tools(vec![verify("d-001", if deep { Some("ev-003") } else { None })]),
                _ => Reply::Text(if passing { "Browser acceptance verified; independent baseline suite failure remains visible." } else { "Implemented, not verified: automatic runtime response failed." }.into()),
            }
            });
            let mut config = workspace.config(&provider.endpoint, "fix automatic runtime response");
            config.browser_capability = Some(true);
            if deep {
                config.reasoning_mode = "deep".into();
            }
            run(config);
            let requests = provider.requests();
            let tail = requests.last().unwrap().to_string();
            assert!(
                tail.contains("separate quality expectation failed")
                    && tail.contains("pre-existing observed failure")
            );
            assert_eq!(tail.contains("[verified] d-001"), passing, "{tail}");
            assert!(
                tail.contains(if passing {
                    "[browser pass]"
                } else {
                    "[browser FAIL]"
                }),
                "real browser evidence was not recorded: {tail}"
            );
            if passing {
                assert_eq!(withheld_drafts(&workspace.journal()), 0);
            } else {
                assert!(withheld_drafts(&workspace.journal()) > 0);
            }
            assert!(completed(&workspace.journal()));
            println!("LIVE: mode={} runtime={} independent suite=FAIL baseline retained, verified={passing}", if deep { "deep" } else { "fast" }, if passing { "PASS" } else { "FAIL" });
        }
    }
}

#[test]
fn a_failed_verification_citation_cannot_be_removed_from_the_item() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"runtime responds","check":"runtime"})),
            edit_app(BAD),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"edited app.js"}),
            ),
        ]),
        1 => Reply::Tools(vec![term("node check.js")]),
        2 => Reply::Tools(vec![verify("d-001", Some("ev-002"))]),
        // An empty selection, a forged scope argument, and re-implementing
        // the item cannot erase the failed explicit citation.
        3 => Reply::Tools(vec![
            (
                "run_terminal",
                json!({"command":"node check.js","deliverable_ids":[]}),
            ),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"built","verification_scope":"acceptance","ignore":["ev-002"]}),
            ),
            verify("d-001", None),
        ]),
        _ => Reply::Text("Not verified.".into()),
    });
    run(workspace.config(&provider.endpoint, "fix runtime"));
    let requests = provider.requests();
    assert!(last_tool_result(&requests[3]).contains("relevant failed check"));
    assert!(last_tool_result(&requests[4]).contains("relevant failed check"));
    let tail = requests.last().unwrap().to_string();
    assert!(tail.contains("[implemented] d-001") && tail.contains("scope: d-001"));
    assert!(!tail.contains("[verified] d-001"));
}

/// Verify is refused without evidence: the model's own claim changes nothing.
#[test]
fn verify_is_refused_without_a_passing_check_and_a_claim_changes_nothing() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"add keeps adding"})),
            edit_app(GOOD),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"edited app.js"}),
            ),
        ]),
        1 => Reply::Tools(vec![verify(
            "d-001",
            Some("I read it and it clearly works"),
        )]),
        _ => Reply::Text("Not verified.".into()),
    });
    run(workspace.config(&provider.endpoint, "make add work"));
    let requests = provider.requests();
    let refusal = last_tool_result(&requests[2]);
    assert!(refusal.contains("No fresh passing"), "{refusal}");
    let tail = requests[2].to_string();
    assert!(tail.contains("[implemented] d-001"), "{tail}");
    assert!(!tail.contains("[verified]"), "{tail}");
}

/// A failing check is recorded by the runtime, shown back, annotated on the
/// deliverable and cannot verify anything; fixing the code and re-running does.
#[test]
fn a_failing_check_blocks_verification_until_fixed_and_rechecked() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"add keeps adding"})),
            edit_app(BAD),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"edited app.js"}),
            ),
        ]),
        1 => Reply::Tools(vec![run_check()]),
        2 => Reply::Tools(vec![verify("d-001", None)]),
        3 => Reply::Tools(vec![edit_app(GOOD)]),
        4 => Reply::Tools(vec![run_check()]),
        5 => Reply::Tools(vec![verify("d-001", None)]),
        _ => Reply::Text("Fixed and verified.".into()),
    });
    run(workspace.config(&provider.endpoint, "make add work"));
    let requests = provider.requests();
    let after_failure = requests[2].to_string();
    assert!(after_failure.contains("FAIL"), "{after_failure}");
    assert!(after_failure.contains("a check failed"), "{after_failure}");
    let refused = last_tool_result(&requests[3]);
    assert!(refused.contains("failed"), "{refused}");
    assert!(
        requests[4].to_string().contains("[implemented] d-001"),
        "a fix makes the old failure stale but nothing is verified yet"
    );
    assert!(requests[6].to_string().contains("[verified] d-001"));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 0);
}

/// Any later edit invalidates what was verified, and the status says so.
#[test]
fn a_later_edit_demotes_a_verified_deliverable() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"add keeps adding"})),
            edit_app(GOOD),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"edited app.js"}),
            ),
        ]),
        1 => Reply::Tools(vec![run_check()]),
        2 => Reply::Tools(vec![verify("d-001", None)]),
        3 => Reply::Tools(vec![edit_app("module.exports = (a, b) => b + a;\n")]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "make add work"));
    let requests = provider.requests();
    assert!(requests[3].to_string().contains("[verified] d-001"));
    let after_edit = latest_runtime_section(&requests[4], "deliverables");
    assert!(after_edit.contains("[implemented] d-001"), "{after_edit}");
    assert!(!after_edit.contains("[verified] d-001"), "{after_edit}");
}

/// A change that is not code (a document) needs no behavioural check: the
/// runtime reads back every write itself, so there is no gate and no review.
#[test]
fn a_documentation_only_change_is_never_gated() {
    let workspace = Workspace::new(&[("notes.md", "old")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"notes are updated"})),
            ("write_file", json!({"path":"notes.md","content":"new"})),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"wrote notes.md"}),
            ),
            deliverable("verify", json!({"id":"d-001"})),
        ]),
        _ => Reply::Text("Updated the notes.".into()),
    });
    run(workspace.config(&provider.endpoint, "update the notes"));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 0);
    assert_eq!(provider.requests().len(), 2);
}

/// Deep may send an unverified change back twice and then accepts; both modes end.
#[test]
fn deep_sends_unverified_changes_back_twice_and_still_ends() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"add keeps adding"})),
            edit_app(GOOD),
            (
                "deliverables",
                json!({"action":"implemented","id":"d-001","evidence":"wrote app.js"}),
            ),
        ]),
        _ => Reply::Text("It works.".into()),
    });
    let mut config = workspace.config(&provider.endpoint, "make add work");
    config.reasoning_mode = "deep".into();
    run(config);
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 2);
}

/// A bad claim never loops forever: with checks running and failing every time,
/// the budget closes the gate and the run ends with the state still honest.
#[test]
fn an_endless_fail_and_retry_cycle_is_bounded_by_the_budget() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| {
        if n == 0 {
            Reply::Tools(vec![
                deliverable("add", json!({"text":"add keeps adding"})),
                edit_app(BAD),
                deliverable(
                    "implemented",
                    json!({"id":"d-001","evidence":"wrote app.js"}),
                ),
            ])
        } else if n % 2 == 1 {
            Reply::Text("It works now.".into())
        } else {
            Reply::Tools(vec![run_check()])
        }
    });
    run(workspace.config(&provider.endpoint, "make add work"));
    let requests = provider.requests();
    assert!(completed(&workspace.journal()));
    assert!(
        requests.len() < 20,
        "the cycle was not bounded: {} requests",
        requests.len()
    );
    let tail = requests.last().unwrap().to_string();
    assert!(tail.contains("[implemented] d-001"), "{tail}");
    assert!(!tail.contains("[verified]"), "{tail}");
}

#[test]
fn identical_deterministic_terminal_failure_is_not_executed_or_approved_twice() {
    for deterministic in [true, false] {
        let diagnostic = if deterministic { "HTTP Error 404: Not Found" } else { "temporary server unavailable" };
        let script = format!("require('fs').appendFileSync('attempts.txt', 'attempt\\n'); console.error({}); process.exit(1);", serde_json::to_string(diagnostic).unwrap());
        let workspace = Workspace::new(&[("remote.js", &script)]);
        let provider = Provider::start(move |request, turn| {
            if turn < 2 { return Reply::Tools(vec![("run_terminal", json!({"command":"node remote.js"}))]); }
            if turn == 2 {
                let result = last_tool_result(request);
                assert!(result.contains(if deterministic { "DUPLICATE_FAILED_OPERATION" } else { "COMMAND_FAILED" }), "{result}");
            }
            Reply::Text("The resource request failed; no replacement was installed.".into())
        });
        let approvals = Arc::new(AtomicUsize::new(0));
        let count = approvals.clone();
        let mut config = workspace.config(&provider.endpoint, "Use the project command to check remote resource availability");
        config.host_tools = Some(Arc::new(local_ai_agent_runtime::tools::web::HostTools::with_dispatch(move |name, _args| {
            if name != "request_permission" { return None; }
            count.fetch_add(1, Ordering::Relaxed);
            Some(json!({"approved":true,"reason":"once"}))
        })));
        run(config);
        let expected = if deterministic { 1 } else { 2 };
        assert_eq!(std::fs::read_to_string(workspace.root.join("attempts.txt")).unwrap().lines().count(), expected);
        assert_eq!(approvals.load(Ordering::Relaxed), expected, "duplicate detection must precede approval");
    }
}

/// The ledger and statuses are runtime state: a resumed run sees the recorded
/// deliverable and proof, with old checks marked stale; a fresh run starts empty.
#[test]
fn verification_state_returns_on_continue_with_old_checks_stale_and_a_fresh_run_is_empty() {
    let workspace = Workspace::new(APP);
    let resumed_provider = Provider::start(|_, _| Reply::Text("ok".into()));
    let mut resumed = workspace.config(&resumed_provider.endpoint, "continue");
    resumed.task_memory = Some(json!({
        "entries": [], "revision": 0,
        "deliverables": {"items": [{"id":"d-001","text":"add keeps adding","status":"verified","proof":["ev-002"]}], "revision": 3},
        "verification": {"epoch": 1, "next": 3, "code_changed": true,
            "changed": {"app.js": 1},
            "records": [
                {"id":"ev-001","kind":"readback","class":"readback","subject":"app.js","pass":true,"epoch":1,"turn":0,"detail":""},
                {"id":"ev-002","kind":"run","class":"functional","subject":"node check.js","pass":true,"epoch":1,"turn":1,"detail":"exit 0"}
            ]}
    }));
    run(resumed);
    let first = resumed_provider.requests()[0].to_string();
    assert!(
        first.contains("[implemented] d-001"),
        "stale verification is demoted on Continue: {first}"
    );
    assert!(
        first.contains("stale"),
        "old checks must be stale after a restart: {first}"
    );

    let fresh_workspace = Workspace::new(APP);
    let fresh_provider = Provider::start(|_, _| Reply::Text("ok".into()));
    run(fresh_workspace.config(&fresh_provider.endpoint, "start over"));
    assert!(!fresh_provider.requests()[0]
        .to_string()
        .contains("Files changed in this task"));
}

/// Regression fixture modelled on a real failure: a model edited a game page,
/// recorded every deliverable as finished, only re-read the file, and reported
/// that everything works although nothing had ever been run. Whatever the model
/// claims, the runtime must keep the items "implemented", send the claim back
/// once, and accept an honest second answer. No project or model name is used.
#[test]
fn regression_a_page_edited_and_only_reread_is_never_reported_as_verified() {
    let workspace = Workspace::new(&[
        ("index.html", "<script src=\"game.js\"></script>"),
        ("game.js", "function move() { return 0; }\n"),
    ]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"a bot opponent can be selected"})),
            deliverable("add", json!({"text":"the board highlights legal moves"})),
        ]),
        1 => Reply::Tools(vec![(
            "write_file",
            json!({"path":"game.js","content":"function move() { return bot(); }\nfunction bot() { return 1; }\n"}),
        )]),
        2 => Reply::Tools(vec![("read_file", json!({"path":"game.js"}))]),
        3 => Reply::Tools(vec![
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"edited game.js"}),
            ),
            deliverable(
                "implemented",
                json!({"id":"d-002","evidence":"edited game.js"}),
            ),
            deliverable(
                "verify",
                json!({"id":"d-001","evidence":"re-read the file, looks right"}),
            ),
        ]),
        4 => Reply::Text("Both features are complete and working.".into()),
        _ => Reply::Text(
            "Both are implemented but I could not run them, so neither is verified.".into(),
        ),
    });
    run(workspace.config(&provider.endpoint, "add a bot and legal-move highlighting"));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 1);
    let requests = provider.requests();
    assert_eq!(requests.len(), 6);
    assert!(last_tool_result(&requests[4]).contains("No fresh passing"));
    let state = requests[4].to_string();
    assert!(!state.contains("[verified]"), "{state}");
    assert!(state.contains("[implemented] d-001") && state.contains("[implemented] d-002"));
    let review = user_turn_context(&requests[5]);
    assert!(
        review.contains("d-001") && review.contains("d-002"),
        "{review}"
    );
    assert!(
        review.contains("implemented but not verified")
            || review.contains("not seen your work verified")
    );
}

/// Deep names the project's own test command and wants it to pass after the last
/// change; citing the runtime-issued evidence id is how an item is verified.
#[test]
fn deep_wants_the_project_test_suite_and_verifies_with_a_cited_evidence_id() {
    let mut files = APP.to_vec();
    files.push(("package.json", r#"{"scripts":{"test":"node check.js"}}"#));
    let workspace = Workspace::new(&files);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable(
                "add",
                json!({"text":"all project tests pass","check":"test"}),
            ),
            edit_app(GOOD),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"obs-00000001 wrote app.js"}),
            ),
        ]),
        1 => Reply::Text("Done.".into()),
        2 => Reply::Tools(vec![("run_terminal", json!({"command":"npm test"}))]),
        3 => Reply::Tools(vec![verify("d-001", Some("ev-002"))]),
        _ => Reply::Text("Verified with npm test.".into()),
    });
    let mut config = workspace.config(&provider.endpoint, "make add work");
    config.reasoning_mode = "deep".into();
    run(config);
    let requests = provider.requests();
    let review = user_turn_context(&requests[2]);
    assert!(review.contains("npm test"), "{review}");
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 1);
    assert!(requests
        .last()
        .unwrap()
        .to_string()
        .contains("[verified] d-001"));
}

/// Real chat templates reject a request that ends on assistant turns. Repeating
/// the same answer against the same failing check must neither produce one nor
/// loop: the failure is reviewed once and the answer is then accepted.
#[test]
fn repeating_the_same_answer_against_one_failure_ends_and_always_ends_on_a_user_turn() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"add keeps adding"})),
            edit_app(BAD),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"wrote app.js"}),
            ),
        ]),
        1 => Reply::Tools(vec![run_check()]),
        _ => Reply::Text("The check fails and I cannot fix it here.".into()),
    });
    run(workspace.config(&provider.endpoint, "make add work"));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert!(withheld_drafts(&journal) <= 2);
    let requests = provider.requests();
    assert!(requests.len() <= 6, "{} requests", requests.len());
    for request in &requests {
        let last = request["messages"].as_array().unwrap().last().unwrap();
        assert_ne!(last["role"], "assistant", "{last}");
    }
}

fn term(command: &str) -> (&'static str, Value) {
    ("run_terminal", json!({"command": command}))
}

/// edit -> check -> verify, then `after` runs, then the model answers. Returns
/// every request so a test can read the state the model was shown after `after`.
fn verified_then(workspace: &Workspace, after: (&'static str, Value)) -> Vec<Value> {
    let after = std::sync::Mutex::new(Some(after));
    let provider = Provider::start(move |_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"add keeps adding"})),
            edit_app(GOOD),
            deliverable(
                "implemented",
                json!({"id":"d-001","evidence":"edited app.js"}),
            ),
        ]),
        1 => Reply::Tools(vec![run_check()]),
        2 => Reply::Tools(vec![verify("d-001", None)]),
        3 => Reply::Tools(vec![after.lock().unwrap().take().unwrap()]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "make add work"));
    provider.requests()
}

#[test]
fn verify_then_write_file_makes_the_verification_stale() {
    let workspace = Workspace::new(APP);
    let requests = verified_then(&workspace, edit_app("module.exports = (a, b) => b + a;\n"));
    assert!(requests[3].to_string().contains("[verified] d-001"));
    let after = format!("{}\n{}", latest_runtime_section(&requests[4], "deliverables"), latest_runtime_section(&requests[4], "verification_state"));
    assert!(after.contains("[implemented] d-001"), "{after}");
    assert!(!after.contains("[verified] d-001"), "{after}");
    assert!(after.contains("stale"), "{after}");
}

#[test]
fn verify_then_a_mutating_terminal_command_makes_the_verification_stale() {
    for command in [
        "sed -i 's/a + b/b + a/' app.js",
        "mv app.js moved.js",
        "rm app.js",
        "mkdir -p out",
        "printf '%s' 'changed' > app.js",
        "printf '%s' 'module.exports = (a, b) => a + b;\n// edited\n' > app.js && true",
    ] {
        let workspace = Workspace::new(APP);
        let requests = verified_then(&workspace, term(command));
        assert!(requests[3].to_string().contains("[verified] d-001"));
        let after = format!("{}\n{}", latest_runtime_section(&requests[4], "deliverables"), latest_runtime_section(&requests[4], "verification_state"));
        assert!(
            after.contains("[implemented] d-001") && !after.contains("[verified] d-001"),
            "{command}: {after}"
        );
        assert!(after.contains("stale"), "{command}: {after}");
        let journal = workspace.journal();
        assert!(completed(&journal), "{command}");
        assert!(
            withheld_drafts(&journal) <= 1,
            "{command}: re-verification is one bounded review"
        );
    }
}

#[test]
fn verified_terminal_literal_noop_keeps_evidence_but_real_edits_do_not() {
    let workspace = Workspace::new(APP);
    let requests = verified_then(&workspace, term(&format!("printf '%s' '{GOOD}' > app.js")));
    let after = latest_runtime_section(&requests[4], "deliverables");
    assert!(after.contains("[verified] d-001"), "{after}");
    assert_eq!(withheld_drafts(&workspace.journal()), 0);
}

/// Reproduce Continue A after B: the shell launches in B, but one permitted
/// cd-prefixed unittest in A must be evidence for A. B's green script is not.
#[test]
fn continued_task_checks_use_tracked_source_scope_instead_of_launch_cwd() {
    // Host /tmp is intentionally hidden except for the launch workspace. Keep
    // these sibling fixtures in our ignored validation directory; do not alter
    // the sandbox to expose host /tmp.
    let parent = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".ai-research/validation");
    std::fs::create_dir_all(&parent).unwrap();
    let base = parent.join(format!("task-cwd-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir(&base).unwrap();
    let root = base.join("task-a"); std::fs::create_dir(&root).unwrap();
    let workspace = Workspace { root: root.canonicalize().unwrap(), base };
    for (path, content) in [
        ("calculator.py", "def add(a, b): return a + b\n"),
        ("test_calculator.py", "import unittest\nfrom calculator import add\nclass CalculatorTests(unittest.TestCase):\n def test_add(self): self.assertEqual(add(2, 3), 5)\n def test_negative(self): self.assertEqual(add(-2, 3), 1)\n"),
    ] { std::fs::write(workspace.root.join(path), content).unwrap(); }
    let sibling = workspace.base.join("task-b"); std::fs::create_dir_all(&sibling).unwrap();
    let unrelated = sibling.join("test_unrelated.py"); std::fs::write(&unrelated, "print('unrelated green test')\n").unwrap();
    let source = workspace.root.join("calculator.py");
    let command = format!("cd '{}' && python3 -m unittest -q", workspace.root.display());
    let foreign_command = format!("python3 '{}'", unrelated.display());
    let project_a = workspace.root.clone(); let launch = sibling.clone();
    let provider = Provider::start(move |request, turn| match turn {
        0 => Reply::Tools(vec![("deliverables", json!({"action":"add","id":"d1","text":"calculator tests pass","check":"test"}))]),
        1 => Reply::Tools(vec![("run_terminal", json!({"command":command,"deliverable_ids":["d1"]}))]),
        2 => {
            assert!(last_tool_result(request).contains("Ran 2 tests"));
            assert!(latest_runtime_section(request, "verification_state").contains("ev-001"));
            Reply::Tools(vec![("run_terminal", json!({"command":foreign_command,"deliverable_ids":["d1"]}))])
        },
        3 => {
            // The canonical tool result is followed by an observation trailer.
            let raw = last_tool_result(request);
            let result = serde_json::Deserializer::from_str(&raw).into_iter::<Value>().next().unwrap().unwrap();
            assert_eq!(result["verification_diagnostic"]["reason"], "check_outside_task_sources");
            assert_eq!(result["verification_diagnostic"]["launch_cwd"], launch.to_string_lossy().as_ref());
            assert_eq!(result["verification_diagnostic"]["check_directory"], launch.to_string_lossy().as_ref());
            assert!(result["verification_diagnostic"]["task_sources"].to_string().contains("calculator.py"));
            Reply::Tools(vec![("deliverables", json!({"action":"implemented","id":"d1","evidence":project_a.join("calculator.py").to_string_lossy()}))])
        },
        4 => Reply::Tools(vec![("deliverables", json!({"action":"verify","id":"d1","evidence":"ev-001"}))]),
        _ => {
            assert!(latest_runtime_section(request, "deliverables").contains("[verified] d1"));
            Reply::Text("Calculator unittest passed; the sibling check supplied no task proof.".into())
        },
    });
    let mut config = workspace.config(&provider.endpoint, "Continue calculator task A. Task B is unrelated.");
    config.root = Some(sibling.to_string_lossy().into_owned());
    config.workspace_roots = vec![workspace.root.to_string_lossy().into_owned()];
    config.task_memory = Some(json!({"entries":[],"verification":{"epoch":1,"records":[],"code_changed":true,"changed":{source.to_string_lossy().into_owned():1}}}));
    run(config);
    assert_eq!(provider.requests().len(), 6);
    assert!(completed(&workspace.journal()));
}

#[test]
fn task_scoped_tests_do_not_prove_sibling_integrity_claims() {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".ai-research/validation");
    std::fs::create_dir_all(&parent).unwrap();
    let base = parent.join(format!("integrity-scope-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let root = base.join("task-a"); std::fs::create_dir_all(&root).unwrap();
    let workspace = Workspace { root: root.canonicalize().unwrap(), base };
    let sibling = workspace.base.join("task-b"); std::fs::create_dir(&sibling).unwrap();
    let sentinel = sibling.join("untouched.txt"); std::fs::write(&sentinel, "fixture sentinel\n").unwrap();
    std::fs::write(workspace.root.join("calculator.py"), "def power(a, b): return a ** b\n").unwrap();
    std::fs::write(workspace.root.join("test_calculator.py"), "import unittest\nfrom calculator import power\nclass PowerTests(unittest.TestCase):\n def test_power(self): self.assertEqual(power(2, 3), 8)\n").unwrap();
    let source = workspace.root.join("calculator.py");
    let command = format!("cd '{}' && python3 -m unittest -q", workspace.root.display());
    let a = workspace.root.to_string_lossy().into_owned();
    let provider = Provider::start(move |request, turn| match turn {
        0 => Reply::Tools(vec![
            ("deliverables", json!({"action":"add","id":"a","text":"Calculator tests pass","check":"test","paths":[a]})),
            // Exercise the exact recorded wording without model-declared type/paths.
            ("deliverables", json!({"action":"add","id":"b","text":"Не изменять task-b"})),
            ("deliverables", json!({"action":"add","id":"c","text":"task-b behaviour","check":"runtime","paths":[]})),
        ]),
        1 => Reply::Tools(vec![("run_terminal", json!({"command":command,"deliverable_ids":["a","b","c"]}))]),
        2 => {
            let raw = last_tool_result(request);
            let result = serde_json::Deserializer::from_str(&raw).into_iter::<Value>().next().unwrap().unwrap();
            assert!(result["stderr"].as_str().unwrap().contains("Ran 1 test"));
            assert_eq!(result["verification_attribution"]["associated_deliverable_ids"], json!(["a"]));
            assert_eq!(result["verification_attribution"]["unverified_deliverable_ids"], json!(["b", "c"]));
            Reply::Tools(["a", "b", "c"].iter().map(|id| ("deliverables", json!({"action":"implemented","id":id}))).collect())
        },
        3 => Reply::Tools(vec![("deliverables", json!({"action":"verify","id":"a","evidence":"ev-001"}))]),
        4 => { assert!(latest_runtime_section(request,"deliverables").contains("[verified] a"));
            Reply::Tools(vec![("deliverables", json!({"action":"verify","id":"b","evidence":"ev-001"}))]) },
        5 => {
            let result = last_tool_result(request);
            assert!(result.contains("INTEGRITY_EVIDENCE_UNAVAILABLE"));
            assert!(result.contains("\"retrySameArguments\":false"));
            assert!(result.contains("pre-operation baseline"));
            assert!(latest_runtime_section(request,"verification_state").contains("Integrity cannot be verified"));
            Reply::Tools(vec![("deliverables", json!({"action":"verify","id":"c","evidence":"ev-001"}))])
        },
        _ => {
            let result = last_tool_result(request);
            assert!(result.contains("Evidence scope does not cover"));
            assert!(result.contains("\"retrySameArguments\":false"));
            let items = latest_runtime_section(request,"deliverables");
            assert!(items.contains("[verified] a"));
            assert!(items.contains("[implemented] b")); assert!(items.contains("[implemented] c"));
            Reply::Text("Calculator tests passed. Task B integrity and behaviour are unverified; no pre-operation baseline was captured.".into())
        },
    });
    let mut config = workspace.config(&provider.endpoint, "Continue A; do not modify B.");
    config.root = Some(sibling.to_string_lossy().into_owned());
    config.workspace_roots = vec![workspace.root.to_string_lossy().into_owned()];
    config.task_memory = Some(json!({"entries":[],"verification":{"epoch":1,"records":[],"code_changed":true,"changed":{source.to_string_lossy().into_owned():1}}}));
    run(config);
    let requests = provider.requests();
    assert_eq!(requests.len(), 8, "the restored modification ledger reviews the reachable unverified behaviour once, never loops on integrity");
    let guidance = requests.last().unwrap()["messages"].as_array().unwrap().iter().filter_map(|message| message["content"].as_str()).collect::<Vec<_>>().join("\n");
    assert!(guidance.contains("implemented but not verified: c task-b behaviour"));
    assert!(!guidance.contains("implemented but not verified: b"), "missing integrity capability cannot be repaired with another test");
    assert!(completed(&workspace.journal()));
    assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "fixture sentinel\n");
}

#[test]
fn verify_then_a_read_only_terminal_command_keeps_the_verification() {
    for command in [
        "cat app.js",
        "ls -la",
        "grep -n add app.js | head -5",
        "git status",
    ] {
        let workspace = Workspace::new(APP);
        let requests = verified_then(&workspace, term(command));
        let after = format!("{}\n{}", latest_runtime_section(&requests[4], "deliverables"), latest_runtime_section(&requests[4], "verification_state"));
        assert!(after.contains("[verified] d-001"), "{command}: {after}");
        assert!(!after.contains("[implemented] d-001"), "{command}: {after}");
        let journal = workspace.journal();
        assert!(completed(&journal));
        assert_eq!(withheld_drafts(&journal), 0, "{command}: no review needed");
    }
}

/// A command that edits a tracked file but looks like a check cannot vouch for
/// the code: its exit code is not recorded and earlier checks go stale.
#[test]
fn a_check_that_rewrites_a_tracked_file_is_not_trusted() {
    let workspace = Workspace::new(&[
        ("app.js", "module.exports = (a, b) => a + b;\n"),
        (
            "check.js",
            "const fs = require('fs');\nfs.appendFileSync('app.js', '// touched\\n');\nconsole.log('ok');\n",
        ),
    ]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            edit_app(GOOD),
            ("run_terminal", json!({"command":"node check.js"})),
        ]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "make add work"));
    let tail = provider.requests().last().unwrap().to_string();
    assert!(!tail.contains("[run pass]"), "{tail}");
}

const PAGE: &[(&str, &str)] = &[
    (
        "index.html",
        "<button id=\"go\">Go</button><script src=\"app.js\"></script>\n",
    ),
    ("app.js", "module.exports = (a, b) => a + b;\n"),
    (
        "dom-check.js",
        "// stands in for the page with a fake DOM; no browser involved\nconsole.log('ok');\n",
    ),
];

fn page_run(
    browser: Option<bool>,
    fake_browser: bool,
    script: fn(usize) -> Reply,
) -> (Vec<Value>, Vec<Value>) {
    let workspace = Workspace::new(PAGE);
    if fake_browser {
        let path = workspace.root.join("chromium");
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let provider = Provider::start(move |_, n| script(n));
    let mut config = workspace.config(&provider.endpoint, "make the button work");
    config.browser_capability = browser;
    run(config);
    (workspace.journal(), provider.requests())
}

fn page_edit() -> Reply {
    Reply::Tools(vec![
        deliverable("add", json!({"text":"the button works when clicked"})),
        (
            "write_file",
            json!({"path":"index.html","content":"<button id=\"go\">Go</button><script src=\"app.js\" defer></script>\n"}),
        ),
        deliverable(
            "implemented",
            json!({"id":"d-001","evidence":"edited index.html"}),
        ),
    ])
}

/// Case D: the only check the model can run is a jsdom stand-in. It exits 0 but
/// is not a browser, so the claim stays implemented, the model is told no
/// browser exists, and the run ends without looping.
#[test]
fn a_page_claim_is_never_verified_by_a_stand_in_and_ends_honestly_without_a_browser() {
    let (journal, requests) = page_run(Some(false), false, |n| match n {
        0 => page_edit(),
        1 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command":"node dom-check.js","deliverable_ids":["d-001"]}),
        )]),
        2 => Reply::Tools(vec![verify("d-001", None)]),
        _ => Reply::Text("Implemented; not checked in a browser.".into()),
    });
    assert!(completed(&journal));
    assert_eq!(
        withheld_drafts(&journal),
        0,
        "no loop for an unreachable check"
    );
    let refusal = last_tool_result(&requests[3]);
    assert!(refusal.contains("real browser"), "{refusal}");
    assert!(refusal.contains("implemented"), "{refusal}");
    let tail = requests.last().unwrap().to_string();
    assert!(tail.contains("[implemented] d-001"), "{tail}");
    assert!(!tail.contains("[verified] d-001"), "{tail}");
    assert!(tail.contains("Cannot be verified here"), "{tail}");
    assert!(requests.len() <= 4, "{} requests", requests.len());
}

/// With a browser available the same stand-in is refused and the gate asks for
/// a browser run instead.
#[test]
fn with_a_browser_available_a_stand_in_is_refused_and_the_gate_asks_for_a_browser_run() {
    let (journal, requests) = page_run(Some(true), false, |n| match n {
        0 => page_edit(),
        1 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command":"node dom-check.js","deliverable_ids":["d-001"]}),
        )]),
        2 => Reply::Tools(vec![verify("d-001", None)]),
        3 => Reply::Text("It works.".into()),
        _ => Reply::Text("Implemented, not checked in a browser.".into()),
    });
    assert!(completed(&journal));
    let refusal = last_tool_result(&requests[3]);
    assert!(refusal.contains("not a browser"), "{refusal}");
    assert_eq!(withheld_drafts(&journal), 1);
    let reminder = user_turn_context(requests.last().unwrap());
    assert!(reminder.contains("real browser"), "{reminder}");
    assert!(reminder.contains("d-001"), "{reminder}");
}

#[test]
fn a_headless_browser_exit_without_acceptance_assertions_cannot_verify_a_page_claim() {
    let (journal, requests) = page_run(Some(true), true, |n| match n {
        0 => page_edit(),
        1 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command":"./chromium --headless --dump-dom index.html","deliverable_ids":["d-001"]}),
        )]),
        2 => Reply::Tools(vec![verify("d-001", None)]),
        _ => Reply::Text("Verified in a headless browser.".into()),
    });
    assert!(completed(&journal));
    assert!(withheld_drafts(&journal)>0);
    let tail = requests.last().unwrap().to_string();
    assert!(!tail.contains("[verified] d-001"), "{tail}");
    assert!(tail.contains("[browser pass]"), "{tail}");
    assert!(last_tool_result(&requests[3]).contains("ACCEPTANCE_CRITERIA_REQUIRED"));
}

/// A deliverable can name what it needs; a passing test run does not satisfy a
/// build requirement, and "file was created" needs only a read-back.
#[test]
fn a_deliverable_can_require_a_specific_capability() {
    let workspace = Workspace::new(APP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"it builds","check":"build"})),
            edit_app(GOOD),
            deliverable("implemented", json!({"id":"d-001","evidence":"edited"})),
        ]),
        1 => Reply::Tools(vec![run_check()]),
        2 => Reply::Tools(vec![verify("d-001", None)]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "make it build"));
    let refusal = last_tool_result(&provider.requests()[3]);
    assert!(refusal.contains("build"), "{refusal}");

    let workspace = Workspace::new(&[("notes.md", "old")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"file created","check":"readback"})),
            ("write_file", json!({"path":"notes.md","content":"new"})),
            deliverable("implemented", json!({"id":"d-001","evidence":"wrote"})),
            verify("d-001", None),
        ]),
        _ => Reply::Text("done".into()),
    });
    run(workspace.config(&provider.endpoint, "write notes"));
    assert!(provider
        .requests()
        .last()
        .unwrap()
        .to_string()
        .contains("[verified] d-001"));
}

/// Every terminal call the UI saw start is closed by a result event carrying
/// the same call ID: a refused composition included (no process ever starts),
/// and a failed command keeps its structured execution so the result card
/// still names the command and process.
#[test]
fn every_started_tool_call_emits_its_own_result_event() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command":"echo a && echo b"}),
        )]),
        1 => Reply::Tools(vec![("run_terminal", json!({"command":"exit 3"}))]),
        _ => Reply::Text("reported".into()),
    });
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_local-ai-agent-runtime"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let request = json!({
        "type":"run","run_id":"lifecycle","endpoint":provider.endpoint,"model":"scripted","approval_ui":true,
        "system":"system","user":"run the checks","project_root":workspace.root,
        "context_limit":65536,"reasoning_mode":"fast","web_mode":"off","policy":"auto",
        "evidence_dir":workspace.base.join("evidence"),
    });
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{request}").unwrap();
    let mut events = Vec::new();
    for line in std::io::BufRead::lines(std::io::BufReader::new(child.stdout.take().unwrap())) {
        let event: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let event = event.get("event").cloned().unwrap_or(event);
        let kind = event["type"].as_str().unwrap_or("").to_owned();
        if kind == "host_tool_call" && event["name"] == "request_permission" {
            let command = event.pointer("/arguments/arguments/command").and_then(Value::as_str).unwrap_or("");
            let approved = command == "exit 3";
            writeln!(stdin, "{}", json!({"type":"host_tool_result","run_id":"lifecycle","id":event["id"],"result":{"approved":approved,"reason":if approved { "once" } else { "user_rejected" }}})).unwrap();
        }
        events.push(event);
        if matches!(kind.as_str(), "final" | "agent_error" | "agent_stopped") {
            break;
        }
    }
    drop(stdin);
    let _ = child.wait();
    let ids = |kinds: &[&str]| -> Vec<String> {
        events
            .iter()
            .filter(|event| kinds.contains(&event["type"].as_str().unwrap_or("")))
            .map(|event| event["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let started = ids(&["tool_call_started"]);
    assert_eq!(started.len(), 2, "{events:?}");
    assert_eq!(
        ids(&["tool_result", "tool_error"]),
        started,
        "each started call needs exactly one result with its own ID"
    );
    let result = |id: &str| {
        events
            .iter()
            .find(|event| {
                event["id"] == id
                    && matches!(event["type"].as_str(), Some("tool_result" | "tool_error"))
            })
            .unwrap()
            .clone()
    };
    assert!(result(&started[0])["message"]
        .as_str()
        .unwrap()
        .contains("PERMISSION_DENIED"));
    let failed = result(&started[1]);
    let payload: Value = serde_json::from_str(
        failed["message"]
            .as_str()
            .or(failed["content"].as_str())
            .unwrap(),
    )
    .unwrap();
    let execution = payload.get("execution").unwrap_or(&payload);
    assert_eq!(execution["command"], "exit 3", "{payload}");
    assert_eq!(execution["exit_code"], 3, "{payload}");
    assert!(execution["pid"].is_u64(), "{payload}");
}

fn saved_work_budget(workspace: &Workspace) -> local_ai_agent_runtime::agent::work_budget::WorkBudget {
    workspace.journal().iter().rev().find_map(|entry| entry.get("WorkBudget")
        .map(|value| serde_json::from_value(value.clone()).unwrap())).unwrap()
}

#[test]
fn more_than_256_productive_actions_keep_tools_and_a_legacy_denied_budget_does_not_restore() {
    use local_ai_agent_runtime::agent::{transcript::Transcript,work_budget::WorkBudget};
    let files:Vec<(String,String)>=(0..310).map(|n|(format!("file-{n}.txt"),format!("unique observation {n}"))).collect();
    let refs:Vec<(&str,&str)>=files.iter().map(|(a,b)|(a.as_str(),b.as_str())).collect();
    let workspace=Workspace::new(&refs);
    let mut transcript=Transcript::durable(&workspace.base.join("evidence"),"legacy",&[],workspace.root.to_str()).unwrap();
    let old:WorkBudget=serde_json::from_value(json!({"used":256,"limit":256,"decision":"denied","closed":false})).unwrap();
    transcript.push_run_user(json!({"role":"user","content":"Continue the unfinished inspection"}));
    transcript.mark_finalizing();
    transcript.checkpoint_work_budget(old);drop(transcript);
    let observations=Arc::new(std::sync::atomic::AtomicUsize::new(0));let count=observations.clone();
    let provider=Provider::start(move|request,_| {
        let n=count.load(Ordering::Relaxed);
        if request.get("tools").is_none() && n<310 {return Reply::Text("Earlier distinct file observations are preserved; continue the current inspection.".into());}
        if n<310 {assert!(tool_names(request).contains(&"read_file".into()));count.fetch_add(1,Ordering::Relaxed);Reply::Tools(vec![("read_file",json!({"path":format!("file-{n}.txt")}))])}
        else {Reply::Text("Inspected 310 distinct files.".into())}
    });
    let mut config=workspace.config(&provider.endpoint,"Continue the unfinished inspection");config.context_limit=262_144;
    run(config);
    assert_eq!(observations.load(Ordering::Relaxed),310);
    assert!(provider.requests().len()>=311);
    assert!(completed(&workspace.journal()));
    assert_eq!(saved_work_budget(&workspace).used,311);
    assert_eq!(saved_work_budget(&workspace).limit,0);
    let next=Provider::start(|request,_|{assert!(tool_names(request).contains(&"read_file".into()));Reply::Text("New execution.".into())});
    run(workspace.config(&next.endpoint,"Continue"));
    assert_eq!(saved_work_budget(&workspace).used,1);
}

#[test]
fn confirmed_metadata_loop_saves_checkpoint_and_preserves_evidence() {
    let workspace = Workspace::new(&[("a.txt","productive observation"),("b.txt","fresh progress")]);
    let provider = Provider::start(|request,n| {
        match n {
            0 => Reply::Tools(vec![("read_file",json!({"path":"a.txt"}))]),
            1 => Reply::Tools(vec![("task_memory",json!({"action":"record","finding":"Earlier useful observation", "status":"confirmed", "evidence":"obs-00000001"}))]),
            2..=12 => Reply::Tools(vec![("deliverables",json!({"action":"view"}))]),
            13 => {
                let messages=request["messages"].as_array().unwrap();
                let views=messages.iter().filter_map(|m|m["tool_calls"].as_array()).flatten().filter(|c|c["function"]["name"]=="deliverables").count();
                assert_eq!(views,1, "only first useful view belongs in next model context");
                assert!(messages.iter().any(|m|m["role"]=="user" && m["content"].as_str().is_some_and(|text|text.contains("Inspect"))));
                assert!(request.to_string().contains("Earlier useful observation"), "Task Memory survives cleanup");
                assert!(messages.iter().any(|m|m["name"]=="read_file"), "productive read pair survives");
                Reply::Tools(vec![("read_file",json!({"path":"b.txt"}))])
            },
            _ => Reply::Text("Inspected both fixture files.".into()),
        }
    });
    let config=workspace.config(&provider.endpoint,"Inspect the files; preserve useful observations.");
    run(config);
    let journal=workspace.journal();
    assert!(!completed(&journal), "a stopped loop is not a completed task");
    assert!(journal.iter().any(|line| line.get("PauseCheckpoint").is_some()), "confirmed loop saves without provider repair turns");
    let checkpoint = journal.iter().find_map(|line| line.get("PauseCheckpoint")).unwrap();
    assert_eq!(checkpoint["memory"]["stop_reason"], "loop_detected");
    assert!(checkpoint["memory"]["loop_guard"].is_object());
    assert!(journal.iter().any(|line|line["Message"]["name"]=="read_file"), "productive observations remain durable");
    assert_eq!(journal.iter().filter(|line|line.get("ContextExclusion").is_some()).count(),0, "Stop must not rewrite model context");
    assert!(provider.requests().len() <= 14, "no additional LLM checkpoint/repair loop");
}

#[test]
fn live_loop_pause_resume_correction_and_cancel_preserve_state() {
    use local_ai_agent_runtime::agent::control::{LoopCommand,LoopAction};
    for correction in [false,true] {
        let workspace=Workspace::new(SHOP);
        let control=Arc::new(Mutex::new(local_ai_agent_runtime::agent::control::ExecutionControl{interactive:true,..Default::default()}));
        let queue=control.clone();
        // The detector's stable signature can be reconstructed from identical observations.
        // Actual result-dependent signature is read from the durable journal once paused.
        let base=workspace.base.clone();
        let sender=std::thread::spawn(move|| {
            for _ in 0..400 {
                let active=std::fs::read(base.join("evidence/active.json")).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok());
                if let Some(dir)=active.and_then(|v|v["run_dir"].as_str().map(str::to_owned)) {
                    let journal=std::fs::read_to_string(base.join("evidence").join(dir).join("events.jsonl")).unwrap_or_default();
                    if let Some(n)=journal.lines().filter_map(|l|serde_json::from_str::<Value>(l).ok()).find_map(|v|v["entry"].get("RuntimeNotice").filter(|v|v["notice"]["level"]==3).cloned()) {
                        queue.lock().unwrap().commands.push_back(LoopCommand{id:None,action:if correction{LoopAction::CorrectResume}else{LoopAction::ContinueAnyway},signature:n["notice"]["signature"].as_str().unwrap().into()});
                        if correction {
                            // This read-loop has no proven metadata suffix: repair must pause safely.
                            queue.lock().unwrap().commands.push_back(LoopCommand{id:None,action:LoopAction::ContinueAnyway,signature:n["notice"]["signature"].as_str().unwrap().into()});
                        }
                        return;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            panic!("Strong loop never reached a live pause");
        });
        let provider=Provider::start(move|request,n| {
            if n<12 {Reply::Tools(vec![("list_directory",json!({"path":"."}))])} else {
                if correction {assert!(request["messages"][0]["content"].as_str().unwrap().contains("Agent runtime notice"));}
                Reply::Text("Resumed the preserved task.".into())
            }
        });
        let mut config=workspace.config(&provider.endpoint,READ_ONLY);config.control=control;
        run(config);sender.join().unwrap();assert!(completed(&workspace.journal()));
        // Keep cancellation regression independent of speculative task completion.
    }
}

#[test]
fn native_images_reach_provider_with_mime_and_original_payload() {
    let fixture = Workspace::new(&[("fixture.txt", "fixture")]);
    let images = vec!["data:image/png;base64,iVBORw==", "data:image/jpeg;base64,/9j/", "data:image/webp;base64,UklGRg=="];
    let expected = images.clone();
    let provider = Provider::start(move |request, _| {
        let messages = request["messages"].as_array().unwrap();
        let user = messages.iter().find(|m| m["role"] == "user").unwrap();
        let parts = user["content"].as_array().unwrap();
        assert!(parts[0]["text"].as_str().unwrap().contains("Describe images"));
        assert_eq!(parts.iter().filter(|part| part["type"] == "image_url").map(|part| part["image_url"]["url"].as_str().unwrap()).collect::<Vec<_>>(), expected);
        assert!(user.get("images").is_none());
        Reply::Text("Images received".into())
    });
    let mut config = fixture.config(&provider.endpoint, "Describe images");
    config.user_images = images.into_iter().map(str::to_owned).collect();
    run(config);
    assert!(!provider.requests().is_empty());
}

#[test]
fn web_schema_exposure_is_host_opt_in() {
    for enabled in [false, true] {
        let fixture = Workspace::new(&[("fixture.txt", "fixture")]);
        let provider = Provider::start(move |request, _| {
            assert_eq!(tool_names(request).contains(&"web_open".to_owned()), enabled);
            assert!(!tool_names(request).contains(&"unrestricted_fetch".to_owned()));
            Reply::Text("Done".into())
        });
        let mut config = fixture.config(&provider.endpoint, "Read a public page");
        config.web_tools = vec![json!({"type":"function","function":{"name":"web_open","parameters":{"type":"object","properties":{"url":{"type":"string"}}}}}), json!({"type":"function","function":{"name":"unrestricted_fetch"}})];
        config.host_tools = if enabled { Some(Arc::new(local_ai_agent_runtime::tools::web::HostTools::default())) } else { None };
        run(config);
        assert!(!provider.requests().is_empty());
    }
}

#[test]
fn host_web_result_is_an_ordinary_auditable_observation() {
    let fixture = Workspace::new(&[("fixture.txt", "fixture")]);
    let provider = Provider::start(|request, turn| {
        if turn == 0 { return Reply::Tools(vec![("web_open", json!({"url":"https://example.com"}))]); }
        let result = last_tool_result(request);
        assert!(result.contains("Public fixture"));
        assert!(result.contains("obs-"), "web output bypassed observation ledger");
        Reply::Text("Read the page".into())
    });
    let host = Arc::new(local_ai_agent_runtime::tools::web::HostTools::default());
    let host_thread = host.clone();
    let reply = std::thread::spawn(move || {
        for _ in 0..500 {
            host_thread.reply("host-1", json!({"title":"Public fixture","content":"Fixture page","links":[]}));
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    });
    let mut config = fixture.config(&provider.endpoint, "Read the public fixture page");
    config.host_tools = Some(host);
    config.web_tools = vec![json!({"type":"function","function":{"name":"web_open","parameters":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}}})];
    run(config); reply.join().unwrap();
    assert_eq!(provider.requests().len(), 2);
}

#[test]
fn native_image_history_resumes_without_resending_blobs_to_a_text_only_request() {
    let fixture = Workspace::new(&[("fixture.txt", "fixture")]);
    let first = Provider::start(|_, _| Reply::Text("Image described".into()));
    let mut initial = fixture.config(&first.endpoint, "Describe image");
    initial.user_images = vec!["data:image/jpeg;base64,/9j/".into()]; initial.user_image_refs = vec!["image-1".into()];
    run(initial);
    let next = Provider::start(|request, _| {
        let messages = request["messages"].as_array().unwrap();
        assert!(messages.iter().any(|message| message["content"].as_str().is_some_and(|text| text.contains("Image described"))));
        assert!(messages.iter().all(|message| !message["content"].is_array()), "old native images reached a text-only request");
        Reply::Text("Continued".into())
    });
    let mut continued = fixture.config(&next.endpoint, "Continue with text");
    continued.history = vec![json!({"role":"user","content":"Describe image","image_refs":["image-1"]}), json!({"role":"assistant","content":"Image described"})];
    run(continued);
    assert_eq!(next.requests().len(), 1);
    let journal = fixture.journal_or_empty();
    assert!(journal.iter().any(|entry| entry.to_string().contains("image_refs")));
}

#[test]
fn fresh_and_regenerated_requests_deliver_russian_preference_and_current_thinking() {
    let fixture = Workspace::new(&[("placeholder.txt", "fixture")]);
    for enabled in [false, true] {
        let provider = Provider::start(move |request, _| {
            let prompt = request["messages"][0]["content"].as_str().unwrap();
            assert!(prompt.contains("Язык интерфейса: русский"));
            assert!(prompt.contains("Russian (default; explicit user language requests take priority)"));
            assert!(!prompt.contains("English (default"));
            assert_eq!(request["chat_template_kwargs"]["enable_thinking"], enabled);
            Reply::Text("Ответ модели".into())
        });
        let mut config = fixture.config(&provider.endpoint, "Объясни принцип работы");
        config.root = None;
        config.ui_language = Some("ru".into());
        config.system = "Язык интерфейса: русский. Предпочитай русский для ответов и рассуждений; явная просьба пользователя имеет приоритет.".into();
        config.reasoning_options = Some(json!({"main":{"chat_template_kwargs":{"enable_thinking":enabled}}}));
        run(config);
        assert!(!provider.requests().is_empty());
        // Regenerate retains the previous raw lineage outside the active path.
        if !enabled {
            std::fs::rename(fixture.base.join("evidence"), fixture.base.join("archived-attempt")).unwrap();
        }
    }
    assert!(fixture.base.join("archived-attempt").exists());
}

/// A repeated, identical report write must not destroy functional proof;
/// the file executor performs no write, inode replacement or epoch mutation.
#[test]
fn an_unchanged_report_does_not_invalidate_observed_runtime_evidence() {
    let workspace=Workspace::new(&[("check.py","print('checked')\n"),("report.md","observed output")]);
    let provider=Provider::start(|request,turn|match turn {
        0=>Reply::Tools(vec![
            ("deliverables",json!({"action":"add","id":"d1","text":"script behaviour","check":"runtime"})),
            ("deliverables",json!({"action":"implemented","id":"d1","evidence":"check.py"})),
        ]),
        1=>Reply::Tools(vec![("run_terminal",json!({"command":"python3 check.py","deliverable_ids":["d1"]}))]),
        2=>Reply::Tools(vec![("write_file",json!({"path":"report.md","content":"observed output"}))]),
        3=>{
            assert!(last_tool_result(request).contains("\"unchanged\":true"));
            Reply::Tools(vec![("deliverables",json!({"action":"verify","id":"d1","evidence":"ev-001"}))])
        },
        _=>{
            assert!(latest_runtime_section(request,"deliverables").contains("[verified] d1"));
            Reply::Text("Observed runtime behaviour remains verified after the unchanged report.".into())
        }
    });
    run(workspace.config(&provider.endpoint,"Check the script, then write the same report text and verify the observed behaviour."));
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(),5);
}

/// A terminal rewrite of identical bytes preserves evidence; unlike the file
/// tool, the shell can still update filesystem timestamps.
#[test]
fn an_identical_terminal_write_preserves_observed_runtime_evidence() {
    let workspace=Workspace::new(&[("check.py","print('checked')\n"),("report.md","observed output")]);
    let provider=Provider::start(|request,turn|match turn {
        0=>Reply::Tools(vec![
            ("deliverables",json!({"action":"add","id":"d1","text":"script behaviour","check":"runtime"})),
            ("deliverables",json!({"action":"implemented","id":"d1","evidence":"check.py"})),
        ]),
        1=>Reply::Tools(vec![("run_terminal",json!({"command":"python3 check.py","deliverable_ids":["d1"]}))]),
        2=>Reply::Tools(vec![("run_terminal",json!({"command":"printf '%s' 'observed output' > report.md"}))]),
        3=>{
            assert!(last_tool_result(request).contains("\"unchanged\":true"));
            Reply::Tools(vec![("deliverables",json!({"action":"verify","id":"d1","evidence":"ev-001"}))])
        },
        _=>{
            assert!(latest_runtime_section(request,"deliverables").contains("[verified] d1"));
            Reply::Text("Observed runtime behaviour remains verified after the unchanged report.".into())
        }
    });
    run(workspace.config(&provider.endpoint,"Check the script, then write the same report text and verify the observed behaviour."));
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(),5);
}

/// A repeated, identical report write must not destroy functional proof;
/// the file executor performs no write, inode replacement or epoch mutation.
#[test]
fn an_identical_patch_preserves_observed_runtime_evidence() {
    let workspace=Workspace::new(&[("check.py","print('checked')\n"),("report.md","observed output\n")]);
    let provider=Provider::start(|request,turn|match turn {
        0=>Reply::Tools(vec![
            ("deliverables",json!({"action":"add","id":"d1","text":"script behaviour","check":"runtime"})),
            ("deliverables",json!({"action":"implemented","id":"d1","evidence":"check.py"})),
        ]),
        1=>Reply::Tools(vec![("run_terminal",json!({"command":"python3 check.py","deliverable_ids":["d1"]}))]),
        2=>Reply::Tools(vec![("apply_patch",json!({"patch":"*** Begin Patch\n*** Update File: report.md\n-observed output\n+observed output\n*** End Patch"}))]),
        3=>{
            assert!(last_tool_result(request).contains("\"unchanged\":true"));
            Reply::Tools(vec![("deliverables",json!({"action":"verify","id":"d1","evidence":"ev-001"}))])
        },
        _=>{
            assert!(latest_runtime_section(request,"deliverables").contains("[verified] d1"));
            Reply::Text("Observed runtime behaviour remains verified after the unchanged report.".into())
        }
    });
    run(workspace.config(&provider.endpoint,"Check the script, then write the same report text and verify the observed behaviour."));
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(),5);
}

#[test]
fn invalid_edits_and_missing_checks_have_actionable_retry_guidance() {
    let workspace = Workspace::new(&[("app.py", "value = 1\n")]);
    let provider = Provider::start(|request, turn| match turn {
        0 => Reply::Tools(vec![("read_file", json!({"path":"app.py"}))]),
        1 => Reply::Tools(vec![("apply_patch", json!({"patch":"*** Begin Patch\n*** Update File: app.py\n@@\n-value = 99\n+value = 2\n*** End Patch"}))]),
        2 => {
            let result = last_tool_result(request);
            assert!(result.contains("patch does not match current content"));
            assert!(result.contains("INVALID_EDIT_ARGUMENTS"));
            assert!(result.contains("\"retrySameArguments\":false"));
            assert!(result.contains("Read the current file/range"));
            Reply::Tools(vec![("replace_text", json!({"path":"app.py","old_text":"value = 99","new_text":"value = 2"}))])
        },
        3 => {
            let result = last_tool_result(request);
            assert!(result.contains("old_text does not exactly match"));
            assert!(result.contains("\"retrySameArguments\":false"));
            assert!(result.contains("correct the exact old_text"));
            Reply::Tools(vec![
                ("deliverables", json!({"action":"add","id":"a","text":"Python behaviour","check":"runtime"})),
                ("deliverables", json!({"action":"implemented","id":"a"})),
            ])
        },
        4 => Reply::Tools(vec![("deliverables", json!({"action":"verify","id":"a"}))]),
        _ => {
            let result = last_tool_result(request);
            assert!(result.contains("No fresh passing runtime evidence"));
            assert!(result.contains("\"retrySameArguments\":false"));
            assert!(result.contains("fresh passing evidence ID"));
            Reply::Text("No file was changed. Behaviour was not verified.".into())
        },
    });
    run(workspace.config(&provider.endpoint, "Exercise invalid edit diagnostics without changing files."));
    assert_eq!(std::fs::read_to_string(workspace.root.join("app.py")).unwrap(), "value = 1\n");
    assert_eq!(provider.requests().len(), 6); assert!(completed(&workspace.journal()));
}

#[test]
fn a_pending_verification_rejection_recovers_after_implementation_with_the_same_arguments() {
    let workspace=Workspace::new(&[("check.py","print('checked')\n")]);
    let provider=Provider::start(|request,turn|match turn {
        0=>Reply::Tools(vec![("deliverables",json!({"action":"add","id":"d1","text":"Script behaviour","check":"runtime"}))]),
        1=>Reply::Tools(vec![("run_terminal",json!({"command":"python3 check.py","deliverable_ids":["d1"]}))]),
        2=>Reply::Tools(vec![("deliverables",json!({"action":"verify","id":"d1","evidence":"ev-001"}))]),
        3=>{
            let result=last_tool_result(request);
            assert!(result.contains("is pending"));
            assert!(result.contains("\"retrySameArguments\":false"));
            assert!(result.contains("action=implemented"));
            Reply::Tools(vec![("deliverables",json!({"action":"implemented","id":"d1"}))])
        },
        4=>Reply::Tools(vec![("deliverables",json!({"action":"verify","id":"d1","evidence":"ev-001"}))]),
        _=>{
            assert!(latest_runtime_section(request,"deliverables").contains("[verified] d1"));
            Reply::Text("Verified after correcting the prerequisite.".into())
        }
    });
    run(workspace.config(&provider.endpoint,"Check the script behaviour."));
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(),6);
}

#[test]
fn repeated_successful_terminal_results_reach_provider_then_pause_without_unsafe_cleanup() {
    let workspace=Workspace::new(&[("fixture.txt","unchanged")]);
    let provider=Provider::start(|request,n| {
        if n>0 { assert!(last_tool_result(request).contains("unchanged-observation"), "terminal feedback missing"); }
        Reply::Tools(vec![("run_terminal",json!({"command":"printf unchanged-observation"}))])
    });
    let mut config=workspace.config(&provider.endpoint,"Inspect the fixture, then change strategy if observations repeat");
    config.control.lock().unwrap().interactive=true;
    let control=config.control.clone();let cancelled=config.cancelled.clone();
    let worker=std::thread::spawn(move||run(config));
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(15);
    while control.lock().unwrap().active_signature.is_none() && std::time::Instant::now()<deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let paused=control.lock().unwrap().active_signature.is_some();
    cancelled.store(true,Ordering::Relaxed);worker.join().unwrap();
    assert!(paused,"terminal repetition never paused");
    assert!(provider.requests().len()<=12,"soft repair must escalate on recurrence");
    let journal=workspace.journal();
    assert!(journal.iter().any(|v|v.to_string().contains("Agent runtime notice")));
    assert!(!journal.iter().any(|v|v.get("ContextExclusion").is_some()),"arbitrary commands cannot be removed as metadata");
}

#[test]
fn permission_transport_refusals_never_spawn_or_become_transient_command_errors() {
    for reason in ["timeout","ui_unavailable"] {
        let workspace=Workspace::new(&[("fixture.txt","untouched")]);
        let provider=Provider::start(move|request,n| {
            if n==0 { return Reply::Tools(vec![("run_terminal",json!({"command":"printf changed > fixture.txt"}))]); }
            let result:Value=serde_json::from_str(&last_tool_result(request)).unwrap();
            assert_eq!(result["code"],"PERMISSION_DENIED");assert_eq!(result["reason"],reason);
            assert_eq!(result["retrySameArguments"],false);
            Reply::Text("No operation was authorized.".into())
        });
        let mut config=workspace.config(&provider.endpoint,"Write the fixture only after approval");
        config.host_tools=Some(Arc::new(local_ai_agent_runtime::tools::web::HostTools::with_dispatch(move|name,_| {
            assert_eq!(name,"request_permission");Some(json!({"approved":false,"reason":reason}))
        })));
        run(config);
        assert_eq!(std::fs::read_to_string(workspace.root.join("fixture.txt")).unwrap(),"untouched");
    }
}

#[test]
fn dependent_edits_in_one_batch_use_current_content_and_failed_edits_require_new_evidence() {
    let workspace = Workspace::new(&[("a.txt", "alpha")]);
    let provider = Provider::start(|request, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
        1 => Reply::Tools(vec![
            ("replace_text", json!({"path":"a.txt","old_text":"alpha","new_text":"beta"})),
            ("replace_text", json!({"path":"a.txt","old_text":"beta","new_text":"gamma"})),
        ]),
        2 => {
            let results = tool_result_text(request);
            assert!(!results.contains("INVALID_EDIT_ARGUMENTS"), "dependent edits were not serialized: {results}");
            Reply::Tools(vec![
                ("replace_text", json!({"path":"a.txt","old_text":"alpha","new_text":"wrong"})),
                ("replace_text", json!({"path":"a.txt","old_text":"alpha","new_text":"wrong"})),
            ])
        },
        3 => {
            let results = tool_result_text(request);
            assert!(results.contains("INVALID_EDIT_ARGUMENTS"));
            assert!(results.contains("DUPLICATE_FAILED_OPERATION"));
            Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))])
        },
        4 => Reply::Tools(vec![("replace_text", json!({"path":"a.txt","old_text":"gamma","new_text":"delta"}))]),
        _ => Reply::Text("Edited against the updated contents.".into()),
    });
    run(workspace.config(&provider.endpoint, "Edit a.txt sequentially"));
    assert_eq!(std::fs::read_to_string(workspace.root.join("a.txt")).unwrap(), "delta");
    assert!(completed(&workspace.journal()));
}

#[test]
fn runtime_pause_snapshot_survives_compaction_and_repeated_resume_without_replaying_edits() {
    use local_ai_agent_runtime::agent::transcript::Transcript;
    let workspace = Workspace::new(&[("a.txt", "original")]);
    let pause = Arc::new(AtomicBool::new(false)); let flag = pause.clone();
    let provider = Provider::start(move |_, n| if n == 0 { Reply::Tools(vec![
        ("plan", json!({"action":"set","steps":["Change a.txt","Read the final content"]})),
        ("write_file", json!({"path":"a.txt","content":"changed once"})),
    ]) } else { flag.store(true, Ordering::Relaxed); Reply::Text("This interrupted generation is not a checkpoint.".into()) });
    let mut config = workspace.config(&provider.endpoint, "Change a.txt, then inspect"); config.pause_requested = pause;
    run(config);
    assert_eq!(std::fs::read_to_string(workspace.root.join("a.txt")).unwrap(), "changed once");
    let mut transcript = Transcript::durable(&workspace.base.join("evidence"), "compact-paused", &[], workspace.root.to_str()).unwrap();
    let covers = transcript.entries().len();
    transcript.compact("Established: a.txt was successfully written to 'changed once'. Do not repeat the write. Next: read the final content.".into(), covers);
    drop(transcript);
    let never = Provider::start(|_, _| panic!("Already requested Pause must not invoke the provider"));
    let mut paused = workspace.config(&never.endpoint, "Continue"); paused.pause_requested = Arc::new(AtomicBool::new(true));
    let started = std::time::Instant::now(); run(paused);
    eprintln!("Pause after compaction: {:?}", started.elapsed());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    let resumed = Provider::start(|request, n| {
        assert!(request.to_string().contains("Read the final content"), "runtime plan lost across compaction/resume");
        if n == 0 { Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]) }
        else { assert!(tool_result_text(request).contains("changed once")); Reply::Text("Read the saved result without repeating its mutation.".into()) }
    });
    run(workspace.config(&resumed.endpoint, "Continue"));
    assert_eq!(std::fs::read_to_string(workspace.root.join("a.txt")).unwrap(), "changed once");
    assert_eq!(resumed.requests().len(), 2);
}

#[test]
fn pause_during_compaction_does_not_commit_an_interrupted_summary() {
    use local_ai_agent_runtime::agent::transcript::Transcript;
    let workspace = Workspace::new(&[("a.txt", "original")]);
    let mut transcript = Transcript::durable(&workspace.base.join("evidence"), "before-compaction", &[], workspace.root.to_str()).unwrap();
    for n in 0..24 {
        transcript.push_message(json!({"role":"user","content":format!("Earlier inspection {n}")}));
        transcript.assistant_message(format!("Established observation {n}: {}", "unique substantive historical details. ".repeat(160)));
    }
    drop(transcript);
    let pause = Arc::new(AtomicBool::new(false)); let flag = pause.clone();
    let provider = Provider::start(move |request, _| {
        assert!(request.get("tools").is_none(), "expected compaction provider call");
        flag.store(true, Ordering::Relaxed);
        Reply::Reasoning("Interrupted summary must not replace durable evidence.".into())
    });
    let mut config = workspace.config(&provider.endpoint, "Continue inspecting a.txt");
    config.context_limit = 32768; config.pause_requested = pause;
    let started = std::time::Instant::now(); run(config);
    eprintln!("Pause during compaction: {:?}", started.elapsed());
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    let journal = workspace.journal();
    assert!(journal.iter().any(|entry| entry.get("PauseCheckpoint").is_some()));
    assert!(!journal.iter().any(|entry| entry.get("Compaction").is_some()));
    assert_eq!(provider.requests().len(), 1);
}
