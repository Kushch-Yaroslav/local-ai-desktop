//! Lightweight preimages, not commits. Every generic mutation has a recoverable
//! original (or an absence marker) before it touches project state.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};
use serde_json::json;
static NEXT: AtomicU64 = AtomicU64::new(0);
fn unique() -> String {
    format!("{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed))
}
/// The desktop host supplies durable app-data storage per logical task. Standalone
/// CLI callers use a private temporary store, always outside the project.
pub fn storage_root() -> PathBuf {
    std::env::var_os("LOCAL_AI_EDIT_BACKUP_ROOT").map(PathBuf::from)
        .unwrap_or_else(||std::env::temp_dir().join("local-ai-desktop-edit-backups"))
}
pub fn protected(target:&Path)->bool {
    let root=storage_root();target.starts_with(&root)||fs::canonicalize(root).is_ok_and(|root|target.starts_with(root))
}
fn private_directory(path:&Path)->Result<(),String>{
    if !path.is_absolute(){return Err("Recovery storage must be absolute".into());}
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev(){
        match fs::symlink_metadata(ancestor){
            Ok(meta) if meta.file_type().is_symlink()||!meta.is_dir()=>return Err("Recovery storage must not contain symlinks or non-directories".into()),
            Ok(_)=>{},
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{
                let mut builder=fs::DirBuilder::new();
                #[cfg(unix)]{use std::os::unix::fs::DirBuilderExt;builder.mode(0o700);}
                if let Err(error)=builder.create(ancestor){if error.kind()!=std::io::ErrorKind::AlreadyExists{return Err(error.to_string());}}
                if fs::symlink_metadata(ancestor).map_err(|e|e.to_string())?.file_type().is_symlink(){return Err("Recovery storage changed to a symlink".into());}
                if let Some(parent)=ancestor.parent(){fs::File::open(parent).and_then(|file|file.sync_all()).map_err(|e|e.to_string())?;}
            },
            Err(error)=>return Err(error.to_string()),
        }
    }
    Ok(())
}
pub fn snapshot(project:&Path,target:&Path)->Result<PathBuf,String>{
    snapshot_in(&storage_root(),project,target,&std::env::var("LOCAL_AI_EDIT_TASK").unwrap_or_else(|_|"standalone".into()))
}
pub fn snapshot_in(storage:&Path,project:&Path,target:&Path,task:&str)->Result<PathBuf,String>{
    use sha2::{Digest,Sha256};
    use std::io::Read;
    let project=fs::canonicalize(project).map_err(|e|e.to_string())?;
    if storage.starts_with(&project){return Err("Edit backups must be outside the project".into());}
    private_directory(storage)?;
    let storage=fs::canonicalize(storage).map_err(|e|e.to_string())?;
    if storage.starts_with(&project){return Err("Edit backups must be outside the project".into());}
    let project_key=format!("{:x}",Sha256::digest(project.as_os_str().as_encoded_bytes()));
    let task_key=format!("{:x}",Sha256::digest(task.as_bytes()));
    let directory=storage.join(project_key).join(task_key);private_directory(&directory)?;
    let folder=directory.join(unique());
    let mut builder=fs::DirBuilder::new();
    #[cfg(unix)]{use std::os::unix::fs::DirBuilderExt;builder.mode(0o700);}
    builder.create(&folder).map_err(|e|e.to_string())?;
    let original=match fs::symlink_metadata(target){Ok(meta) if meta.is_file()&&!meta.file_type().is_symlink()=>Some(meta),Ok(_)=>return Err("Preimage target must be a regular file".into()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>None,Err(e)=>return Err(e.to_string())};
    let mut hash=None;let mut mode=None;
    if let Some(metadata)=&original{
        let mut options=fs::OpenOptions::new();options.read(true);
        #[cfg(target_os="linux")]{use std::os::unix::fs::OpenOptionsExt;options.custom_flags(0x20000);}
        let mut source=options.open(target).map_err(|e|e.to_string())?;
        let mut out_options=fs::OpenOptions::new();out_options.write(true).create_new(true);
        #[cfg(unix)]{use std::os::unix::fs::{OpenOptionsExt,PermissionsExt};out_options.mode(0o600);mode=Some(metadata.permissions().mode());}
        let mut output=out_options.open(folder.join("original")).map_err(|e|e.to_string())?;
        let mut digest=Sha256::new();let mut buffer=[0;65536];
        loop{let count=source.read(&mut buffer).map_err(|e|e.to_string())?;if count==0{break;}digest.update(&buffer[..count]);output.write_all(&buffer[..count]).map_err(|e|e.to_string())?;}
        output.sync_all().map_err(|e|e.to_string())?;
        let after=source.metadata().map_err(|e|e.to_string())?;
        if after.len()!=metadata.len()||after.modified().ok()!=metadata.modified().ok(){return Err("Source changed while recording preimage; no edit was made".into());}
        hash=Some(format!("{:x}",digest.finalize()));
    }
    let manifest=json!({"application":"local-ai-desktop","version":1,"project":project,"task":task,"target":target,"existed":original.is_some(),"preimage":"original","sha256":hash,"mode":mode});
    let mut options=fs::OpenOptions::new();options.write(true).create_new(true);
    #[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
    let mut file=options.open(folder.join("manifest.json")).map_err(|e|e.to_string())?;
    file.write_all(manifest.to_string().as_bytes()).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;
    fs::File::open(&folder).and_then(|file|file.sync_all()).map_err(|e|e.to_string())?;
    fs::File::open(&directory).and_then(|file|file.sync_all()).map_err(|e|e.to_string())?;
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
