//! Closed setup environment; payload data is applied only after confinement.
use std::{collections::BTreeMap, io};
const PATH: &str = "/usr/bin:/bin";
const PAYLOAD_KEYS: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "TERM", "COLORTERM", "NO_COLOR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "CARGO_HOME", "RUSTUP_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
];
pub const SETUP: [(&str, &str); 3] = [("PATH", PATH), ("LANG", "C"), ("LC_ALL", "C")];
fn invalid(reason: &str) -> io::Error { io::Error::other(reason) }
fn checked(mut payload: BTreeMap<String,String>) -> io::Result<BTreeMap<String,String>> {
    if payload.iter().any(|(key,value)| !PAYLOAD_KEYS.contains(&key.as_str()) || value.contains('\0') || value.len()>16_384) {
        return Err(invalid("payload environment contains an unsupported key or value"));
    }
    if payload.get("PATH").is_none_or(String::is_empty) { payload.insert("PATH".into(),PATH.into()); }
    // Fixed locale and writable caches; inherited locale/module discovery is forbidden.
    for (key,value) in [("LANG","C.UTF-8"),("LC_ALL","C.UTF-8"),("TMPDIR","/tmp"),
        ("XDG_CACHE_HOME","/tmp/xdg-cache"),("npm_config_cache","/tmp/npm-cache"),("PIP_CACHE_DIR","/tmp/pip-cache")] {
        payload.insert(key.into(),value.into());
    }
    Ok(payload)
}
pub fn encode(authorized: bool) -> io::Result<String> {
    let mut raw = match std::env::var("LOCAL_AI_AGENT_PAYLOAD_ENV") {
        Ok(encoded) => decode_raw(&encoded)?,
        Err(std::env::VarError::NotPresent) => PAYLOAD_KEYS.iter().filter_map(|key|std::env::var(key).ok().map(|value|((*key).into(),value))).collect(),
        Err(_) => return Err(invalid("invalid payload environment encoding")),
    };
    if !authorized { raw.insert("PATH".into(),PATH.into()); }
    if raw.iter().any(|(key,value)|!PAYLOAD_KEYS.contains(&key.as_str()) || value.contains('\0') || value.len()>16_384) {
        return Err(invalid("invalid payload environment"));
    }
    let encoded=serde_json::to_string(&raw).map_err(|_|invalid("payload environment serialization failed"))?;
    if encoded.len()>65_536 { return Err(invalid("payload environment exceeds limit")); }
    Ok(encoded)
}
fn decode_raw(encoded: &str) -> io::Result<BTreeMap<String,String>> {
    if encoded.len()>65_536 { return Err(invalid("payload environment exceeds limit")); }
    serde_json::from_str(encoded).map_err(|_|invalid("payload environment must be a JSON string map"))
}
pub fn decode(encoded: &str) -> io::Result<BTreeMap<String,String>> { checked(decode_raw(encoded)?) }

// Anonymous sealed descriptor: proxy credentials never appear in process argv.
// CLOEXEC stays set in the multithreaded parent; only this child's pre_exec
// clears it. The Command closure owns the File until spawn completes.
#[cfg(target_os="linux")]
pub fn attach(command: &mut std::process::Command, encoded: &str) -> io::Result<i32> {
    use std::{ffi::CString, fs::File, io::{Write,Seek,SeekFrom}, os::{fd::{AsRawFd,FromRawFd},unix::process::CommandExt}};
    extern "C" { fn memfd_create(name: *const i8, flags: u32) -> i32; fn fcntl(fd: i32, operation: i32, ...) -> i32; }
    let name=CString::new("local-ai-payload-environment").unwrap();
    // SAFETY: live name; returned fd is exclusively owned by File.
    let fd=unsafe{memfd_create(name.as_ptr(),3)};
    if fd<0 { return Err(io::Error::last_os_error()); }
    let mut file=unsafe{File::from_raw_fd(fd)};
    file.write_all(encoded.as_bytes())?;file.seek(SeekFrom::Start(0))?;
    if unsafe{fcntl(fd,1033,15)}<0 { return Err(io::Error::last_os_error()); }
    // SAFETY: after fork this closure only invokes async-signal-safe fcntl.
    unsafe { command.pre_exec(move||{
        if fcntl(file.as_raw_fd(),2,0)<0 { return Err(io::Error::last_os_error()); }
        Ok(())
    }); }
    Ok(fd)
}
#[cfg(not(target_os="linux"))]
pub fn attach(_: &mut std::process::Command, _: &str) -> io::Result<i32> { Err(invalid("Linux sealed environment transport is required")) }

#[cfg(target_os="linux")]
pub fn read_descriptor(fd: i32) -> io::Result<String> {
    use std::{fs::File,io::{Read,Seek,SeekFrom},os::fd::FromRawFd};
    extern "C" { fn fcntl(fd: i32, operation: i32, ...) -> i32; }
    if fd<=2 { return Err(invalid("invalid payload environment descriptor")); }
    let seals=unsafe{fcntl(fd,1034)};
    if seals<0 || seals & 15 != 15 { return Err(invalid("payload environment must be an immutable sealed descriptor")); }
    // SAFETY: validated inherited descriptor, ownership transferred to File.
    let mut file=unsafe{File::from_raw_fd(fd)};
    if file.metadata()?.len()>65_536 { return Err(invalid("payload environment exceeds limit")); }
    file.seek(SeekFrom::Start(0))?;
    let mut encoded=String::new();file.read_to_string(&mut encoded)?;Ok(encoded)
}
#[cfg(not(target_os="linux"))]
pub fn read_descriptor(_: i32) -> io::Result<String> { Err(invalid("Linux sealed environment transport is required")) }

#[cfg(test)]
mod tests {
    #[test]
    fn environment_transport_is_sealed_cloexec_and_not_in_argv() {
        use std::os::fd::AsRawFd;
        extern "C" { fn fcntl(fd: i32, operation: i32, ...) -> i32; fn write(fd: i32, bytes: *const u8, size: usize) -> isize; fn dup(fd: i32) -> i32; }
        let mut command=std::process::Command::new("/bin/true");
        let fd=super::attach(&mut command,r#"{"HTTPS_PROXY":"fixture-secret"}"#).unwrap();
        assert_eq!(unsafe{fcntl(fd,1)} & 1,1,"parent descriptor must stay CLOEXEC");
        assert_eq!(unsafe{fcntl(fd,1034)} & 15,15);
        assert_eq!(unsafe{write(fd,b"x".as_ptr(),1)},-1,"sealed data must be immutable");
        let copy=unsafe{dup(fd)};assert!(super::read_descriptor(copy).unwrap().contains("fixture-secret"));
        assert!(!command.get_args().any(|arg|arg.to_string_lossy().contains("fixture-secret")));
        let unsealed=std::fs::File::open("/dev/null").unwrap();assert!(super::read_descriptor(unsealed.as_raw_fd()).is_err());
        assert!(super::read_descriptor(0).is_err());
    }

    #[test]
    fn loader_shell_language_runtime_and_locale_hooks_never_enter_payload_metadata() {
        for key in ["LD_AUDIT","LD_PRELOAD","LD_LIBRARY_PATH","LD_DEBUG","LD_ORIGIN_PATH","LD_PROFILE","GLIBC_TUNABLES",
            "GCONV_PATH","LOCPATH","NLSPATH","BASH_ENV","ENV","BASH_FUNC_bad%%","NODE_OPTIONS","NODE_PATH","PYTHONPATH","PYTHONHOME",
            "OPENSSL_CONF","TMPDIR","LOCAL_AI_PROTECTED_PATHS"] {
            assert!(super::decode(&format!("{{\"{key}\":\"/tmp/hostile\"}}")).is_err(),"{key}");
        }
    }
    #[test]
    fn development_settings_are_data_and_fixed_startup_settings_are_not_inherited() {
        let env=super::decode(r#"{"PATH":"/project/venv/bin:/usr/bin","HOME":"/home/user","HTTPS_PROXY":"http://proxy","CARGO_HOME":"/project/cargo"}"#).unwrap();
        assert_eq!(env["PATH"],"/project/venv/bin:/usr/bin");assert_eq!(env["LANG"],"C.UTF-8");
        assert_eq!(env["TMPDIR"],"/tmp");assert_eq!(super::SETUP.len(),3);
        assert!(super::decode(r#"{"HOME":"bad\u0000value"}"#).is_err());
        assert!(super::decode("not json").is_err());
    }
}
