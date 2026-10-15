use local_ai_agent_runtime::{agent::policy::{requires_approval_in_root, RunPolicy}, tools::{filesystem::{self, Scope}, shell}};
use serde_json::json;
use std::{fs, path::PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Workspace(PathBuf);
impl Workspace { fn new() -> Self { let path = std::env::temp_dir().join(format!("local-ai-security-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))); fs::create_dir_all(path.join(".git/refs/heads")).unwrap(); Self(path) } }
impl Drop for Workspace { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

#[test]
fn refused_git_cannot_switch_to_generic_file_tools_or_scripts() {
    let root = Workspace::new(); let scope = Scope { root: &root.0, grants: &[] };
    fs::write(root.0.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    for command in ["git branch backup", "git diff", "git show HEAD", "git log --patch", "git grep --open-files-in-pager=python3 secret", "systemctl start arbitrary", "dbus-send --system arbitrary", "python3 -c 'open(\".git/HEAD\",\"w\").write(\"bad\")'", "rm -rf .git", "npm run build", "sort -o.git/HEAD source.txt", "rg --pre=python3 secret", "cat /etc/passwd"] {
        assert!(requires_approval_in_root(RunPolicy::Auto, "run_terminal", &json!({"command":command}), Some(&root.0)), "{command}");
        assert!(shell::execute(&root.0, &json!({"command":command}), false, || false, |_,_,_,_| {}, |_,_| {}).is_err());
    }
    for name in ["create_file", "write_file", "delete_file"] {
        assert!(filesystem::execute_in(&scope, name, &json!({"path":".git/HEAD","content":"bad"})).unwrap_err().starts_with("PERMISSION_DENIED"));
    }
    for patch in ["*** Begin Patch\n*** Add File: .git/refs/heads/new\n+bad\n*** End Patch", "*** Begin Patch\n*** Delete File: .git/HEAD\n*** End Patch", "*** Begin Patch\n*** Update File: .git/HEAD\n@@\n-ref: refs/heads/main\n+bad\n*** End Patch"] {
        assert!(filesystem::execute_in(&scope, "apply_patch", &json!({"patch":patch})).is_err());
    }
    assert!(filesystem::replace_text_in(&scope, &json!({"path":".git/HEAD","old_text":"main","new_text":"bad"}), "unused").is_err());
    assert_eq!(fs::read_to_string(root.0.join(".git/HEAD")).unwrap(), "ref: refs/heads/main\n");
}

#[test]
fn approved_git_branch_is_still_executable() {
    let root = Workspace::new();
    let init = shell::execute(&root.0, &json!({"command":"git init -q && git -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm initial"}), true, || false, |_,_,_,_| {}, |_,_| {}).unwrap();
    assert_eq!(init["exit_code"], 0);
    let branch = shell::execute(&root.0, &json!({"command":"git switch -c authorized"}), true, || false, |_,_,_,_| {}, |_,_| {}).unwrap();
    assert_eq!(branch["exit_code"], 0);
    assert_eq!(fs::read_to_string(root.0.join(".git/HEAD")).unwrap(), "ref: refs/heads/authorized\n");
}

#[cfg(unix)]
#[test]
fn symlinks_worktree_pointers_and_traversal_are_not_metadata_escapes() {
    use std::os::unix::fs::symlink;
    let root = Workspace::new(); let outside = Workspace::new(); let scope = Scope { root: &root.0, grants: &[] };
    symlink(root.0.join(".git"), root.0.join("alias")).unwrap();
    symlink(outside.0.join("missing"), root.0.join("dangling")).unwrap();
    symlink(&outside.0, root.0.join("outside")).unwrap();
    fs::remove_dir_all(root.0.join(".git")).unwrap();
    fs::create_dir(root.0.join("metadata")).unwrap();
    fs::write(root.0.join(".git"), "gitdir: metadata\n").unwrap();
    for path in ["alias/HEAD", "dangling/file", "outside/file", "../outside/file", "metadata/HEAD", ".git", "safe/../metadata/HEAD"] {
        assert!(filesystem::execute_in(&scope, "write_file", &json!({"path":path,"content":"bad"})).is_err(), "{path}");
    }
    fs::create_dir_all(root.0.join("metadata/worktrees/linked")).unwrap();
    fs::write(root.0.join(".git"), "gitdir: metadata/worktrees/linked\n").unwrap();
    fs::write(root.0.join("metadata/worktrees/linked/commondir"), "../..\n").unwrap();
    assert!(filesystem::execute_in(&scope, "write_file", &json!({"path":"metadata/refs/heads/main","content":"bad"})).is_err());
    let bare = shell::execute(&root.0, &json!({"command":"git init --bare -q bare"}), true, || false, |_,_,_,_| {}, |_,_| {}).unwrap();
    assert_eq!(bare["exit_code"], 0);
    assert!(filesystem::execute_in(&scope, "write_file", &json!({"path":"bare/HEAD","content":"bad"})).is_err());
}

#[test]
fn large_resources_do_not_get_buffered_or_truncated_by_text_tools() {
    let root = Workspace::new(); let scope = Scope { root: &root.0, grants: &[] };
    let target = root.0.join("model.bin"); fs::File::create(&target).unwrap().set_len(9 * 1024 * 1024).unwrap();
    assert!(filesystem::file_revision(&scope, "model.bin").is_none());
    for tool in ["read_file", "write_file"] {
        assert!(filesystem::execute_in(&scope, tool, &json!({"path":"model.bin","content":"invalid replacement"})).unwrap_err().contains("limit"));
    }
    assert_eq!(fs::metadata(target).unwrap().len(), 9 * 1024 * 1024);
}

#[test]
fn atomic_writes_and_deletions_have_recoverable_preimages_and_patch_delete_needs_approval() {
    let root = Workspace::new(); let scope = Scope { root: &root.0, grants: &[] };
    fs::write(root.0.join("config"), "working").unwrap();
    let (written, _) = filesystem::execute_in(&scope, "write_file", &json!({"path":"config","content":"replacement"})).unwrap();
    let backup = PathBuf::from(written["backup"].as_str().unwrap());
    assert_eq!(fs::read_to_string(backup.join("original")).unwrap(), "working");
    assert!(filesystem::execute_in(&scope, "delete_file", &json!({"path":backup.join("original")})).is_err());
    let patch = json!({"patch":"*** Begin Patch\n*** Delete File: config\n*** End Patch"});
    assert!(requires_approval_in_root(RunPolicy::Auto, "apply_patch", &patch, Some(&root.0)));
    assert!(requires_approval_in_root(RunPolicy::Auto, "delete_file", &json!({"path":"config"}), Some(&root.0)));
    let (deleted, _) = filesystem::execute_in(&scope, "delete_file", &json!({"path":"config"})).unwrap();
    assert_eq!(fs::read_to_string(PathBuf::from(deleted["backup"].as_str().unwrap()).join("original")).unwrap(), "replacement");
    assert!(!root.0.join("config").exists());
}
