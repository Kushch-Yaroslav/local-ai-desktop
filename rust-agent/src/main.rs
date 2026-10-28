use local_ai_agent_runtime::{
    agent::{
        loop_runtime::{self, Config},
        policy::RunPolicy,
    },
    protocol::{read, Request},
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};

#[derive(Clone)]
struct Control {
    external: Arc<local_ai_agent_runtime::tools::web::HostTools>,
    cancelled: Arc<AtomicBool>,
    steering: Arc<Mutex<Vec<String>>>,
    pause_requested: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    steering_closed: Arc<AtomicBool>,
    execution: Arc<Mutex<local_ai_agent_runtime::agent::control::ExecutionControl>>,
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.get(1).map(String::as_str) == Some("--version") {
        println!("local-ai-agent-runtime {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if arguments.get(1).map(String::as_str) == Some("--sandbox-shell") {
        let result = local_ai_agent_runtime::process::isolation::exec_shell(arguments.get(2).map(String::as_str).unwrap_or(""), arguments.get(3).and_then(|value|value.parse::<i32>().ok()).unwrap_or(-1));
        eprintln!("PROTECTED_RUNTIME_PROCESS: sandbox startup failed: {}", result.unwrap_err());
        std::process::exit(126);
    }
    if arguments.get(1).map(String::as_str) == Some("--terminal-exec") {
        let cwd = arguments.get(2).map(String::as_str).unwrap_or(".");
        let command = arguments.get(3).map(String::as_str).unwrap_or("");
        let timeout = arguments.get(4).and_then(|s| s.parse().ok()).unwrap_or(120_000);
        let mut result = local_ai_agent_runtime::process::runner::run_streaming_authorized(command,cwd,timeout,true,|| false,|_,_,_,_| {},|_,_| {});
        for (field, limit) in [("command",1200),("stdout",80_000),("stderr",20_000)] {
            if let Some(text)=result[field].as_str() {
                if text.chars().count()>limit { result[field]=serde_json::json!(format!("{}\n[diagnostic output truncated]",text.chars().take(limit).collect::<String>())); }
            }
        }
        println!("{result}");
        return;
    }
    // Keep stdin live for the duration of a run. Jan's loop consumes steering at
    // turn boundaries and cancellation is observed by both upstream and tools.
    let (requests, incoming) = mpsc::channel();
    std::thread::spawn(move || {
        while let Some(request) = read() {
            if requests.send(request).is_err() {
                break;
            }
        }
    });
    let mut controls: HashMap<String, Control> = HashMap::new();
    // A one-shot CLI client may close stdin immediately after `run`; completed
    // work is still owned by its worker. Electron keeps stdin open for control
    // messages, while this loop remains alive after EOF until shutdown.
    loop {
        controls.retain(|_, control| !control.finished.load(Ordering::Relaxed));
        let request = match incoming.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(request) => request,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) if controls.is_empty() => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
        };
        match request {
            Request::Run {
                run_id,
                endpoint,
                model,
                system,
                user,
                history_user,
                recover_completed_history,
                user_images,
                user_image_refs,
                web_tools,
                artifact_tools,
                approval_ui,
                permissions,
                attachment_tools,
                project_root,
                secondary_project_root,
                context_limit,
                reasoning_mode,
                supports_reasoning,
                reasoning_options,
                web_mode,
                browser_qa,
                policy,
                history,
                evidence_dir,
                task_memory,
                provider_max_output,
                workspace_roots,
            } => {
                if !controls.is_empty() {
                    local_ai_agent_runtime::protocol::emit(
                        &run_id,
                        local_ai_agent_runtime::agent::events::Event::AgentError {
                            code: "generation_busy".into(),
                            message: "Only one Agent generation may run at a time".into(),
                        },
                    );
                    continue;
                }
                let control = Control {
                    execution: Arc::new(Mutex::new(local_ai_agent_runtime::agent::control::ExecutionControl{permissions,interactive:approval_ui,..Default::default()})),
                    external: Arc::new(local_ai_agent_runtime::tools::web::HostTools::with_permissions(approval_ui)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    steering: Arc::new(Mutex::new(Vec::new())),
                    pause_requested: Arc::new(AtomicBool::new(false)),
                    finished: Arc::new(AtomicBool::new(false)),
                    steering_closed: Arc::new(AtomicBool::new(false)),
                };
                controls.insert(run_id.clone(), control.clone());
                std::thread::spawn(move || {
                    loop_runtime::run(Config {
                        run_id: run_id.clone(),
                        endpoint,
                        model,
                        system,
                        user,
                        history_user,
                        recover_completed_history,
                        user_images,
                        user_image_refs,
                        browser_qa,
                        web_tools: if web_mode == "auto" { web_tools } else { Vec::new() },
                        artifact_tools,
                        attachment_tools,
                        host_tools: Some(control.external),
                        root: project_root,
                        secondary_root: secondary_project_root,
                        workspace_roots,
                        context_limit,
                        reasoning_mode,
                        supports_reasoning,
                        reasoning_options,
                        policy: if policy == "safe" {
                            RunPolicy::Safe
                        } else {
                            RunPolicy::Auto
                        },
                        history,
                        evidence_dir,
                        task_memory,
                        provider_max_output,
                        browser_capability: None,
                        cancelled: control.cancelled,
                        steering: control.steering,
                        pause_requested: control.pause_requested,
                        steering_closed: control.steering_closed,
                        control: control.execution,
                    });
                    control.finished.store(true, Ordering::Relaxed);
                });
            }
            Request::HostToolResult { run_id, id, result } => {
                if let Some(control) = controls.get(&run_id) { control.external.reply(&id, result); }
            }
            Request::Cancel { run_id } => {
                if let Some(control) = controls.get(&run_id) {
                    control.cancelled.store(true, Ordering::Relaxed);
                }
            }
            Request::Steer {
                run_id,
                content,
                intent,
            } => {
                if let Some(control) = controls.get(&run_id) {
                    let mut queue = control.steering.lock().expect("steering lock");
                    if control.steering_closed.load(Ordering::Relaxed)
                        || control.finished.load(Ordering::Relaxed)
                        || control.cancelled.load(Ordering::Relaxed)
                        || content.trim().is_empty()
                        || content.len() > 64_000
                        || queue.len() >= 4
                    {
                        local_ai_agent_runtime::protocol::emit(
                            &run_id,
                            local_ai_agent_runtime::agent::events::Event::SteeringRejected {
                                message: "Agent is closed or steering queue/input limit exceeded"
                                    .into(),
                            },
                        );
                    } else {
                        queue.push(content.clone());
                        if intent.as_deref() == Some("pause") {
                            control.pause_requested.store(true, Ordering::Relaxed);
                            local_ai_agent_runtime::protocol::emit(&run_id, local_ai_agent_runtime::agent::events::Event::RunState { state: "pause_requested".into() });
                        }
                        local_ai_agent_runtime::protocol::emit(
                            &run_id,
                            local_ai_agent_runtime::agent::events::Event::SteeringAccepted {
                                content,
                            },
                        );
                    }
                } else {
                    local_ai_agent_runtime::protocol::emit(
                        &run_id,
                        local_ai_agent_runtime::agent::events::Event::SteeringRejected {
                            message: "Agent run has ended".into(),
                        },
                    );
                }
            }
            Request::Control {run_id,id,permissions,action,signature} => {
                use local_ai_agent_runtime::{protocol::emit,agent::events::Event};
                if let Some(control)=controls.get(&run_id).filter(|c|!c.finished.load(Ordering::Relaxed)&&!c.cancelled.load(Ordering::Relaxed)) {
                    let mut c=control.execution.lock().expect("execution control");
                    if action.is_some() && !c.commands.is_empty() {emit(&run_id,Event::ControlRejected{id,message:"Loop recovery is already pending".into()});continue;}
                    if action.is_some() && (signature.is_none() || c.active_signature.is_none() || signature.as_ref()!=c.active_signature.as_ref()){emit(&run_id,Event::ControlRejected{id,message:"Loop warning is no longer active".into()});continue;}
                    if let Some(permissions)=permissions {if c.permissions!=permissions{c.permissions_epoch=c.permissions_epoch.saturating_add(1);}c.permissions=permissions;}
                    if let (Some(action),Some(signature))=(action,signature){c.commands.push_back(local_ai_agent_runtime::agent::control::LoopCommand{id:Some(id),action,signature});}
                    else { emit(&run_id,Event::ControlAccepted{id}); }
                } else {emit(&run_id,Event::ControlRejected{id,message:"Agent execution ended".into()});}
            }
            Request::Reasoning { run_id, id, mode, options, selection } => {
                use local_ai_agent_runtime::{protocol::emit, agent::events::Event};
                if let Some(control) = controls.get(&run_id).filter(|c| !c.finished.load(Ordering::Relaxed) && !c.cancelled.load(Ordering::Relaxed) && !c.pause_requested.load(Ordering::Relaxed)) {
                    if !matches!(mode.as_str(), "fast" | "deep") || !options.is_object() {
                        emit(&run_id, Event::ControlRejected { id, message: "Invalid reasoning configuration".into() });
                        continue;
                    }
                    control.execution.lock().expect("execution control").reasoning = Some((mode, options, selection));
                    emit(&run_id, Event::ControlAccepted { id });
                } else { emit(&run_id, Event::ControlRejected { id, message: "Agent execution ended or pausing".into() }); }
            }
            Request::Shutdown => {
                for control in controls.values() {
                    control.cancelled.store(true, Ordering::Relaxed);
                }
                break;
            }
        }
    }
}
