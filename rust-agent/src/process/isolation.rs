//! Mandatory kernel boundary for every agent terminal, including approved code.
//! Host PIDs cannot be addressed from a descendant PID namespace. No parsing of
//! arbitrary scripts is used to establish this property.
use std::{path::{Path, PathBuf}, process::Command, io};
use serde_json::{json, Value};
use std::os::unix::fs::MetadataExt;
use sha2::{Digest, Sha256};

const PRIVATE_BWRAP: &str = "/usr/lib/local-ai-desktop/bwrap";

fn trusted_file(path: &Path) -> io::Result<()> {
    let metadata=std::fs::symlink_metadata(path)?;
    if !trusted_identity(metadata.is_file(), metadata.uid(), metadata.mode()) {
        return Err(io::Error::other("sandbox helper must be a root-owned, non-setuid regular file, not writable by group/others"));
    }
    // File capabilities are an independent privilege mechanism from mode bits.
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    extern "C" { fn lgetxattr(path: *const i8, name: *const i8, value: *mut std::ffi::c_void, size: usize) -> isize; }
    let name=CString::new(path.as_os_str().as_bytes()).map_err(|_|io::Error::other("invalid helper path"))?;
    // SAFETY: both names are live NUL-terminated strings; a null buffer queries size.
    let capabilities=unsafe { lgetxattr(name.as_ptr(),c"security.capability".as_ptr(),std::ptr::null_mut(),0) };
    if capabilities>=0 { return Err(io::Error::other("file capabilities on sandbox helpers are forbidden")); }
    let error=io::Error::last_os_error();
    if !matches!(error.raw_os_error(),Some(61|95)) { return Err(error); }
    for parent in path.ancestors().skip(1) {
        let metadata=std::fs::symlink_metadata(parent)?;
        if !metadata.is_dir() || metadata.uid()!=0 || metadata.mode() & 0o022 != 0 {
            return Err(io::Error::other("sandbox helper ancestors must be root-owned directories, not writable by group/others"));
        }
    }
    Ok(())
}

fn trusted_identity(regular: bool, uid: u32, mode: u32) -> bool {
    regular && uid==0 && mode & 0o6022==0
}

fn file_hash(path: &Path) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let mut file=std::fs::File::open(path)?;
    if file.metadata()?.len()>16*1024*1024 { return Err(io::Error::other("unexpected sandbox helper size")); }
    let mut hash=Sha256::new(); let mut buffer=[0;8192];
    loop { let count=file.read(&mut buffer)?; if count==0 { break; } hash.update(&buffer[..count]); }
    Ok(hash.finalize().to_vec())
}

fn bwrap_path() -> io::Result<PathBuf> {
    let private=Path::new(PRIVATE_BWRAP);
    match std::fs::symlink_metadata(private) {
        Ok(_) => {
            trusted_file(private)?;
            trusted_file(Path::new("/usr/bin/bwrap"))?;
            let private_hash = file_hash(private).map_err(|error| {
                if error.kind() == io::ErrorKind::PermissionDenied {
                    io::Error::new(error.kind(), "Dedicated sandbox helper is disabled or this account is not authorized. Complete package configuration, ask an administrator to add the desktop account to local-ai-desktop, then log out and back in. No command ran.")
                } else { error }
            })?;
            if private_hash!=file_hash(Path::new("/usr/bin/bwrap"))? {
                return Err(io::Error::other("Local AI Desktop sandbox helper differs from the distro bwrap; administrator refresh is required after distro updates"));
            }
            Ok(private.to_path_buf())
        }
        Err(error) if error.kind()==io::ErrorKind::NotFound => Err(io::Error::new(error.kind(), "Mandatory dedicated sandbox helper /usr/lib/local-ai-desktop/bwrap is missing. Ask an administrator to configure/reinstall local-ai-desktop. Host-shell and system-bwrap fallback are forbidden.")),
        Err(error) => Err(error),
    }
}

pub const CODE: &str = "PROTECTED_RUNTIME_PROCESS";
pub fn refusal(reason: &str) -> Value {
    json!({"error":format!("Operation blocked: Local AI Desktop infrastructure is required for agent execution. {reason}"),"code":CODE,"retrySameArguments":false,"status":"error"})
}

pub fn setup_refusal(reason: &str) -> Value {
    let mut result = refusal(reason);
    result["setup_required"] = json!(true);
    result
}

/// Classify host setup failures separately from command failures. A denied map
/// means no shell payload ran; changing arguments/permissions cannot repair it.
pub fn startup_failure(stderr: &str) -> Option<Value> {
    if !stderr.contains("bwrap:") && !stderr.contains("PROTECTED_RUNTIME_PROCESS: sandbox startup failed") { return None; }
    let uid_map = stderr.contains("setting up uid map") || stderr.contains("setting up gid map");
    let read = |path| std::fs::read_to_string(path).unwrap_or_default().trim().to_owned();
    Some(json!({"code":CODE,"retrySameArguments":false,"setup_required":true,
        "error":if uid_map {
            "Mandatory sandbox could not create its UID/GID mapping. Ubuntu may require a reviewed private-helper, executable-scoped AppArmor policy; see docs/apparmor-security-review.md. No command ran and no policy is installed automatically. Do not disable AppArmor/isolation or retry through another autonomy mode."
        } else { "Mandatory runtime isolation could not start; no unprotected command was executed." },
        "sandbox_diagnostic":{"stage":if uid_map {"user_namespace_mapping"} else {"sandbox_setup"},
            "parent_apparmor":read("/proc/self/attr/current"),
            "apparmor_restrict_unprivileged_userns":read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
            "unprivileged_userns_clone":read("/proc/sys/kernel/unprivileged_userns_clone"),"stderr":stderr}}))
}

/// Diagnostic fail-closed gate for known process-management forms. The kernel
/// namespace remains the boundary for scripts, native code and obfuscation.
pub fn process_management(command: &str) -> bool {
    command.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-').any(|token|
        matches!(token, "kill" | "pkill" | "killall" | "fuser" | "killpg" | "pidfd_send_signal" | "systemctl" | "service" | "reboot" | "shutdown"))
}

pub fn protected_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::var("LOCAL_AI_PROTECTED_PATHS").ok()
        .and_then(|text| serde_json::from_str::<Vec<PathBuf>>(&text).ok()).unwrap_or_default();
    if let Ok(exe) = std::env::current_exe() { paths.push(exe); }
    if let Ok(registry) = std::env::var("LOCAL_AI_PROTECTED_REGISTRY") { paths.push(registry.into()); }
    paths.into_iter().filter_map(|p| p.canonicalize().ok()).collect()
}

pub fn protects_path(path: &Path) -> bool {
    protected_paths().iter().any(|root| path.starts_with(root))
}

pub fn sandbox(command: &str, cwd: &str) -> io::Result<Command> {
    sandbox_with_permissions(command,cwd,true)
}

fn bootstrap_executable(current: &Path) -> io::Result<PathBuf> {
    // Linux reports the retired inode with this suffix after a source rebuild.
    // Never reinterpret it as a test harness or silently adopt another binary.
    if current.as_os_str().to_string_lossy().ends_with(" (deleted)") {
        return Err(io::Error::other("The running Rust Runtime executable was replaced by a build/update. Finish the build and restart this agent session. Mandatory isolation remains enabled; no command ran."));
    }
    if current.file_name().and_then(|s| s.to_str()) == Some("local-ai-agent-runtime") {
        Ok(current.to_path_buf())
    } else {
        Ok(current.parent().and_then(Path::parent).ok_or_else(|| io::Error::other("isolation helper unavailable"))?.join("local-ai-agent-runtime"))
    }
}

pub fn sandbox_with_permissions(command: &str, cwd: &str, authorized: bool) -> io::Result<Command> {
    let payload=super::environment::encode(authorized)?;
    let bwrap = bwrap_path()?;
    if !bwrap.is_file() { return Err(io::Error::other("bubblewrap is required; unisolated execution is forbidden")); }
    let cwd = Path::new(cwd).canonicalize()?;
    if cwd == Path::new("/") || ["/proc", "/sys", "/dev", "/run"].iter().any(|p| cwd.starts_with(p)) {
        return Err(io::Error::other("a concrete development workspace is required"));
    }
    if protects_path(&cwd) { return Err(io::Error::other("working directory belongs to protected runtime infrastructure")); }
    let current = std::env::current_exe()?;
    // Unit/integration harnesses execute the same production helper binary.
    let exe = bootstrap_executable(&current)?;
    if !exe.is_file() { return Err(io::Error::other("build the runtime isolation helper first")); }
    let mut child = Command::new(&bwrap);
    child.args(["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
        "--ro-bind", "/", "/"]);
    // Writable scope is the caller's validated workspace, not the application.
    child.arg("--bind").arg(&cwd).arg(&cwd);
    child.args(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/tmp"]);
    if cwd.starts_with("/tmp") { child.arg("--bind").arg(&cwd).arg(&cwd); }
    for path in protected_paths() {
        child.arg("--ro-bind").arg(&path).arg(&path);
    }
    let payload_fd=super::environment::attach(&mut child,&payload)?;
    child.arg("--chdir").arg(&cwd).arg("--").arg(exe).arg("--sandbox-shell").arg(command).arg(payload_fd.to_string());
    // Applies to bwrap and its ELF loader before any instruction executes.
    // The bootstrap also starts in this minimal environment; payload settings
    // are sealed descriptor data, not argv or loader-visible environment.
    child.env_clear().envs(super::environment::SETUP);
    Ok(child)
}

fn confined_payload_label(label: &str) -> bool {
    let Some(profiles)=label.trim().strip_suffix(" (enforce)") else { return false; };
    let components:Vec<_>=profiles.split("//&").collect();
    components.contains(&"local_ai_desktop_bwrap") && components.contains(&"local_ai_desktop_bwrap_child")
}
fn confined_payload_status(status: &str) -> bool {
    let field=|name|status.lines().find_map(|line|line.split_once(':').filter(|(key,_)|*key==name).map(|(_,value)|value.trim()));
    field("NoNewPrivs")==Some("1") && field("Seccomp")==Some("2") &&
        ["CapPrm","CapEff","CapAmb"].into_iter().all(|name|field(name).and_then(|value|u64::from_str_radix(value,16).ok())==Some(0))
}

#[cfg(all(target_os="linux", target_arch="x86_64"))]
pub fn exec_shell(command: &str, environment_fd: i32) -> io::Result<()> {
    if !confined_payload_label(&std::fs::read_to_string("/proc/self/attr/current")?) {
        return Err(io::Error::other("mandatory enforcing AppArmor child profile is absent; payload execution forbidden"));
    }
    let encoded=super::environment::read_descriptor(environment_fd)?;
    let payload=super::environment::decode(&encoded)?;
    use std::os::unix::process::CommandExt;
    #[repr(C)] struct Filter { code: u16, jt: u8, jf: u8, k: u32 }
    #[repr(C)] struct Program { len: u16, filter: *const Filter }
    extern "C" { fn prctl(option: i32, ...) -> i32; }
    fn instruction(code: u16, jt: u8, jf: u8, k: u32) -> Filter { Filter { code, jt, jf, k } }
    // Architecture check also rejects compat/x32 syscall-number bypasses.
    let mut filter = vec![instruction(0x20,0,0,4), instruction(0x15,1,0,0xc000003e), instruction(0x06,0,0,0x80000000),
        instruction(0x20,0,0,0), instruction(0x35,0,1,0x40000000), instruction(0x06,0,0,0x80000000)];
    // Prevent crossing namespaces, ptrace/process-memory access, inherited pidfd
    // acquisition and io_uring's alternate syscall submission mechanism.
    for number in [101,155,165,166,167,168,169,246,272,304,308,310,311,321,425,428,429,430,431,432,433,438,442] {
        filter.push(instruction(0x15,0,1,number)); filter.push(instruction(0x06,0,0,0x00050001));
    }
    // clone's flags can create namespaces without calling unshare. Keep ordinary
    // fork/thread clone; clone3's pointed-to flags cannot be inspected by BPF.
    filter.extend([instruction(0x15,0,4,56), instruction(0x20,0,0,16),
        instruction(0x45,0,1,0x7e020000), instruction(0x06,0,0,0x00050001), instruction(0x20,0,0,0)]);
    // ENOSYS lets glibc use ordinary clone instead of breaking thread creation.
    filter.extend([instruction(0x15,0,1,435),instruction(0x06,0,0,0x00050026)]);
    // AF_UNIX would reach host abstract D-Bus/daemon control sockets despite the
    // private /run mount. Local socketpair IPC remains usable for project tests.
    filter.extend([instruction(0x15,0,7,41), instruction(0x20,0,0,16),
        instruction(0x15,3,0,1), instruction(0x15,2,0,16), instruction(0x15,1,0,17),
        instruction(0x06,0,0,0x7fff0000), instruction(0x06,0,0,0x00050001), instruction(0x06,0,0,0x7fff0000)]);
    filter.push(instruction(0x06,0,0,0x7fff0000));
    let program = Program { len: filter.len() as u16, filter: filter.as_ptr() };
    // SAFETY: kernel copies this live BPF array; no_new_privs cannot be undone.
    unsafe {
        if prctl(38,1,0,0,0) != 0 || prctl(22,2,&program) != 0 { return Err(io::Error::last_os_error()); }
    }
    if !confined_payload_status(&std::fs::read_to_string("/proc/self/status")?) {
        return Err(io::Error::other("payload seccomp/no_new_privs/capability verification failed; execution forbidden"));
    }
    Err(Command::new("/bin/bash").args(["--noprofile","--norc","-o","pipefail","-c",command]).env_clear().envs(payload).exec())
}
#[cfg(not(all(target_os="linux", target_arch="x86_64")))]
pub fn exec_shell(_: &str, _: i32) -> io::Result<()> { Err(io::Error::other("supported Linux isolation is required")) }

#[cfg(test)]
mod tests {
    #[test]
    fn sandbox_initialization_failures_require_setup_without_retrying_or_fallback() {
        let result = super::setup_refusal("Mandatory dedicated sandbox helper is missing. Configure the package.");
        assert_eq!(result["code"], "PROTECTED_RUNTIME_PROCESS");
        assert_eq!(result["setup_required"], true);
        assert_eq!(result["retrySameArguments"], false);
    }
    #[test]
    fn replaced_runtime_requires_restart_without_adopting_a_new_bootstrap() {
        let error=super::bootstrap_executable(std::path::Path::new("/app/local-ai-agent-runtime (deleted)")).unwrap_err().to_string();
        assert!(error.contains("restart this agent session"));
        assert!(error.contains("no command ran"));
        assert_eq!(super::bootstrap_executable(std::path::Path::new("/app/local-ai-agent-runtime")).unwrap(),std::path::PathBuf::from("/app/local-ai-agent-runtime"));
        assert_eq!(super::bootstrap_executable(std::path::Path::new("/app/deps/test-harness")).unwrap(),std::path::PathBuf::from("/app/local-ai-agent-runtime"));
    }

    #[test]
    fn payload_checks_require_real_enforcing_stack_and_kernel_security_state() {
        assert!(super::confined_payload_label("local_ai_desktop_bwrap//&local_ai_desktop_bwrap_child (enforce)\n"));
        for label in ["unconfined","local_ai_desktop_bwrap (enforce)","local_ai_desktop_bwrap//&local_ai_desktop_bwrap_child (complain)",
            "local_ai_desktop_bwrap//&local_ai_desktop_bwrap_child_fake (enforce)"] { assert!(!super::confined_payload_label(label)); }
        let state="NoNewPrivs:\t1\nSeccomp:\t2\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n";
        assert!(super::confined_payload_status(state));
        for (from,to) in [("NoNewPrivs:\t1","NoNewPrivs:\t0"),("Seccomp:\t2","Seccomp:\t0"),("CapEff:\t0000000000000000","CapEff:\t0000000000000001")] {
            assert!(!super::confined_payload_status(&state.replace(from,to)));
        }
        assert!(!super::confined_payload_status(""));
    }

    #[test]
    fn setup_command_has_only_fixed_environment_and_payload_is_not_loader_visible() {
        let cwd=std::env::temp_dir();
        let setup=super::sandbox_with_permissions("echo safe",cwd.to_str().unwrap(),false).unwrap();
        let environment:std::collections::BTreeMap<_,_>=setup.get_envs()
            .map(|(key,value)|(key.to_string_lossy().into_owned(),value.unwrap().to_string_lossy().into_owned())).collect();
        assert_eq!(environment,std::collections::BTreeMap::from([
            ("PATH".into(),"/usr/bin:/bin".into()),("LANG".into(),"C".into()),("LC_ALL".into(),"C".into())]));
        let fd=setup.get_args().last().unwrap().to_str().unwrap().parse::<i32>().unwrap();
        extern "C" { fn dup(fd: i32) -> i32; }
        let copy=unsafe{dup(fd)};assert!(copy>2);
        let encoded=super::super::environment::read_descriptor(copy).unwrap();
        let payload=super::super::environment::decode(&encoded).unwrap();
        assert!(!setup.get_args().any(|arg|arg.to_string_lossy().contains("HOME") || arg.to_string_lossy().contains("HTTPS_PROXY")));
        assert_eq!(payload["PATH"],"/usr/bin:/bin");
        assert!(!payload.contains_key("LD_AUDIT"));
    }

    #[test]
    fn private_helper_requires_root_ownership_without_write_or_privileged_mode_bits() {
        assert!(super::trusted_identity(true,0,0o100750));
        assert!(!super::trusted_identity(true,1000,0o100750));
        for mode in [0o100770,0o100777,0o104750,0o102750] { assert!(!super::trusted_identity(true,0,mode)); }
        assert!(!super::trusted_identity(false,0,0o100750));
    }

    #[test]
    fn candidate_policy_has_a_private_attachment_and_an_inherited_restricted_payload() {
        let profile=include_str!("../../../assets/apparmor/local-ai-desktop-bwrap");
        assert!(profile.contains("profile local_ai_desktop_bwrap /usr/lib/local-ai-desktop/bwrap"));
        assert!(!profile.contains("profile local_ai_desktop_bwrap /usr/bin/bwrap"));
        assert!(!profile.contains("allow capability,"));
        let child=profile.split("profile local_ai_desktop_bwrap_child ").nth(1).unwrap();
        for denied in ["capability", "change_profile", "userns", "mount", "umount", "pivot_root", "dbus"] {
            assert!(child.contains(&format!("audit deny {denied},")));
        }
        assert!(child.contains("/{**,} ix,"));
        assert!(child.contains("audit deny /usr/lib/local-ai-desktop/bwrap x,"),
            "agent payloads must not invoke the dedicated setup helper directly");
        assert!(!child.contains("pix ") && !child.contains(" px ") && !child.contains(" ux "));
        assert!(profile.contains("px /** -> local_ai_desktop_bwrap//&local_ai_desktop_bwrap_child,"));
    }

    #[test]
    fn audited_newroot_self_bind_is_setup_only_and_does_not_authorize_payload_mounts() {
        let profile=include_str!("../../../assets/apparmor/local-ai-desktop-bwrap");
        let (setup,child)=profile.split_once("profile local_ai_desktop_bwrap_child ").unwrap();
        // Pin the actual source/target and exact flags from audit(1791816704.769:1643).
        // A wildcard target or 'options in' would authorize unrelated operations.
        let staging_rules:Vec<_>=setup.lines().map(str::trim)
            .filter(|line|line.contains("/tmp/newroot/")).collect();
        assert_eq!(staging_rules,vec!["mount options=(rw, rbind) /tmp/newroot/ -> /tmp/newroot/,"]);
        assert!(!child.contains("/tmp/newroot/"));
        for denied in ["mount", "umount", "pivot_root", "userns", "capability", "change_profile"] {
            assert!(child.contains(&format!("audit deny {denied},")));
        }
        assert!(child.contains("signal (send) peer=local_ai_desktop_bwrap*,"));
        assert!(child.contains("/{**,} ix,"));
        let refusal=super::startup_failure("bwrap: setting up newroot bind: Permission denied\n").unwrap();
        assert_eq!(refusal["code"],super::CODE);
        assert_eq!(refusal["sandbox_diagnostic"]["stage"],"sandbox_setup");
        assert_eq!(refusal["setup_required"],true);
        assert_eq!(refusal["retrySameArguments"],false);
    }

    #[test]
    fn audited_old_staging_root_detach_is_exact_and_setup_only() {
        let profile=include_str!("../../../assets/apparmor/local-ai-desktop-bwrap");
        let (setup,child)=profile.split_once("profile local_ai_desktop_bwrap_child ").unwrap();
        // audit(1791819073.781:1810): pre-exec bwrap umount has name="/".
        // No unrestricted umount or descendant wildcard is needed for this step.
        let grants:Vec<_>=setup.lines().map(str::trim).filter(|line|line.starts_with("umount ")).collect();
        assert_eq!(grants,vec!["umount /oldroot/{,**},","umount /,"]);
        assert!(!setup.lines().any(|line|line.trim()=="umount," || line.trim()=="allow umount,"));
        assert!(child.contains("audit deny umount,"));
        assert!(!child.lines().any(|line|line.trim().starts_with("umount ")));
        for denied in ["mount", "pivot_root", "userns", "capability", "change_profile"] {
            assert!(child.contains(&format!("audit deny {denied},")));
        }
        assert!(profile.contains("px /** -> local_ai_desktop_bwrap//&local_ai_desktop_bwrap_child,"));
        assert!(child.contains("/{**,} ix,"));
        let refusal=super::startup_failure("bwrap: umount old root: Permission denied\n").unwrap();
        assert_eq!(refusal["code"],super::CODE);
        assert_eq!(refusal["sandbox_diagnostic"]["stage"],"sandbox_setup");
        assert_eq!(refusal["setup_required"],true);
        assert_eq!(refusal["retrySameArguments"],false);
    }

    #[test]
    fn uid_mapping_failures_explain_the_host_policy_and_never_offer_an_unsafe_fallback() {
        let diagnostic=super::startup_failure("bwrap: setting up uid map: Permission denied\n").unwrap();
        assert_eq!(diagnostic["code"],super::CODE);
        assert_eq!(diagnostic["sandbox_diagnostic"]["stage"],"user_namespace_mapping");
        assert_eq!(diagnostic["setup_required"],true);
        assert_eq!(diagnostic["retrySameArguments"],false);
        assert!(diagnostic["error"].as_str().unwrap().contains("executable-scoped AppArmor"));
        assert!(super::startup_failure("cat: file not found").is_none());
    }
}
