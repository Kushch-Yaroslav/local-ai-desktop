//! Long-lived development tasks have opaque, run-scoped handles. A port or PID
//! supplied by the model is never authority to signal a host process.
use super::{group::{spawn_owned, OwnedGroup, Signal}, isolation};
use serde_json::{json, Value};
use std::{collections::BTreeMap, process::{Child, Stdio}, sync::{Mutex, OnceLock}, io::Read};

struct Task { child: Child, group: OwnedGroup, owner: String, cwd: String, command: String, identity: Value, output: std::sync::Arc<Mutex<String>> }
impl Drop for Task {
    fn drop(&mut self) { let _ = self.group.signal(&mut self.child, Signal::Kill); let _ = self.child.wait(); }
}
static TASKS: OnceLock<Mutex<BTreeMap<String, Task>>> = OnceLock::new();
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
fn tasks() -> &'static Mutex<BTreeMap<String, Task>> { TASKS.get_or_init(|| Mutex::new(BTreeMap::new())) }
/// Registered handles, not a claim that their children are still running.
/// Historical transcript entries never grant process ownership.
pub fn registered_handles(owner: &str) -> Vec<String> {
    tasks().lock().unwrap().iter().filter(|(_,task)|task.owner==owner).map(|(id,_)|id.clone()).collect()
}
fn identity(pid: u32) -> Option<Value> {
    let raw=std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields=raw.rsplit_once(") ")?.1.split_whitespace().collect::<Vec<_>>();
    Some(json!({"pid":pid,"state":fields.first()?,"ppid":fields.get(1)?.parse::<u32>().ok()?,"pgid":fields.get(2)?.parse::<u32>().ok()?,"session_id":fields.get(3)?.parse::<u32>().ok()?,"start_time":fields.get(19)?,"executable":std::fs::read_link(format!("/proc/{pid}/exe")).ok(),"role":"agent-owned-task"}))
}
fn descendants(pid: u32) -> Vec<Value> {
    let all=std::fs::read_dir("/proc").into_iter().flatten().flatten().filter_map(|p|p.file_name().to_str()?.parse::<u32>().ok().and_then(identity)).collect::<Vec<_>>();
    let mut owned=vec![u64::from(pid)];
    let mut result=Vec::new();
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
pub fn execute(owner: &str, cwd: &str, arguments: &Value) -> Value {
    let mut tasks = tasks().lock().unwrap();
    let action = arguments["task_action"].as_str().unwrap_or("");
    if action == "start" {
        let command = arguments["command"].as_str().unwrap_or("");
        if command.trim().is_empty() || isolation::process_management(command) { return isolation::refusal("Use a foreground development/test command, not host process management."); }
        if tasks.values().filter(|t| t.owner == owner).count() >= 8 { return isolation::refusal("At most eight development tasks can be held by a run."); }
        let mut sandbox = match isolation::sandbox(command, cwd) { Ok(c) => c, Err(e) => return isolation::refusal(&e.to_string()) };
        sandbox.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (mut child, group) = match spawn_owned(sandbox) { Ok(pair) => pair, Err(e) => return isolation::refusal(&e.to_string()) };
        let identity = identity(child.id()).unwrap_or(Value::Null);
        let output = std::sync::Arc::new(Mutex::new(String::new()));
        for mut stream in [child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)].into_iter().flatten() {
            let out = output.clone();
            std::thread::spawn(move || { let mut buffer = [0; 2048]; while let Ok(count) = stream.read(&mut buffer) { if count == 0 { break; } let mut text = out.lock().unwrap(); text.push_str(&String::from_utf8_lossy(&buffer[..count])); if text.len() > 16_384 { let mut start = text.len() - 16_384; while !text.is_char_boundary(start) { start += 1; } text.drain(..start); } } });
        }
        let id = format!("task-{}-{}", std::process::id(), NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed));
        let pid = child.id();
        tasks.insert(id.clone(), Task { child, group, owner: owner.into(), cwd: cwd.into(), command: command.into(), identity, output });
        return json!({"task_id":id,"pid":pid,"pgid":pid,"session_id":pid,"status":"started","ownership":"run-scoped isolated namespace","note":"Use task_action=status for readiness; task_action=stop for cleanup. Host PIDs are diagnostic only."});
    }
    let id = arguments["task_id"].as_str().unwrap_or("");
    let Some(task) = tasks.get_mut(id).filter(|t| t.owner == owner && t.cwd == cwd) else { return isolation::refusal("Unknown, expired or differently owned task. PID/port-based adoption is forbidden."); };
    if action == "status" {
        let status = task.child.try_wait().ok().flatten();
        if status.is_some() {
            if let Some(mut diagnostic)=isolation::startup_failure(&task.output.lock().unwrap()) {
                diagnostic["task_id"]=json!(id); diagnostic["status"]=json!("error");
                return diagnostic;
            }
        }
        return json!({"task_id":id,"pid":task.child.id(),"command":task.command,"process_identity":task.identity,"owned_processes":if status.is_none(){descendants(task.child.id())}else{Vec::new()},"status":if status.is_some(){"exited"}else{"running"},"exit_code":status.and_then(|s|s.code()),"output":task.output.lock().unwrap().clone()});
    }
    if action == "stop" {
        if let Err(e) = task.group.signal(&mut task.child, Signal::Term) { return isolation::refusal(&format!("Owned task group identity changed: {e:?}")); }
        tasks.remove(id); // Drop escalates only this unreaped, owned group.
        return json!({"task_id":id,"status":"stopped"});
    }
    isolation::refusal("Expected task_action=start/status/stop.")
}
pub fn cleanup(owner: &str) { tasks().lock().unwrap().retain(|_, task| task.owner != owner); }
pub struct OwnerGuard(String);
impl OwnerGuard { pub fn new(owner: &str) -> Self { Self(owner.into()) } }
impl Drop for OwnerGuard { fn drop(&mut self) { cleanup(&self.0); } }
