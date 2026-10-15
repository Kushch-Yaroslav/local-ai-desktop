use local_ai_agent_runtime::{process::{group::spawn_owned, tasks}, tools::shell, agent::permissions::{AutonomyMode, Permissions}};
use serde_json::{json, Value};
use std::{process::{Child, Command, Stdio}, path::PathBuf};
struct Dummy(Child);
impl Dummy {
    fn new() -> Self { let mut command = Command::new("sleep"); command.arg("120").stdout(Stdio::null()); Self(spawn_owned(command).unwrap().0) }
    fn alive(&mut self) -> bool { self.0.try_wait().unwrap().is_none() }
}
impl Drop for Dummy { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
struct Workspace(PathBuf);
impl Workspace { fn new() -> Self { let path=std::env::temp_dir().join(format!("lad-runtime-protection-{}",std::process::id())); std::fs::create_dir_all(&path).unwrap(); Self(path) } }
impl Drop for Workspace { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
fn run(root: &Workspace, command: &str) -> serde_json::Value {
    shell::execute(&root.0, &json!({"command":command,"timeout_ms":5000}),true,||false,|_,_,_,_|{},|_,_|{}).unwrap()
}

#[test]
fn critical_dummy_processes_survive_every_mode_and_all_ambiguous_shell_forms() {
    let root=Workspace::new();
    let mut electron=Dummy::new(); let mut rust=Dummy::new(); let mut llama=Dummy::new();
    let mut ordinary=Dummy::new();
    for mode in [AutonomyMode::Strict, AutonomyMode::Autonomous] {
        let permissions=Permissions { mode, trusted_roots:vec![root.0.to_string_lossy().into()] };
        let pid=llama.0.id();
        for command in [
            format!("kill {pid}"), format!("kill {}",electron.0.id()), format!("kill {}",rust.0.id()),
            format!("kill $(printf '{pid}')"), format!("kill -- -{pid}"),
            "pkill -f 'sleep'".into(), "killall sleep".into(), "fuser -k 3000/tcp".into(),
            format!("kill {pid} {}",ordinary.0.id()), format!("sudo kill {pid}"),
            format!("bash -c 'kill {pid}'"), format!("printf 'must not execute' > marker; kill {pid}"),
            "for p in $(ss -ltnp 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do kill \"$p\" 2>/dev/null; done; sleep 2; ss -ltn | grep -E ':(3000|8888)\\b'".into(),
        ] {
            let _ = permissions.decide("run_terminal",&json!({"command":command}),Some(&root.0));
            // Deliberately bypass classification and simulate explicit approval:
            // the trusted executor must still refuse Absolute Autopilot too.
            assert_eq!(run(&root,&command)["code"],"PROTECTED_RUNTIME_PROCESS","{mode:?}: {command}");
            assert!(electron.alive() && rust.alive() && llama.alive() && ordinary.alive());
            assert!(!root.0.join("marker").exists(),"partially executed destructive command");
        }
    }
    // Shell-script content need not be understood by a classifier. A direct
    // syscall from arbitrary code still cannot address any host process.
    std::fs::write(root.0.join("attack.py"),format!("import ctypes\nc=ctypes.CDLL(None)\nr=c.syscall(62,{},15)\nprint(r)\n",llama.0.id())).unwrap();
    let result=run(&root,"python3 attack.py");
    assert_eq!(result["exit_code"],0,"{result}"); assert_eq!(result["stdout"],"-1\n");
    assert!(llama.alive());
    std::fs::write(root.0.join("syscalls.py"),"import ctypes\nc=ctypes.CDLL(None,use_errno=True)\nfor number,args in [(308,(0,0)),(101,(0,0,0,0)),(311,(0,0,0,0,0,0)),(438,(0,0,0)),(425,(0,0)),(41,(1,1,0)),(56,(0x10000000|17,0,0,0,0)),(435,(0,0)),(155,(0,0)),(166,(b'/',2)),(166,(b'.',2)),(429,(0,0,0,0,0)),(442,(0,0,0,0,0))]:\n r=c.syscall(number,*args)\n print(str(number)+':'+str(r)+':'+str(ctypes.get_errno()))\n").unwrap();
    let filtered=run(&root,"python3 syscalls.py");
    assert_eq!(filtered["exit_code"],0,"{filtered}");
    for number in [308,101,311,438,425,41,56,155,429,442] { assert!(filtered["stdout"].as_str().unwrap().contains(&format!("{number}:-1:1")),"seccomp missing: {filtered}"); }
    assert!(filtered["stdout"].as_str().unwrap().contains("435:-1:38"));
    // Direct umount2 calls against sandbox root and project mount must fail,
    // even though the setup profile permits detaching its old staging root.
    assert_eq!(filtered["stdout"].as_str().unwrap().matches("166:-1:1").count(),2,"payload umount2 must remain blocked: {filtered}");
    std::fs::write(root.0.join("threads.py"),"import threading\nt=threading.Thread(target=lambda:print('thread-ok'))\nt.start();t.join()\n").unwrap();
    assert_eq!(run(&root,"python3 threads.py")["stdout"],"thread-ok\n");
    assert!(electron.alive() && rust.alive() && llama.alive());
    // Host Stop/Restart/Quit paths still act on their real child handles.
    llama.0.kill().unwrap(); llama.0.wait().unwrap();
    let mut restarted=Dummy::new(); assert!(restarted.alive());
    electron.0.kill().unwrap(); rust.0.kill().unwrap();
}

#[test]
fn owned_tasks_can_clean_up_but_cannot_adopt_pids_ports_or_mixed_targets() {
    // Distinct root for independent test parallelism.
    let root=Workspace(PathBuf::from(format!("/tmp/lad-owned-tasks-{}",std::process::id()))); std::fs::create_dir_all(&root.0).unwrap();
    let mut bystander=Dummy::new();
    let cwd=root.0.to_str().unwrap();
    std::fs::write(root.0.join("server.py"),"from http.server import HTTPServer, BaseHTTPRequestHandler\ns=HTTPServer(('127.0.0.1',0),BaseHTTPRequestHandler)\nprint('READY:'+str(s.server_port),flush=True)\ns.serve_forever()\n").unwrap();
    let start=tasks::execute("run-a",cwd,&json!({"task_action":"start","command":"python3 server.py"}));
    let id=start["task_id"].as_str().expect("owned task handle");
    assert_eq!(tasks::registered_handles("run-a"),vec![id.to_owned()]);
    assert!(tasks::registered_handles("run-b").is_empty());
    let mut status=Value::Null;
    for _ in 0..100 {
        status=tasks::execute("run-a",cwd,&json!({"task_action":"status","task_id":id}));
        if status["status"]=="exited" || status["output"].as_str().is_some_and(|s|s.contains("READY:")) { break; }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(status["status"],"running","{status}");
    assert!(status["output"].as_str().unwrap().contains("READY:"),"server did not bind a real ephemeral listener: {status}");
    assert!(status["owned_processes"].as_array().unwrap().len()>=2);
    let port=status["output"].as_str().unwrap().lines().find_map(|line|line.strip_prefix("READY:")).unwrap().parse::<u16>().unwrap();
    let owned=status["owned_processes"].as_array().unwrap().iter().map(|p|p["pid"].as_u64().unwrap()).collect::<Vec<_>>();
    assert_eq!(tasks::execute("run-b",cwd,&json!({"task_action":"stop","task_id":id}))["code"],"PROTECTED_RUNTIME_PROCESS");
    assert_eq!(tasks::execute("run-a",cwd,&json!({"task_action":"stop","task_id":format!("{}",bystander.0.id())}))["code"],"PROTECTED_RUNTIME_PROCESS");
    assert_eq!(tasks::execute("run-a",cwd,&json!({"task_action":"stop","task_id":format!("{id},{}",bystander.0.id())}))["code"],"PROTECTED_RUNTIME_PROCESS");
    assert_eq!(tasks::execute("run-a",cwd,&json!({"task_action":"stop","task_id":id}))["status"],"stopped");
    for _ in 0..100 {
        if owned.iter().all(|pid|std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true,|stat|stat.rsplit_once(") ").is_some_and(|(_,rest)|rest.starts_with('Z')))) { break; }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(owned.iter().all(|pid|std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true,|stat|stat.rsplit_once(") ").is_some_and(|(_,rest)|rest.starts_with('Z')))),"owned server descendants survived cleanup");
    let released=std::net::TcpListener::bind(("127.0.0.1",port)).expect("owned test listener port was not released"); drop(released);
    assert!(bystander.alive());
    // Expired identity/opaque handle never authorizes a new process (PID reuse).
    assert_eq!(tasks::execute("run-a",cwd,&json!({"task_action":"stop","task_id":id}))["code"],"PROTECTED_RUNTIME_PROCESS");
    tasks::cleanup("run-a");
}

#[test]
fn runtime_files_are_read_only_and_an_unavailable_boundary_never_falls_back() {
    let root=Workspace(PathBuf::from(format!("/tmp/lad-runtime-file-{}",std::process::id()))); std::fs::create_dir_all(&root.0).unwrap();
    let protected=root.0.join("runtime.conf"); std::fs::write(&protected,"original").unwrap();
    let helper=PathBuf::from(env!("CARGO_BIN_EXE_local-ai-agent-runtime"));
    let output=Command::new(&helper).args(["--terminal-exec",root.0.to_str().unwrap(),"printf changed > runtime.conf","5000"])
        .env("LOCAL_AI_PROTECTED_PATHS",json!([protected]).to_string()).output().unwrap();
    let result:Value=serde_json::from_slice(&output.stdout).unwrap();
    assert_ne!(result["exit_code"],0); assert_eq!(std::fs::read_to_string(&protected).unwrap(),"original");
    let missing=root.0.join("marker");
    let output=Command::new(&helper).args(["--terminal-exec",root.0.to_str().unwrap(),"printf unprotected > marker","5000"])
        .env("LOCAL_AI_PROTECTED_PATHS",json!([root.0]).to_string()).output().unwrap();
    let result:Value=serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["code"],"PROTECTED_RUNTIME_PROCESS"); assert!(!missing.exists());
}
