use crate::process::group::{spawn_owned, Signal};
use std::{
    io::{BufRead, BufReader},
    process::Stdio,
    sync::mpsc,
    time::Duration,
};

#[derive(Default)]
struct CapturedPipeline {
    exit_code: Option<i32>,
    statuses: Vec<i32>,
    pending_empty_stdout: usize,
}

fn flush_empty_stdout(count: usize, stdout: &mut String, output: &mut impl FnMut(&str, &str)) {
    for _ in 0..count {
        output("stdout", "");
        stdout.push('\n');
    }
}

fn capture_line(
    stream: &str,
    line: String,
    marker: &str,
    stdout: &mut String,
    stderr: &mut String,
    pipeline: &mut CapturedPipeline,
    output: &mut impl FnMut(&str, &str),
) {
    if stream == "stdout" {
        if let Some(metadata) = line.strip_prefix(marker) {
            if let Some((exit_code, statuses)) = metadata.split_once('|') {
                let parsed_exit = exit_code.parse::<i32>();
                let parsed_statuses = statuses
                    .split_whitespace()
                    .map(str::parse::<i32>)
                    .collect::<Result<Vec<_>, _>>();
                if let (Ok(exit_code), Ok(statuses)) = (parsed_exit, parsed_statuses) {
                    pipeline.exit_code = Some(exit_code);
                    pipeline.statuses = statuses;
                    flush_empty_stdout(
                        pipeline.pending_empty_stdout.saturating_sub(1),
                        stdout,
                        output,
                    );
                    pipeline.pending_empty_stdout = 0;
                    return;
                }
            }
        }
        if stream == "stdout" && line.is_empty() {
            pipeline.pending_empty_stdout += 1;
            return;
        }
        if stream == "stdout" && pipeline.pending_empty_stdout > 0 {
            flush_empty_stdout(pipeline.pending_empty_stdout, stdout, output);
            pipeline.pending_empty_stdout = 0;
        }
    }
    output(stream, &line);
    let target = if stream == "stdout" { stdout } else { stderr };
    target.push_str(&line);
    target.push('\n');
}

fn is_truncated_search_pipeline(
    command: &str,
    exit_code: i32,
    statuses: &[i32],
    stdout: &str,
) -> bool {
    if exit_code != 141 || statuses != [141, 0] || stdout.trim().is_empty() {
        return false;
    }
    let mut stages = command.split('|');
    let (Some(producer), Some(consumer), None) = (stages.next(), stages.next(), stages.next())
    else {
        return false;
    };
    fn executable(stage: &str) -> &str {
        stage
            .split_whitespace()
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("")
    }
    matches!(executable(producer), "grep" | "egrep" | "fgrep" | "rg")
        && executable(consumer) == "head"
        && !producer.trim_end().ends_with('&')
        && !consumer.trim_start().starts_with('&')
}

/// Runs each shell turn in a dedicated session and process group created by
/// `process::group`, so cancellation can terminate npm/vite/test descendants
/// without being able to address anything outside that group.
pub fn run_streaming(
    command: &str,
    cwd: &str,
    timeout_ms: u64,
    cancelled: impl Fn() -> bool,
    started_event: impl FnMut(u32, u32, u32, u128),
    output: impl FnMut(&str, &str),
) -> serde_json::Value {
    if super::isolation::process_management(command) {
        return super::isolation::refusal("Shell process/lifecycle management is ambiguous. Use run_terminal task_action=start/status/stop with an owned task_id instead.");
    }
    run_streaming_authorized(command, cwd, timeout_ms, true, cancelled, started_event, output)
}

pub fn run_streaming_authorized(
    command: &str,
    cwd: &str,
    timeout_ms: u64,
    authorized: bool,
    cancelled: impl Fn() -> bool,
    mut started_event: impl FnMut(u32, u32, u32, u128),
    mut output: impl FnMut(&str, &str),
) -> serde_json::Value {
    if command.trim().is_empty() {
        return serde_json::json!({"code":"INVALID_TOOL_ARGUMENTS","status":"error","retrySameArguments":false,
            "error":"A foreground command must be non-empty. An empty command cannot poll a previous foreground process. Stop ends that process. Use task_action=status with a registered handle from this generation, or start a fresh explicit command."});
    }
    if super::isolation::process_management(command) {
        return super::isolation::refusal("Use structured owned-task start/status/stop; arbitrary process management cannot target application infrastructure.");
    }
    let marker = format!(
        "__LOCAL_AI_PIPE_STATUS_{}_{}__",
        std::process::id(),
        now_ms()
    );
    // Capture PIPESTATUS before any other shell command can overwrite it. The
    // wrapper exits with the user's original pipeline status, so diagnostics
    // and shell failure semantics remain intact.
    let wrapped_command = format!(
        "{command}\n__local_ai_runner_exit=$? __local_ai_runner_pipeline=(\"${{PIPESTATUS[@]}}\"); printf '\\n{marker}%s|%s\\n' \"$__local_ai_runner_exit\" \"${{__local_ai_runner_pipeline[*]}}\"; exit \"$__local_ai_runner_exit\""
    );
    let mut shell = match super::isolation::sandbox_with_permissions(&wrapped_command, cwd, authorized) {
        Ok(shell) => shell,
        Err(error) => return super::isolation::setup_refusal(&error.to_string()),
    };
    // Preserve the actual failure status for common diagnostic pipelines
    // such as `npm test | tail`; otherwise the model sees a false success.
    // Agent foreground tools are noninteractive. Never expose the runtime RPC
    // stdin to shell commands or descendants (they could consume controls).
    shell
        .stdin(Stdio::null())
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (mut child, group) = match spawn_owned(shell) {
        Ok(owned) => owned,
        Err(error) => {
            return super::isolation::setup_refusal(&format!("Isolated terminal startup failed: {error}"))
        }
    };
    let pid = child.id();
    // `spawn_owned` made bash leader of its own session and process group. The
    // runner only ever signals that group, through `group`, on cancellation.
    let started_at = now_ms();
    started_event(pid, pid, pid, started_at);
    let stdout_handle = child.stdout.take().expect("piped stdout");
    let stderr_handle = child.stderr.take().expect("piped stderr");
    let (sender, receiver) = mpsc::channel();
    let stderr_sender = sender.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout_handle).lines().map_while(Result::ok) {
            let _ = sender.send(("stdout", line));
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr_handle).lines().map_while(Result::ok) {
            let _ = stderr_sender.send(("stderr", line));
        }
    });
    let started = std::time::Instant::now();
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut timed_out = false;
    let mut was_cancelled = false;
    let mut terminated = false;
    let mut pipeline = CapturedPipeline::default();
    loop {
        while let Ok((stream, line)) = receiver.try_recv() {
            capture_line(
                stream,
                line,
                &marker,
                &mut stdout,
                &mut stderr,
                &mut pipeline,
                &mut output,
            );
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                while let Ok((stream, line)) = receiver.try_recv() {
                    capture_line(
                        stream,
                        line,
                        &marker,
                        &mut stdout,
                        &mut stderr,
                        &mut pipeline,
                        &mut output,
                    );
                }
                if pipeline.exit_code.is_none() && pipeline.pending_empty_stdout > 0 {
                    flush_empty_stdout(pipeline.pending_empty_stdout, &mut stdout, &mut output);
                    pipeline.pending_empty_stdout = 0;
                }
                let cancelled_status = was_cancelled;
                let exit_code = status.code();
                let pipeline_captured = pipeline.exit_code == exit_code;
                let partial_success = !cancelled_status
                    && !timed_out
                    && pipeline_captured
                    && exit_code.is_some_and(|code| {
                        is_truncated_search_pipeline(command, code, &pipeline.statuses, &stdout)
                    });
                let mut result = serde_json::json!({
                    "command":command,
                    "cwd":cwd,
                    "pid":pid,
                    "pgid":pid,
                    "session_id":pid,
                    "started_at":started_at,
                    "finished_at":now_ms(),
                    "stdout":stdout,
                    "stderr":stderr,
                    "exit_code":exit_code,
                    "timed_out":timed_out,
                    "cancelled":cancelled_status,
                    "status":if cancelled_status {"cancelled"} else if timed_out {"timed_out"} else if partial_success {"partial_success"} else if status.success() {"completed"} else {"error"}
                });
                if pipeline_captured {
                    result["pipeline_statuses"] = serde_json::json!(pipeline.statuses);
                }
                if !pipeline_captured {
                    if let Some(diagnostic)=result["stderr"].as_str().and_then(super::isolation::startup_failure) {
                        result.as_object_mut().unwrap().extend(diagnostic.as_object().unwrap().clone());
                    }
                }
                return result;
            }
            Ok(None) => {}
            Err(error) => {
                return serde_json::json!({"command":command,"cwd":cwd,"pid":pid,"pgid":pid,"session_id":pid,"started_at":started_at,"finished_at":now_ms(),"stdout":stdout,"stderr":stderr,"error":error.to_string(),"timed_out":timed_out,"cancelled":was_cancelled,"status":"error"})
            }
        }
        if !terminated && (cancelled() || started.elapsed().as_millis() as u64 > timeout_ms) {
            was_cancelled = cancelled();
            timed_out = !was_cancelled;
            terminated = true;
            // Terminate the owned group first; escalate only while its leader
            // is still running. Never signal by a number we did not create.
            let _ = group.signal(&mut child, Signal::Term);
            std::thread::sleep(Duration::from_millis(120));
            if matches!(child.try_wait(), Ok(None)) {
                let _ = group.signal(&mut child, Signal::Kill);
                let _ = child.kill();
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |value| value.as_millis())
}

#[cfg(test)]
mod tests {
    #[test]
    fn empty_foreground_commands_cannot_poll_or_produce_successful_execution() {
        for authorized in [false,true] {
            let value=super::run_streaming_authorized(" \n", "/nonexistent-empty-command-fixture", 1000,authorized,||false,
                |_,_,_,_|panic!("empty command spawned a process"),|_,_|panic!("empty command produced output"));
            assert_eq!(value["code"],"INVALID_TOOL_ARGUMENTS");
            assert_eq!(value["status"],"error");
            assert_eq!(value["retrySameArguments"],false);
            assert!(value.get("pid").is_none() && value.get("exit_code").is_none());
        }
    }

    use super::*;
    use std::process::Command;

    #[test]
    fn emits_durable_process_identity_before_streamed_output() {
        let mut identity = None;
        let value = run_streaming(
            "printf 'first\\nsecond\\n'",
            ".",
            5_000,
            || false,
            |pid, pgid, session_id, started_at| {
                identity = Some((pid, pgid, session_id, started_at))
            },
            |_, _| {},
        );
        let identity = identity.expect("spawn event");
        assert!(identity.0 > 0);
        assert_eq!(identity.0, identity.1);
        assert_eq!(identity.1, identity.2);
        assert_eq!(value["pid"].as_u64(), Some(u64::from(identity.0)));
        assert_eq!(value["pgid"].as_u64(), Some(u64::from(identity.1)));
        assert_eq!(value["session_id"].as_u64(), Some(u64::from(identity.2)));
        assert_eq!(value["started_at"].as_u64(), Some(identity.3 as u64));
        assert!(value["finished_at"].as_u64().is_some());
        assert_eq!(value["stdout"].as_str(), Some("first\nsecond\n"));
    }

    #[test]
    fn truncated_search_preserves_output_and_reports_partial_success() {
        let value = run_streaming(
            "grep -n . src/agent/loop_runtime.rs | head -n 1",
            ".",
            5_000,
            || false,
            |_, _, _, _| {},
            |_, _| {},
        );
        assert_eq!(value["exit_code"], 141);
        assert_eq!(value["status"], "partial_success");
        assert_eq!(value["pipeline_statuses"], serde_json::json!([141, 0]));
        assert!(value["stdout"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty()));
    }

    #[test]
    fn ordinary_nonzero_search_and_other_sigpipe_remain_errors() {
        let no_match = run_streaming(
            "grep 'no-such-test-pattern' src/agent/loop_runtime.rs",
            ".",
            5_000,
            || false,
            |_, _, _, _| {},
            |_, _| {},
        );
        assert_eq!(no_match["exit_code"], 1);
        assert_eq!(no_match["status"], "error");
        assert_eq!(no_match["stdout"], "");

        let unrelated_sigpipe = run_streaming(
            "seq 1000000 | head -n 1",
            ".",
            5_000,
            || false,
            |_, _, _, _| {},
            |_, _| {},
        );
        assert_eq!(unrelated_sigpipe["exit_code"], 141);
        assert_eq!(unrelated_sigpipe["status"], "error");
        assert_eq!(unrelated_sigpipe["stdout"], "1\n");
    }

    #[test]
    fn nonzero_command_keeps_useful_stdout_and_is_not_partial_success() {
        let value = run_streaming(
            "printf 'useful diagnostic\\n'; exit 7",
            ".",
            5_000,
            || false,
            |_, _, _, _| {},
            |_, _| {},
        );
        assert_eq!(value["exit_code"], 7);
        assert_eq!(value["status"], "error");
        assert_eq!(value["stdout"], "useful diagnostic\n");
    }

    fn process_gone(pid: i32) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat
                .rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z')),
        }
    }

    fn wait_process_gone(pid: i32) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if process_gone(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        process_gone(pid)
    }

    /// Disposable bystander in this test's own process group.
    fn bystander() -> std::process::Child {
        Command::new("sleep")
            .arg("20.31")
            .stdout(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn cancelling_terminates_the_command_group_and_nothing_else() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let mut sibling = bystander();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let started = std::time::Instant::now();
        let value = run_streaming(
            "sleep 20.32 & echo $!; wait",
            ".",
            60_000,
            move || flag.load(Ordering::Relaxed),
            |_, _, _, _| {},
            move |_, line| {
                if line.trim().parse::<i32>().is_ok() {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "cancel was not prompt"
        );
        assert_eq!(value["status"], "cancelled");
        assert_eq!(value["cancelled"], true);
        let pgid = value["pgid"].as_i64().unwrap();
        assert_eq!(value["pid"].as_i64(), Some(pgid));
        assert!(pgid > 1);
        assert!(
            sibling.try_wait().unwrap().is_none(),
            "an unrelated process was signalled"
        );
        let _ = sibling.kill();
        let _ = sibling.wait();
    }

    #[test]
    fn the_descendants_of_a_cancelled_command_do_not_survive() {
        use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
        use std::sync::Arc;
        let cancel = Arc::new(AtomicBool::new(false));
        let descendant = Arc::new(AtomicI32::new(0));
        let leader = Arc::new(AtomicI32::new(0));
        let (flag, seen, started, root) = (cancel.clone(), descendant.clone(), leader.clone(), leader.clone());
        let value = run_streaming(
            "sleep 20.33 & echo $!; wait",
            ".",
            60_000,
            move || flag.load(Ordering::Relaxed),
            move |pid, _, _, _| { started.store(pid as i32, Ordering::Relaxed); },
            move |_, line| {
                if let Ok(pid) = line.trim().parse::<i32>() {
                    // $! is a namespace PID, never an identity in the host /proc.
                    // Resolve it only among descendants of this freshly owned leader.
                    let processes = std::fs::read_dir("/proc").unwrap().flatten().filter_map(|entry| {
                        let host_pid = entry.file_name().to_str()?.parse::<i32>().ok()?;
                        let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
                        let parent = stat.rsplit_once(") ")?.1.split_whitespace().nth(1)?.parse::<i32>().ok()?;
                        Some((host_pid, parent))
                    }).collect::<Vec<_>>();
                    let mut owned = vec![root.load(Ordering::Relaxed)];
                    loop {
                        let before = owned.len();
                        for &(child, parent) in &processes {
                            if owned.contains(&parent) && !owned.contains(&child) { owned.push(child); }
                        }
                        if owned.len() == before { break; }
                    }
                    let host_pid = owned.into_iter().find(|candidate| {
                        std::fs::read_to_string(format!("/proc/{candidate}/status")).ok()
                            .and_then(|status| status.lines().find(|line| line.starts_with("NSpid:"))
                                .and_then(|line| line.split_whitespace().last()?.parse::<i32>().ok())) == Some(pid)
                    }).expect("namespace child must resolve inside the owned ancestry");
                    seen.store(host_pid, Ordering::Relaxed);
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        );
        assert_eq!(value["status"], "cancelled");
        let pid = descendant.load(Ordering::Relaxed);
        assert!(pid > 1, "descendant pid was not reported");
        assert!(
            wait_process_gone(pid),
            "the cancelled command's background process survived"
        );
    }

    #[test]
    fn a_timeout_terminates_only_the_command_group() {
        let mut sibling = bystander();
        let started = std::time::Instant::now();
        let value = run_streaming(
            "sleep 20.34",
            ".",
            300,
            || false,
            |_, _, _, _| {},
            |_, _| {},
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(value["status"], "timed_out");
        assert!(
            sibling.try_wait().unwrap().is_none(),
            "an unrelated process was signalled"
        );
        let _ = sibling.kill();
        let _ = sibling.wait();
    }

    #[test]
    fn two_concurrent_commands_cancel_independently() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let stop_first = Arc::new(AtomicBool::new(false));
        let stop_second = Arc::new(AtomicBool::new(false));
        let (flag_first, flag_second) = (stop_first.clone(), stop_second.clone());
        let second = std::thread::spawn(move || {
            run_streaming(
                "sleep 20.35",
                ".",
                60_000,
                move || flag_second.load(Ordering::Relaxed),
                |_, _, _, _| {},
                |_, _| {},
            )
        });
        let first = std::thread::spawn(move || {
            run_streaming(
                "sleep 20.36",
                ".",
                60_000,
                move || flag_first.load(Ordering::Relaxed),
                |_, _, _, _| {},
                |_, _| {},
            )
        });
        std::thread::sleep(Duration::from_millis(400));
        stop_first.store(true, Ordering::Relaxed);
        let first = first.join().unwrap();
        assert_eq!(first["status"], "cancelled");
        std::thread::sleep(Duration::from_millis(400));
        assert!(
            !second.is_finished(),
            "cancelling one command ended another"
        );
        stop_second.store(true, Ordering::Relaxed);
        assert_eq!(second.join().unwrap()["status"], "cancelled");
    }
}
