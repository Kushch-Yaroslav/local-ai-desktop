//! One trusted authorization engine. UI mode changes are protocol controls,
//! never tool arguments or model instructions.
use super::policy::{self, RunPolicy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyMode {
    #[default]
    Strict,
    #[serde(alias = "trusted", alias = "absolute_autopilot")]
    Autonomous,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Permissions {
    pub mode: AutonomyMode,
    pub trusted_roots: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Read,
    Allow,
    Ask,
    Deny(String),
}
impl Permissions {
    fn requires_confirmation(&self) -> Decision {
        if self.mode == AutonomyMode::Autonomous {
            Decision::Deny("MANDATORY_POLICY_BLOCKED: operation is outside the task filesystem scope or requires explicit authorization. Use a task-local command, or switch to Ask mode for a reviewable approval; Autopilot cannot expand sandbox access.".into())
        } else { Decision::Ask }
    }
    pub fn decide(&self, tool: &str, args: &Value, root: Option<&Path>) -> Decision {
        if tool == "run_terminal" {
            let command = args.get("command").and_then(Value::as_str).unwrap_or("");
            if let Some(action)=args.get("task_action").and_then(Value::as_str) {
                match action {
                    "list" if command.is_empty()&&args.get("task_id").is_none() => {
                        // This authorizes only a registry read scoped by the executor.
                        return Decision::Allow;
                    }
                    "status"|"stop" if command.is_empty()&&args.get("task_id").and_then(Value::as_str).is_some_and(|id|!id.is_empty()) => {
                        // The executor must prove same-run ownership; no PID adoption.
                        return Decision::Allow;
                    }
                    "start" if command.trim().is_empty() => return Decision::Deny("task_action=start requires a non-empty command".into()),
                    "list" if command.is_empty() => return Decision::Deny("task_action=list does not accept task_id".into()),
                    "status"|"stop" if command.is_empty() => return Decision::Deny(format!("task_action={action} requires task_id")),
                    "list"|"status"|"stop" => return Decision::Deny("task_action=list/status/stop do not accept a command".into()),
                    "start" if args.get("task_id").is_some() => return Decision::Deny("task_action=start does not accept task_id".into()),
                    _ => return Decision::Deny("task_action must be start, list, status or stop".into()),
                }
            } else if command.trim().is_empty() {
                return Decision::Deny("run_terminal requires a command or a valid managed task_action".into());
            }
            if crate::process::isolation::process_management(command) {
                return Decision::Deny("PROTECTED_RUNTIME_PROCESS: arbitrary process management is blocked; use owned managed task handles".into());
            }
            if catastrophic(command, root, 0)
                || root
                    .and_then(|root| package_command(command, root))
                    .is_some_and(|(_, body)| catastrophic(&body, root, 0))
            {
                return Decision::Deny("CATASTROPHIC_OPERATION: destructive system/disk operation is blocked in every autonomy mode".into());
            }
            if root.is_some_and(|root| policy::shell_stages(command).is_ok_and(|stages|
                stages.iter().any(|words| outside_operands(words, root)))) {
                return self.requires_confirmation();
            }
            if root.and_then(|root| package_command(command, root).map(|(_,body)|(root,body))).is_some_and(|(root,body)|
                policy::shell_stages(&body).is_ok_and(|stages|stages.iter().any(|words|outside_operands(words, root)))) {
                return self.requires_confirmation();
            }
            if !policy::requires_approval_in_root(RunPolicy::Auto, tool, args, root) {
                return Decision::Read;
            }
            let Some(root) = root.filter(|root| root.is_dir()) else {
                return self.requires_confirmation();
            };
            if self.mode != AutonomyMode::Strict && scoped_read_chain(command, root) {
                // The lower executor conservatively gates all general shell
                // lists. Propagate this scoped policy approval, as for an
                // inspected build script; Read would be rejected there again.
                return Decision::Allow;
            }
            if self.mode == AutonomyMode::Autonomous && routine_script(command, root, 0) {
                return Decision::Allow;
            }
            if self.mode == AutonomyMode::Autonomous {
                // Code execution is consented in the existing mandatory sandbox;
                // this does not create mounts or grant host filesystem access.
                // Keep recognized Git/system authorization requirements intact.
                if policy::shell_stages(command).is_ok_and(|stages| stages.iter().any(|words| {
                    let bin = words.first().map(|s|s.rsplit('/').next().unwrap_or(s));
                    matches!(bin, Some("sudo" | "su" | "apt" | "apt-get" | "mount" | "umount" | "unshare" | "nsenter"))
                        || bin == Some("git") && !autonomous_command(command, root)
                })) { return self.requires_confirmation(); }
                return Decision::Allow;
            }
            return self.requires_confirmation();
        }
        let file_tool = matches!(
            tool,
            "read_file"
                | "list_directory"
                | "create_file"
                | "write_file"
                | "replace_text"
                | "delete_file"
                | "apply_patch"
                | "download_file"
        );
        let modifying = matches!(
            tool,
            "create_file"
                | "write_file"
                | "replace_text"
                | "delete_file"
                | "apply_patch"
                | "download_file"
        );
        if file_tool {
            let Some(root) = root else {
                return Decision::Deny("No workspace is selected".into());
            };
            let paths = crate::tools::filesystem::mutation_paths(tool, args).unwrap_or_default();
            for path in paths {
                let absolute = root.join(&path);
                if modifying && system_target(&absolute.to_string_lossy(), Some(root)) {
                    return Decision::Deny("CATASTROPHIC_OPERATION: destructive replacement of a system root is blocked".into());
                }
                // Broad scope here checks the invariant metadata protection;
                // the operation scope is checked separately below.
                let broad = crate::tools::filesystem::Scope {
                    root: Path::new("/"),
                    grants: &[],
                };
                if let Err(error) =
                    crate::tools::filesystem::scoped(&broad, &absolute.to_string_lossy())
                {
                    return Decision::Deny(error);
                }
                if crate::tools::filesystem::scoped(
                        &crate::tools::filesystem::Scope { root, grants: &[] },
                        &path,
                    )
                    .is_err()
                {
                    return self.requires_confirmation();
                }
            }
        }
        if !modifying {
            return Decision::Read;
        }
        if tool == "download_file"
            && args
                .get("max_bytes")
                .and_then(Value::as_u64)
                .is_some_and(|bytes| bytes > 256 * 1024 * 1024)
        {
            return self.requires_confirmation();
        }
        if root.is_none() || self.mode == AutonomyMode::Strict {
            return self.requires_confirmation();
        }
        Decision::Allow
    }
}
fn tokens(command: &str) -> Option<Vec<String>> {
    let stages = policy::shell_stages(command).ok()?;
    (stages.len() == 1).then(|| stages[0].clone())
}
/// Narrow read-only `cd && ls && cat` lists. This runtime check is independent
/// of UI descriptions. Every concrete operand must exist in the selected root;
/// shell expansions, pipelines, redirects and recursive/follow options ask.
fn scoped_read_chain(command: &str, root: &Path) -> bool { scoped_command_chain(command, root, false) }
fn scoped_command_chain(command: &str, root: &Path, allow_execution: bool) -> bool {
    // shell_stages intentionally understands a subset. A continued newline or
    // a double-quoted non-shell escape must not validate a different operand.
    if command.contains(['\n', '\r']) { return false; }
    let Ok(root) = std::fs::canonicalize(root) else { return false; };
    let mut cwd = root.clone();
    let mut parts = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut start = 0;
    let chars = command.char_indices().collect::<Vec<_>>();
    let mut i = 0;
    while i < chars.len() {
        let (byte, ch) = chars[i];
        if escaped {
            if quote == Some('"') && !matches!(ch, '$' | '`' | '"' | '\\') { return false; }
            escaped = false; i += 1; continue;
        }
        if ch == '\\' && quote != Some('\'') { escaped = true; i += 1; continue; }
        if let Some(active) = quote {
            if ch == active { quote = None; }
        } else if ch == '\'' || ch == '"' { quote = Some(ch); }
        else if ch == '&' && chars.get(i + 1).is_some_and(|(_, next)| *next == '&') {
            parts.push(&command[start..byte]);
            start = chars[i + 1].0 + 1; i += 1;
        }
        i += 1;
    }
    if quote.is_some() || escaped { return false; }
    parts.push(&command[start..]);
    if parts.len() > 32 { return false; }
    let mut observed = false;
    for part in parts {
        let Ok(stages) = policy::shell_stages(part) else { return false; };
        if stages.len() != 1 { return false; }
        let words = &stages[0];
        let Some(program) = words.first() else { return false; };
        let bin = program.rsplit('/').next().unwrap_or(program);
        if allow_execution && !matches!(bin, "cd" | "ls" | "cat") {
            if !autonomous_command(part, &cwd) { return false; }
            observed = true; continue;
        }
        if !matches!(bin, "cd" | "ls" | "cat") || !(program == bin || program == &format!("/usr/bin/{bin}") || program == &format!("/bin/{bin}")) { return false; }
        if bin == "cd" && (program != "cd" || words.len() != 2 || words[1].starts_with('-')) { return false; }
        if bin == "cd" && !Path::new(&words[1]).is_absolute() && !matches!(words[1].as_str(), "." | "..") && !words[1].starts_with("./") && !words[1].starts_with("../") {
            // Bare relative `cd name` can resolve against the shell's CDPATH.
            return false;
        }
        let mut paths = Vec::new();
        let mut literal = false;
        for arg in &words[1..] {
            if !literal && arg == "--" { literal = true; continue; }
            if !literal && arg.starts_with('-') {
                let allowed = if bin == "ls" { "alhdtFipn" } else { "nbsvETA" };
                if arg.len() < 2 || arg.starts_with("--") || !arg[1..].chars().all(|ch| allowed.contains(ch)) { return false; }
                continue;
            }
            if arg == "-" || arg.contains(['*', '?', '[', ']', '~']) { return false; }
            let absolute = cwd.join(arg);
            // Shell `cd ..` uses a logical PWD. Do not infer its future scope
            // through a symlink using a different, canonical PWD.
            if bin == "cd" && absolute.ancestors().any(|part| std::fs::symlink_metadata(part).is_ok_and(|meta| meta.file_type().is_symlink())) { return false; }
            let Ok(path) = std::fs::canonicalize(absolute) else { return false; };
            if !path.starts_with(&root) { return false; }
            if bin == "cat" && !path.is_file() { return false; }
            paths.push(path);
        }
        if bin == "cd" {
            if paths.len() != 1 || !paths[0].is_dir() { return false; }
            cwd = paths.remove(0);
        } else {
            if bin == "cat" && paths.is_empty() { return false; }
            observed = true;
        }
    }
    observed
}

fn package_command(command: &str, root: &Path) -> Option<(String, String)> {
    let words = tokens(command)?;
    let bin = words.first()?;
    if !matches!(bin.as_str(), "npm" | "pnpm" | "yarn") {
        return None;
    }
    if words
        .iter()
        .any(|w| w.starts_with('-') || w.contains('/') && !w.starts_with("--"))
    {
        return None;
    }
    let action = words.get(1)?;
    if words.len() != if action == "run" { 3 } else { 2 } {
        return None;
    }
    let script = if action == "run" {
        words.get(2)?
    } else {
        action
    };
    let package: Value =
        serde_json::from_slice(&std::fs::read(root.join("package.json")).ok()?).ok()?;
    let scripts = package.get("scripts")?;
    let body = scripts.get(script)?.as_str()?;
    // Lifecycle hooks are part of the execution being authorized.
    let hooks = [format!("pre{script}"), format!("post{script}")];
    let mut joined = body.to_owned();
    for hook in hooks {
        if let Some(text) = scripts.get(&hook).and_then(Value::as_str) {
            joined.push_str(" && ");
            joined.push_str(text);
        }
    }
    Some((script.clone(), joined))
}
fn outside_argument(arg: &str, root: &Path) -> bool {
    let value = arg.split_once('=').map_or(arg, |(_, value)| value);
    if value.starts_with('~')
        || arg.starts_with("--prefix")
        || arg.starts_with("--cwd")
        || arg.starts_with("--directory")
    {
        return true;
    }
    (value.starts_with('/') || value.contains('/') || value == "..")
        && crate::tools::filesystem::scoped(
            &crate::tools::filesystem::Scope { root, grants: &[] },
            value,
        )
        .is_err()
}
fn routine_script(command: &str, root: &Path, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    let Some((script, body)) = package_command(command, root) else {
        return false;
    };
    if !matches!(
        script.as_str(),
        "build" | "test" | "lint" | "typecheck" | "check"
    ) {
        return false;
    }
    body.split("&&").all(|part| {
        let Some(words) = tokens(part.trim()) else {
            return false;
        };
        let Some(bin) = words.first() else {
            return false;
        };
        if words.iter().any(|arg| outside_argument(arg, root)) {
            return false;
        }
        match bin.as_str() {
            "tsc" | "vue-tsc" | "eslint" | "vitest" => true,
            "vite" => words.get(1).is_some_and(|arg| arg == "build"),
            "npm" | "pnpm" | "yarn" => routine_script(part.trim(), root, depth + 1),
            _ => false,
        }
    })
}
fn outside_operands(words: &[String], root: &Path) -> bool {
    let interpreter = words.first().is_some_and(|bin|matches!(bin.rsplit('/').next().unwrap_or(bin), "python" | "python3" | "node"));
    words.iter().enumerate().skip(1).any(|(i,arg)| {
        // Inline source is executable code, not a filesystem operand. Its
        // effects are constrained by the mandatory sandbox, not source regexes.
        if interpreter && i > 1 && matches!(words[i-1].as_str(), "-c" | "-e" | "--eval") { return false; }
        outside_argument(arg, root)
    })
}
fn autonomous_command(command: &str, root: &Path) -> bool {
    if routine_script(command, root, 0) {
        return true;
    }
    let Some(words) = tokens(command) else {
        return false;
    };
    if words.iter().any(|arg| outside_argument(arg, root)) {
        return false;
    }
    if matches!(
        words.first().map(String::as_str),
        Some("npm" | "pnpm" | "yarn")
    ) {
        // Install executes dependency lifecycle code: explicit Autonomous
        // workspace authorization is the consent, not an intrinsic-safe claim.
        return matches!(
            words.get(1).map(String::as_str),
            Some("install" | "ci" | "add")
        ) || package_command(command, root).is_some_and(|(_, body)| {
            !catastrophic(&body, Some(root), 0)
                && !body.contains("git ")
                && !body.contains("../")
                && policy::shell_stages(&body).is_ok_and(|stages| {
                    !stages.iter().flatten().any(|arg| outside_argument(arg, root))
                })
        });
    }
    if words.first().is_some_and(|bin| bin == "git") {
        return matches!(
            words.get(1).map(String::as_str),
            Some("add" | "commit" | "switch" | "checkout" | "branch" | "fetch" | "clone")
        ) && !words.iter().any(|arg| {
            arg == "-D" || arg == "--delete" || arg == "--force" || arg == "-f" || arg == "--detach" || arg == "--amend" || arg == "--discard-changes" || arg == "-B" || arg == "-C"
        });
    }
    if matches!(
        words.first().map(String::as_str),
        Some("node" | "python" | "python3" | "cargo" | "go" | "make" | "cmake" | "pytest")
    ) {
        // These are executable project tools: explicit Autonomous workspace
        // trust, rather than a claim that their code is intrinsically safe.
        return !words.iter().skip(1).any(|word| {
            word.starts_with("--directory")
        });
    }
    if words.first().is_some_and(|bin| bin == "rm") {
        return words
            .iter()
            .skip(1)
            .filter(|arg| !arg.starts_with('-'))
            .all(|arg| {
                crate::tools::filesystem::scoped(
                    &crate::tools::filesystem::Scope { root, grants: &[] },
                    arg,
                )
                .is_ok()
            });
    }
    false
}
fn system_target(value: &str, root: Option<&Path>) -> bool {
    let path = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        root.unwrap_or(Path::new("/")).join(value)
    };
    let mut normalized = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            _ => normalized.push(c.as_os_str()),
        }
    }
    let resolved = normalized.canonicalize().unwrap_or(normalized);
    if std::env::var("HOME")
        .ok()
        .is_some_and(|home| resolved == Path::new(&home))
    {
        return true;
    }
    [
        "/",
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/boot",
        "/dev",
        "/proc",
        "/sys",
        "/var",
        "/home",
        "/root",
        "/media",
        "/mnt",
        "/usr/bin",
        "/usr/lib",
        "/usr/lib64",
        "/usr/sbin",
        "/usr/share",
        "/var/lib",
    ]
    .iter()
    .any(|p| resolved == Path::new(p))
}
fn destructive_target(value: &str, root: Option<&Path>) -> bool {
    if system_target(value, root) {
        return true;
    }
    if let Some(index) = value.find(['*', '?', '[', '{']) {
        let prefix = value[..index].trim_end_matches('/');
        let prefix = if prefix.is_empty() && value.starts_with('/') {
            "/"
        } else {
            prefix
        };
        return system_target(prefix, root);
    }
    false
}
fn destructive_stages(command: &str) -> Vec<Vec<String>> {
    let mut stages = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    for ch in command.chars() {
        if escaped {
            word.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                word.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            ';' | '&' | '|' | '\n' => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
                if !words.is_empty() {
                    stages.push(std::mem::take(&mut words));
                }
            }
            ch if ch.is_whitespace() => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(ch),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    if !words.is_empty() {
        stages.push(words);
    }
    stages
}
pub fn catastrophic(command: &str, root: Option<&Path>, depth: usize) -> bool {
    if depth > 8 {
        return true;
    }
    // Lists are examined independently. This is a conservative guard for
    // recognizable catastrophe, not a sandbox or arbitrary-code verifier.
    let mut variables = std::collections::BTreeMap::<String, String>::new();
    for mut words in destructive_stages(command) {
        for word in &words {
            if let Some((key, value)) = word.split_once('=') {
                if !key.is_empty()
                    && key
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
                {
                    variables.insert(key.into(), value.into());
                }
            }
        }
        if words.len() == 1 {
            if let Some((key, value)) = words[0].split_once('=') {
                variables.insert(key.into(), value.into());
                continue;
            }
        }
        for word in &mut words {
            for (key, value) in &variables {
                *word = word
                    .replace(&format!("${{{key}}}"), value)
                    .replace(&format!("${key}"), value);
            }
        }
        let Some(program) = words.first() else {
            continue;
        };
        let program = program.rsplit('/').next().unwrap_or(program);
        let read_only = words
            .iter()
            .skip(1)
            .any(|arg| matches!(arg.as_str(), "--help" | "--version"))
            || program == "fdisk"
                && words
                    .iter()
                    .any(|arg| matches!(arg.as_str(), "-l" | "--list"))
            || program == "sfdisk"
                && words
                    .iter()
                    .any(|arg| matches!(arg.as_str(), "-d" | "--dump" | "-l" | "--list"))
            || program == "wipefs"
                && words
                    .iter()
                    .any(|arg| matches!(arg.as_str(), "-n" | "--no-act"));
        if !read_only
            && (program.starts_with("mkfs")
                || matches!(
                    program,
                    "wipefs" | "blkdiscard" | "mkswap" | "fdisk" | "sfdisk"
                ))
        {
            return true;
        }
        if program == "dd" && words.iter().any(|arg| arg.starts_with("of=/dev/")) {
            return true;
        }
        if program == "rm"
            && words.iter().any(|arg| {
                arg == "--recursive"
                    || arg.starts_with('-')
                        && !arg.starts_with("--")
                        && (arg.contains('r') || arg.contains('R'))
            })
            && words
                .iter()
                .skip(1)
                .any(|arg| !arg.starts_with('-') && destructive_target(arg, root))
        {
            return true;
        }
        if program == "find"
            && words.iter().any(|arg| arg == "-delete")
            && words
                .iter()
                .skip(1)
                .any(|arg| !arg.starts_with('-') && destructive_target(arg, root))
        {
            return true;
        }
        if matches!(program, "bash" | "sh" | "zsh" | "dash") {
            if !words.iter().any(|w| w.starts_with('-') && w.contains('c')) {
                if let Some(script) = words.iter().skip(1).find(|w| !w.starts_with('-')) {
                    let path = root.unwrap_or(Path::new("/")).join(script);
                    if std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= 256 * 1024)
                        && std::fs::read_to_string(path)
                            .is_ok_and(|body| catastrophic(&body, root, depth + 1))
                    {
                        return true;
                    }
                }
            }
            if let Some(i) = words
                .iter()
                .position(|w| w.starts_with('-') && w.contains('c'))
            {
                if let Some(inner) = words.get(i + 1) {
                    if catastrophic(inner, root, depth + 1) {
                        return true;
                    }
                }
            }
        }
        if matches!(
            program,
            "sudo" | "doas" | "env" | "command" | "exec" | "xargs"
        ) {
            let start = words
                .iter()
                .skip(1)
                .position(|w| !w.starts_with('-') && !w.contains('='));
            if let Some(start) = start {
                if catastrophic(
                    &words[start + 1..]
                        .iter()
                        .map(|w| format!("\"{}\"", w.replace('"', "\\\"")))
                        .collect::<Vec<_>>()
                        .join(" "),
                    root,
                    depth + 1,
                ) {
                    return true;
                }
            }
        }
        if matches!(program, "python" | "python3" | "node") {
            let code = words.last().map(String::as_str).unwrap_or("");
            if code.contains("rmtree")
                || code.contains("rmSync")
                || code.contains("rmdirSync")
                || code.contains("fs.promises.rm")
                || code.contains("fs.rm(")
            {
                let mut literals = code.split(['\'', '"']).skip(1).step_by(2);
                if literals.any(|value| system_target(value, root)) {
                    return true;
                }
            }
            if code.contains("system(") || code.contains("execSync(") {
                for literal in code.split(['\'', '"']).skip(1).step_by(2) {
                    if catastrophic(literal, root, depth + 1) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn historical_unscoped_listener_cleanup_is_blocked_even_in_autopilot() {
        let root = std::env::temp_dir();
        for mode in [AutonomyMode::Strict, AutonomyMode::Autonomous] {
            let permissions = Permissions { mode, trusted_roots: vec![root.to_string_lossy().into()] };
            for command in [
                "for p in $(ss -ltnp 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do kill \"$p\" 2>/dev/null; done; sleep 2; ss -ltn | grep -E ':(3000|8888)\\b'",
                "kill $(pgrep -f \"server.mjs|vite\")",
                "pkill -f \"[v]ite\"",
            ] {
                assert!(matches!(permissions.decide("run_terminal", &json!({"command":command}), Some(&root)), Decision::Deny(_)), "{mode:?}: {command}");
            }
        }
    }

    #[test]
    fn empty_command_is_allowed_only_for_opaque_managed_task_lifecycle_actions() {
        let root=std::env::temp_dir();
        let permissions=Permissions{mode:AutonomyMode::Autonomous,trusted_roots:vec![]};
        for action in ["list","status","stop"] {
            let arguments=if action=="list"{json!({"task_action":action})}else{json!({"task_action":action,"task_id":"managed-1"})};
            assert_eq!(permissions.decide("run_terminal",&arguments,Some(&root)),Decision::Allow, "{action}");
        }
        assert_ne!(permissions.decide("run_terminal",&json!({"task_action":"start"}),Some(&root)),Decision::Allow);
        assert_ne!(permissions.decide("run_terminal",&json!({"task_id":"managed-1"}),Some(&root)),Decision::Allow);
    }

    #[test]
    fn catastrophic_guard_covers_wrappers_and_equivalent_literal_scripts() {
        for cmd in [
            "rm -rf /",
            "rm -r /usr",
            "rm -rf /usr/*",
            "ROOT=/; rm -Rf \"$ROOT\"",
            "env bash -c 'rm -rf /'",
            "printf ignored | xargs rm -rf /",
            "sudo rm -rf /",
            "bash -c 'rm -rf /'",
            "python3 -c 'import shutil; shutil.rmtree(\"/\")'",
            "node -e 'fs.rmSync(\"/etc\",{recursive:true})'",
            "mkfs.ext4 /dev/sda",
            "dd if=/dev/zero of=/dev/nvme0n1",
        ] {
            assert!(catastrophic(cmd, Some(Path::new("/tmp")), 0), "{cmd}");
        }
        assert!(!catastrophic(
            "rm -rf node_modules",
            Some(Path::new("/tmp/project")),
            0
        ));
        assert!(!catastrophic(
            "fdisk -l /dev/sda",
            Some(Path::new("/tmp")),
            0
        ));
        assert!(!catastrophic(
            "git reset --hard",
            Some(Path::new("/tmp/project")),
            0
        ));
    }
    #[test]
    fn trusted_read_chains_validate_each_operand_and_do_not_authorize_shell_syntax() {
        let root = std::env::temp_dir().join(format!("read-chain-policy-{}", std::process::id()));
        std::fs::create_dir_all(root.join("a space")).unwrap();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        std::fs::write(root.join("a space/a&&b"), "data").unwrap();
        let mut p = Permissions::default();
        let command = format!("cd '{}' && ls 'a space' && cat package.json", root.display());
        assert_eq!(p.decide("run_terminal", &json!({"command":command}), Some(&root)), Decision::Ask);
        p.trusted_roots.push(root.to_string_lossy().into());
        for mode in [AutonomyMode::Autonomous, AutonomyMode::Autonomous] {
            p.mode = mode;
            for command in [&command, "cd './a space' && cat 'a&&b'"] {
                assert_eq!(p.decide("run_terminal", &json!({"command":command}), Some(&root)), Decision::Allow, "{command}");
            }
            for command in ["cd / && ls", "ls && cat /etc/passwd", "cd . && cat ../outside", "ls && cat $(pwd)", "ls && cat package.json > output", "ls || cat package.json", "ls; cat package.json", "ls | cat package.json", "ls && unknown", "ls && cat", "ls -R && cat package.json", "ls && cat *", "./ls && cat package.json", "cd - && ls", "cd 'a space' && ls", "ls && cat <(echo x)", "ls && cat a\\
b", r#"ls && cat "a\q""#] {
                assert!(!scoped_read_chain(command, &root), "{command}");
            }
        }
        #[cfg(unix)] {
            std::os::unix::fs::symlink("/etc", root.join("escape")).unwrap();
            std::os::unix::fs::symlink(root.join("a space"), root.join("logical")).unwrap();
            for command in ["ls && cat escape/passwd", "cd logical && ls"] {
                assert!(!scoped_read_chain(command, &root));
            }
        }
        p.mode = AutonomyMode::Strict;
        assert_eq!(p.decide("run_terminal", &json!({"command":command}), Some(&root)), Decision::Ask);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn autopilot_uses_task_scope_without_trust_or_ui_project() {
        let root=std::env::temp_dir().join(format!("two-mode-policy-{}",std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for mode in ["trusted", "absolute_autopilot"] {
            assert_eq!(serde_json::from_value::<AutonomyMode>(json!(mode)).unwrap(), AutonomyMode::Autonomous);
        }
        let mut p=Permissions { mode: AutonomyMode::Autonomous, trusted_roots: vec![] };
        for command in ["python3 test_calculator.py -v", "python3 -c 'print(1 + 1)'", "cd . && python3 test_calculator.py -v", "python3 - <<'PY'\nprint(1)\nPY"] {
            assert_eq!(p.decide("run_terminal", &json!({"command":command}),Some(&root)), Decision::Allow);
            p.mode=AutonomyMode::Strict;
            assert_eq!(p.decide("run_terminal", &json!({"command":command}),Some(&root)), Decision::Ask);
            p.mode=AutonomyMode::Autonomous;
        }
        assert!(matches!(p.decide("run_terminal", &json!({"command":"python3 task.py"}),None),Decision::Deny(_)), "no host-root fallback");
        for command in ["python3 /etc/untrusted.py", "git reset --hard", "git push --force", "sudo apt install x"] {
            assert!(matches!(p.decide("run_terminal", &json!({"command":command}),Some(&root)),Decision::Deny(_)),"{command}");
        }
        assert_eq!(p.decide("write_file",&json!({"path":"a.txt"}),Some(&root)),Decision::Allow);
        assert!(matches!(p.decide("write_file",&json!({"path":"/etc/lad-test"}),Some(&root)),Decision::Deny(_)));
        assert!(matches!(p.decide("write_file",&json!({"path":".git/HEAD"}),Some(&root)),Decision::Deny(_)));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn package_scripts_keep_external_output_and_catastrophic_guards() {
        let root=std::env::temp_dir().join(format!("autonomy-policy-{}",std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let p=Permissions{mode:AutonomyMode::Autonomous,trusted_roots:vec![]};
        std::fs::write(root.join("package.json"),r#"{"scripts":{"build":"vite build --outDir=/etc"}}"#).unwrap();
        assert!(matches!(p.decide("run_terminal",&json!({"command":"npm run build"}),Some(&root)),Decision::Deny(_)));
        std::fs::write(root.join("package.json"),r#"{"scripts":{"build":"vite build","prebuild":"node task-local.js"}}"#).unwrap();
        assert_eq!(p.decide("run_terminal",&json!({"command":"npm run build"}),Some(&root)),Decision::Allow);
        assert!(matches!(p.decide("run_terminal",&json!({"command":"sudo rm -rf /"}),Some(&root)),Decision::Deny(_)));
        std::fs::remove_dir_all(root).unwrap();
    }
}
