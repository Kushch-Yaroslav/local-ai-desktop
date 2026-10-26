//! Long-lived development tasks have opaque, run-scoped handles. A port or PID
//! supplied by the model is never authority to signal a host process.
use super::{group::{spawn_owned, OwnedGroup, Signal}, isolation};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, VecDeque}, io::Read, process::{Child, Stdio}, sync::{Mutex, OnceLock}};

const MAX_TASKS_PER_RUN: usize = 8;
const HISTORY_PER_RUN: usize = 32;

struct Task {
    child: Child,
    group: OwnedGroup,
    owner: String,
    cwd: String,
    command: String,
    identity: Value,
    output: std::sync::Arc<Mutex<String>>,
    readers: Vec<std::thread::JoinHandle<()>>,
}
impl Task {
    fn join_readers(&mut self) {
        for reader in self.readers.drain(..) { let _=reader.join(); }
    }
}
impl Drop for Task {
    fn drop(&mut self) { let _ = self.group.signal(&mut self.child, Signal::Kill); let _ = self.child.wait(); self.join_readers(); }
}

#[derive(Clone)]
struct TaskSnapshot {
    task_id: String,
    owner: String,
    cwd: String,
    command: String,
    pid: Option<u32>,
    state: &'static str,
    exit_code: Option<i32>,
    url: Option<String>,
    error_code: Option<&'static str>,
    error: Option<String>,
    output: String,
}
impl TaskSnapshot {
    fn value(&self) -> Value {
        json!({
            "task_id":self.task_id,"cwd":self.cwd,"command":self.command,
            "pid":self.pid,"pgid":self.pid,"state":self.state,
            "status":match self.state {"ready"|"starting"=>"running","failed"=>"exited",_=>"stopped"},
            "exit_code":self.exit_code,"ownership":"current run; isolated managed task",
            "readiness":if self.state=="ready" {"vite-ready-output"} else if self.state=="starting" {"waiting-for-managed-server-readiness"} else {"not-ready"},
            "url":self.url,"code":self.error_code,"diagnostic":self.error,"output":self.output
        })
    }
}

static TASKS: OnceLock<Mutex<BTreeMap<String, Task>>> = OnceLock::new();
static HISTORY: OnceLock<Mutex<BTreeMap<String, VecDeque<TaskSnapshot>>>> = OnceLock::new();
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
fn tasks() -> &'static Mutex<BTreeMap<String, Task>> { TASKS.get_or_init(|| Mutex::new(BTreeMap::new())) }
fn history() -> &'static Mutex<BTreeMap<String, VecDeque<TaskSnapshot>>> { HISTORY.get_or_init(|| Mutex::new(BTreeMap::new())) }

/// Registered handles, not a claim that their children are still running.
/// Historical transcript entries never grant process ownership.
pub fn registered_handles(owner: &str) -> Vec<String> {
    tasks().lock().unwrap().iter().filter(|(_,task)|task.owner==owner).map(|(id,_)|id.clone()).collect()
}

fn identity(pid: u32) -> Option<Value> {
    let raw=std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields=raw.rsplit_once(") ")?.1.split_whitespace().collect::<Vec<_>>();
    Some(json!({"pid":pid,"state":fields.first()? ,"ppid":fields.get(1)?.parse::<u32>().ok()? ,"pgid":fields.get(2)?.parse::<u32>().ok()? ,"session_id":fields.get(3)?.parse::<u32>().ok()? ,"start_time":fields.get(19)? ,"executable":std::fs::read_link(format!("/proc/{pid}/exe")).ok(),"role":"agent-owned-task"}))
}

fn descendants(pid: u32) -> Vec<Value> {
    let all=std::fs::read_dir("/proc").into_iter().flatten().flatten().filter_map(|p|p.file_name().to_str()?.parse::<u32>().ok().and_then(identity)).collect::<Vec<_>>();
    let mut owned=vec![u64::from(pid)]; let mut result=Vec::new();
    for _ in 0..all.len() {
        let before=owned.len();
        for process in &all {
            let id=process["pid"].as_u64().unwrap();
            if id==u64::from(pid) || owned.contains(&process["ppid"].as_u64().unwrap()) {
                if !result.iter().any(|p: &Value|p["pid"]==process["pid"]) { result.push(process.clone()); }
                if !owned.contains(&id) { owned.push(id); }
            }
        }
        if before==owned.len() { break; }
    }
    result
}

fn bounded_output(task: &Task) -> String { task.output.lock().unwrap().clone() }

fn strip_ansi(text: &str) -> String {
    let mut out=String::with_capacity(text.len()); let mut escape=false;
    for ch in text.chars() {
        if escape { if ch.is_ascii_alphabetic() { escape=false; } continue; }
        if ch=='\u{1b}' { escape=true; continue; }
        out.push(ch);
    }
    out
}

/// Only the explicit Vite ready banner and its Local URL grant preview readiness.
/// A port number, PID, or a generic process line is not enough.
fn vite_ready_url(output: &str) -> Option<String> {
    let clean=strip_ansi(output);
    if !clean.lines().any(|line|line.contains("VITE v")&&line.contains("ready in")) { return None; }
    for line in clean.lines() {
        let Some((_,value))=line.split_once("Local:") else { continue; };
        let candidate=value.split_whitespace().next()?.trim_end_matches(['\u{1b}','\r']);
        if !(candidate.starts_with("http://localhost:")||candidate.starts_with("http://127.0.0.1:")) { continue; }
        let authority=candidate.strip_prefix("http://")?.split(['/', '?', '#']).next()?;
        let port=authority.rsplit_once(':')?.1;
        if port.is_empty()||!port.bytes().all(|b|b.is_ascii_digit())||port.parse::<u16>().ok().filter(|p|*p!=0).is_none() { continue; }
        if authority.contains('@')||authority.contains('[') { continue; }
        return Some(candidate.to_owned());
    }
    None
}

fn node_version_error(output: &str) -> Option<String> {
    let clean=strip_ansi(output);
    if clean.contains("Vite requires Node.js") && clean.contains("You are using Node.js") {
        let detail=clean.lines().filter(|line|line.contains("Vite requires Node.js")||line.contains("You are using Node.js")).collect::<Vec<_>>().join(" ");
        Some(detail.chars().take(260).collect())
    } else { None }
}

fn snapshot(task_id: &str, task: &Task, state: &'static str, exit_code: Option<i32>, output: String) -> TaskSnapshot {
    let vite_url=vite_ready_url(&output);
    let node_error=node_version_error(&output);
    let state=if node_error.is_some() {"failed"} else if state=="starting"&&vite_url.is_some() {"ready"} else {state};
    TaskSnapshot {
        task_id:task_id.into(),owner:task.owner.clone(),cwd:task.cwd.clone(),command:task.command.clone(),
        pid:Some(task.child.id()),state,exit_code,url:vite_url,
        error_code:node_error.as_ref().map(|_|"UNSUPPORTED_NODE_VERSION"),error:node_error,output,
    }
}

fn remember(snapshot: TaskSnapshot) {
    let mut all=history().lock().unwrap(); let entries=all.entry(snapshot.owner.clone()).or_default();
    entries.retain(|entry|entry.task_id!=snapshot.task_id);
    entries.push_back(snapshot);
    while entries.len()>HISTORY_PER_RUN { entries.pop_front(); }
}

fn cached(owner: &str, cwd: &str, id: &str) -> Option<Value> {
    history().lock().unwrap().get(owner)?.iter().find(|entry|entry.cwd==cwd&&entry.task_id==id).map(TaskSnapshot::value)
}

/// Completed leaders do not consume a run's eight active slots. Their bounded
/// diagnostic snapshots remain available to list/status for this generation.
fn reap_completed(owner: &str) {
    let mut registry=tasks().lock().unwrap();
    let completed=registry.iter_mut().filter(|(_,task)|task.owner==owner).filter_map(|(id,task)| {
        task.child.try_wait().ok().flatten().map(|exit| {task.join_readers();(id.clone(),snapshot(id,task,if exit.success(){"stopped"}else{"failed"},exit.code(),bounded_output(task)))})
    }).collect::<Vec<_>>();
    for (id,summary) in completed { registry.remove(&id); remember(summary); }
}

fn list(owner: &str, cwd: &str) -> Value {
    reap_completed(owner);
    let active=tasks().lock().unwrap().iter().filter(|(_,task)|task.owner==owner&&task.cwd==cwd).map(|(id,task)|snapshot(id,task,"starting",None,bounded_output(task)).value()).collect::<Vec<_>>();
    let completed=history().lock().unwrap().get(owner).into_iter().flatten().filter(|entry|entry.cwd==cwd).map(TaskSnapshot::value).collect::<Vec<_>>();
    json!({"tasks":active,"recently_completed":completed,"active_limit":MAX_TASKS_PER_RUN,"ownership":"current run and exact project working directory","note":"Only entries returned by this current-generation registry are owned. A ready Vite URL comes from the owned task's VITE ready banner and Local line; PIDs and ports never authorize adoption."})
}

pub fn execute(owner: &str, cwd: &str, arguments: &Value) -> Value {
    let action=arguments["task_action"].as_str().unwrap_or("");
    if action=="list" { return list(owner,cwd); }
    if action=="start" {
        let command=arguments["command"].as_str().unwrap_or("");
        if command.trim().is_empty()||isolation::process_management(command) { return isolation::refusal("Use a foreground development/test command, not host process management."); }
        reap_completed(owner);
        let mut registry=tasks().lock().unwrap();
        if registry.values().filter(|t|t.owner==owner).count()>=MAX_TASKS_PER_RUN { return isolation::refusal("At most eight active development tasks can be held by a run. Use task_action=list/status/stop to inspect and release owned tasks; completed tasks are reaped automatically."); }
        let mut sandbox=match isolation::sandbox(command,cwd){Ok(c)=>c,Err(e)=>return isolation::refusal(&e.to_string())};
        sandbox.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (mut child,group)=match spawn_owned(sandbox){Ok(pair)=>pair,Err(e)=>return isolation::refusal(&e.to_string())};
        let identity=identity(child.id()).unwrap_or(Value::Null);
        let output=std::sync::Arc::new(Mutex::new(String::new()));
        let mut readers=Vec::new();
        for mut stream in [child.stdout.take().map(|p|Box::new(p) as Box<dyn Read+Send>),child.stderr.take().map(|p|Box::new(p) as Box<dyn Read+Send>)].into_iter().flatten(){
            let out=output.clone();readers.push(std::thread::spawn(move||{let mut buffer=[0;2048];while let Ok(count)=stream.read(&mut buffer){if count==0{break;}let mut text=out.lock().unwrap();text.push_str(&String::from_utf8_lossy(&buffer[..count]));if text.len()>16_384{let mut start=text.len()-16_384;while !text.is_char_boundary(start){start+=1;}text.drain(..start);}}}));
        }
        let id=format!("managed-{}",NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed));let pid=child.id();
        let task=Task{child,group,owner:owner.into(),cwd:cwd.into(),command:command.into(),identity:identity.clone(),output,readers};
        let record=snapshot(&id,&task,"starting",None,bounded_output(&task));
        registry.insert(id.clone(),task);
        return json!({"task_id":id,"pid":pid,"pgid":identity["pgid"],"session_id":identity["session_id"],"command":command,"cwd":cwd,"state":record.state,"status":"started","url":record.url,"ownership":"current run; isolated managed task","note":"Use task_action=list or task_action=status with this task_id to read startup output and confirm the actual dev-server URL. Do not start a second task just to wait or probe readiness; do not manage a process by PID or port."});
    }

    let id=arguments["task_id"].as_str().unwrap_or("");
    let mut registry=tasks().lock().unwrap();
    let Some(task)=registry.get_mut(id).filter(|task|task.owner==owner&&task.cwd==cwd) else {
        drop(registry);
        return if action=="status" {
            cached(owner,cwd,id).unwrap_or_else(||isolation::refusal("Unknown, expired or differently owned task. PID/port-based adoption is forbidden."))
        } else {
            isolation::refusal("Task is not an active task owned by this run and project. No process was signalled; PID/port-based adoption is forbidden.")
        };
    };
    if action=="status" {
        let exit=task.child.try_wait().ok().flatten();if exit.is_some(){task.join_readers();}let output=bounded_output(task);let summary=snapshot(id,task,if exit.is_some(){"stopped"}else{"starting"},exit.and_then(|s|s.code()),output);
        if exit.is_some(){registry.remove(id);remember(summary.clone());}
        else {
            let owned=descendants(task.child.id());
            let mut result=summary.value();result["owned_processes"]=json!(owned);result["process_identity"]=task.identity.clone();
            return result;
        }
        return summary.value();
    }
    if action=="stop" {
        if let Err(error)=task.group.signal(&mut task.child,Signal::Term){return isolation::refusal(&format!("Owned task group identity changed: {error:?}"));}
        let summary=snapshot(id,task,"stopped",None,bounded_output(task));
        registry.remove(id);remember(summary);
        return json!({"task_id":id,"state":"stopped","status":"stopped","ownership":"current run; exact managed task"});
    }
    isolation::refusal("Expected task_action=start/list/status/stop.")
}

pub fn cleanup(owner: &str) {
    tasks().lock().unwrap().retain(|_,task|task.owner!=owner);
    history().lock().unwrap().remove(owner);
}
pub struct OwnerGuard(String);
impl OwnerGuard { pub fn new(owner: &str)->Self{Self(owner.into())} }
impl Drop for OwnerGuard { fn drop(&mut self){cleanup(&self.0);} }

#[cfg(test)]
mod tests {
    use super::{node_version_error, vite_ready_url};

    #[test]
    fn vite_readiness_requires_its_ready_banner_and_explicit_loopback_local_url() {
        assert_eq!(vite_ready_url("VITE v6.4.0 ready in 210 ms\n  ➜  Local:   http://localhost:5174/\n"), Some("http://localhost:5174/".into()));
        assert_eq!(vite_ready_url("VITE v6.4.0 ready in 210 ms\n  ➜  Local:   http://127.0.0.1:5174/\n"), Some("http://127.0.0.1:5174/".into()));
        assert_eq!(vite_ready_url("Listening at http://localhost:5174/"), None);
        assert_eq!(vite_ready_url("VITE v6.4.0 ready in 210 ms\n  ➜  Local:   http://192.168.1.4:5174/\n"), None);
        assert_eq!(vite_ready_url("VITE v6.4.0 ready in 210 ms\n  ➜  Local:   http://localhost:0/\n"), None);
        assert_eq!(vite_ready_url("VITE v6.4.0 ready in 210 ms\n  ➜  Local:   https://localhost:5174/\n"), None);
    }

    #[test]
    fn incompatible_node_diagnostic_is_specific_and_does_not_require_startup_guessing() {
        let output = "You are using Node.js 18.19.1. Vite requires Node.js version 20.19+ or 22.12+.\n";
        assert_eq!(node_version_error(output).as_deref(), Some("You are using Node.js 18.19.1. Vite requires Node.js version 20.19+ or 22.12+."));
        assert_eq!(node_version_error("crypto.hash is not a function\n"), None);
    }
}
