//! Lightweight preimages, not commits. Every generic mutation has a recoverable
//! original (or an absence marker) before it touches project state.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};
use serde_json::json;
static NEXT: AtomicU64 = AtomicU64::new(0);
fn unique() -> String {
    format!("{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed))
}
pub fn snapshot(target: &Path) -> Result<PathBuf, String> {
    let parent = target.parent().ok_or("file has no parent")?;
    // The recovery directory is sibling-local, so additional authorized roots
    // and separate filesystems work without assuming a writable app directory.
    let recovery = parent.join(".local-ai-backups");
    if fs::symlink_metadata(&recovery).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("recovery directory must not be a symlink".into());
    }
    fs::create_dir_all(&recovery).map_err(|error| error.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&recovery, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
    }
    let folder = recovery.join(unique());
    fs::create_dir(&folder).map_err(|error| error.to_string())?;
    let exists = target.exists();
    if exists {
        fs::copy(target, folder.join("original")).map_err(|error| error.to_string())?;
    }
    fs::write(folder.join("manifest.json"), json!({"target":target,"existed":exists,"preimage":"original"}).to_string()).map_err(|error| error.to_string())?;
    Ok(folder)
}
pub fn atomic_write(target: &Path, bytes: &[u8], create_only: bool) -> Result<(), String> {
    let parent = target.parent().ok_or("file has no parent")?;
    let temporary = parent.join(format!(".local-ai-stage-{}", unique()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
        if let Ok(metadata) = fs::metadata(target) { file.set_permissions(metadata.permissions()).map_err(|error| error.to_string())?; }
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        if create_only {
            // Link provides no-clobber creation; rename alone overwrites races.
            fs::hard_link(&temporary, target).map_err(|error| error.to_string())?;
        } else { fs::rename(&temporary, target).map_err(|error| error.to_string())?; }
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}
