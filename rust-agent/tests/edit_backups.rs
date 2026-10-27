use local_ai_agent_runtime::tools::{filesystem,recovery};
use serde_json::{json,Value};
use std::{fs,path::Path};
use std::os::unix::fs::{PermissionsExt,symlink};

#[test]
fn external_preimages_survive_edits_failure_rollback_and_project_isolation(){
    let base=std::env::temp_dir().join(format!("lad-external-backups-{}",std::process::id()));fs::create_dir_all(&base).unwrap();
    let storage=base.join("app-data/edit-backups");std::env::set_var("LOCAL_AI_EDIT_BACKUP_ROOT",&storage);std::env::set_var("LOCAL_AI_EDIT_TASK","fixture-task");
    let a=base.join("a");let b=base.join("b");fs::create_dir_all(a.join("nested")).unwrap();fs::create_dir_all(&b).unwrap();
    let call=|root:&Path,name:&str,args:Value|filesystem::execute(root,name,&args);
    let (created,_)=call(&a,"create_file",json!({"path":"nested/same.txt","content":"original"})).unwrap();
    let folder=std::path::PathBuf::from(created["backup"].as_str().unwrap());assert!(folder.starts_with(&storage));
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(folder.join("manifest.json")).unwrap()).unwrap()["existed"],false);
    fs::set_permissions(a.join("nested/same.txt"),fs::Permissions::from_mode(0o751)).unwrap();
    let (edited,_)=call(&a,"write_file",json!({"path":"nested/same.txt","content":"changed"})).unwrap();
    let preimage=std::path::PathBuf::from(edited["backup"].as_str().unwrap());assert_eq!(fs::read(preimage.join("original")).unwrap(),b"original");
    let manifest:Value=serde_json::from_slice(&fs::read(preimage.join("manifest.json")).unwrap()).unwrap();assert_eq!(manifest["application"],"local-ai-desktop");assert!(manifest["sha256"].as_str().unwrap().len()==64);
    assert_eq!(fs::metadata(a.join("nested/same.txt")).unwrap().permissions().mode()&0o777,0o751);
    fs::write(b.join("same.txt"),"other-project").unwrap();let separate=recovery::snapshot(&b,&b.join("same.txt")).unwrap();assert_ne!(separate.parent().unwrap().parent(),preimage.parent().unwrap().parent());
    assert!(call(&a,"apply_patch",json!({"patch":"*** Begin Patch\n*** Update File: nested/same.txt\n@@\n-no-match\n+bad\n*** End Patch"})).is_err());assert_eq!(fs::read(a.join("nested/same.txt")).unwrap(),b"changed");
    fs::create_dir(a.join("readonly")).unwrap();fs::write(a.join("readonly/locked.txt"),"locked").unwrap();fs::set_permissions(a.join("readonly"),fs::Permissions::from_mode(0o555)).unwrap();
    let patch="*** Begin Patch\n*** Delete File: nested/same.txt\n*** Update File: readonly/locked.txt\n@@\n-locked\n+modified\n*** End Patch";
    let outcome=call(&a,"apply_patch",json!({"patch":patch}));
    fs::set_permissions(a.join("readonly"),fs::Permissions::from_mode(0o755)).unwrap();
    assert!(outcome.unwrap_err().contains("rollback errors: []"));assert_eq!(fs::read(a.join("nested/same.txt")).unwrap(),b"changed");assert_eq!(fs::metadata(a.join("nested/same.txt")).unwrap().permissions().mode()&0o777,0o751);
    // Durable preimages remain independently readable after the failed edit.
    assert_eq!(fs::read(preimage.join("original")).unwrap(),b"original");
    symlink(&storage,base.join("storage-link")).unwrap();assert!(recovery::snapshot_in(&base.join("storage-link"),&a,&a.join("nested/same.txt"),"task").is_err());
    fn no_backups(root:&Path){for item in fs::read_dir(root).unwrap(){let item=item.unwrap();assert_ne!(item.file_name(),".local-ai-backups");if item.file_type().unwrap().is_dir(){no_backups(&item.path());}}}
    no_backups(&a);no_backups(&b);fs::remove_dir_all(base).unwrap();
}
