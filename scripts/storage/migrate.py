#!/usr/bin/env python3
"""Local AI Desktop: verified offline migration. Plan and receipts contain private paths.
Use --plan PLAN --receipt RECEIPT; rollback with --rollback RECEIPT.
No partition, mount, database schema or model changes are performed.
"""
import argparse, hashlib, json, os, pathlib, shutil, sqlite3, subprocess, tarfile, time
P = pathlib.Path

def manifest(root):
    result = {}
    for parent, dirs, files in os.walk(root):
        for name in dirs + files:
            p = P(parent)/name; key = str(p.relative_to(root))
            if p.is_symlink(): result[key] = ['link', os.readlink(p)]
            elif p.is_file():
                h=hashlib.sha256()
                with p.open('rb') as f:
                    for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
                result[key] = ['file', p.stat().st_size, h.hexdigest()]
    return result

def verify_databases(root):
    report={}
    for p in root.rglob('*'):
        if p.is_file() and p.suffix in ('.db','.sqlite','.sqlite3'):
            with sqlite3.connect('file:'+str(p)+'?mode=ro&immutable=1',uri=True) as db:
                result=db.execute('pragma integrity_check').fetchall()
                if result != [('ok',)]: raise RuntimeError(f'Database integrity failure: {p}: {result}')
                counts={}
                for table in ['sessions','messages']:
                    if db.execute('select 1 from sqlite_master where name=?',(table,)).fetchone():
                        counts[table]=db.execute('select count(*) from '+table).fetchone()[0]
                report[str(p.relative_to(root))]=counts
    return report

def require_stopped():
    for process in P('/proc').iterdir():
        if not process.name.isdigit(): continue
        try: name=(process/'comm').read_text().strip()
        except (OSError,ProcessLookupError): continue
        if name in ('goose','llama-server','local-ai-deskto','Local AI Deskto'):
            raise RuntimeError(f'Close app/backend before migration: PID {process.name}, {name}')

def copy_verified(source,destination):
    if destination.exists() or destination.is_symlink(): raise RuntimeError(f'Destination already exists: {destination}')
    destination.parent.mkdir(parents=True,exist_ok=True)
    before=manifest(source)
    shutil.copytree(source,destination,symlinks=True,copy_function=shutil.copy2)
    if before != manifest(source) or before != manifest(destination): raise RuntimeError(f'Copy verification failed: {source}')
    if verify_databases(source)!=verify_databases(destination): raise RuntimeError('Database counts changed')
    return before

def verify_volumes(configuration):
    for volume in configuration['volumes']:
        mount=volume['mountpoint']
        if not os.path.ismount(mount):raise RuntimeError('Mount absent: '+mount)
        source=subprocess.check_output(['findmnt','-n','-o','SOURCE','--target',mount],text=True).strip()
        if P('/dev/disk/by-uuid/'+volume['uuid']).resolve()!=P(source).resolve():raise RuntimeError('Wrong disk mounted: '+mount)
        if not os.access(mount,os.W_OK):raise RuntimeError('Volume is not writable: '+mount)

def migrate(plan,receipt):
    require_stopped()
    if receipt.exists(): raise RuntimeError('Receipt exists; inspect it before retrying')
    config=P(plan['configFile'])
    if config.exists(): raise RuntimeError('Storage configuration already exists')
    verify_volumes(plan['configuration'])
    backup=P(plan['backup']);backup.parent.mkdir(parents=True,exist_ok=True)
    if backup.exists(): raise RuntimeError('Backup already exists')
    sources=[P(m['source']) for m in plan['moves']]
    with tarfile.open(backup,'w:gz',compresslevel=1) as tar:
        backup.chmod(0o600)
        for source in sources: tar.add(source,arcname=str(source).lstrip('/'),recursive=True)
    with tarfile.open(backup,'r:gz') as tar:
        # Read every archived file to detect corruption before switching anything.
        for member in tar:
            if member.isfile():
                with tar.extractfile(member) as f:
                    while f.read(1024*1024): pass
    with backup.open('rb') as backup_file:
        backup_digest=hashlib.file_digest(backup_file,'sha256').hexdigest()
    record={'backupSha256':backup_digest,'plan':plan,'copied':[],'switched':[],'completed':False}
    def save(): receipt.parent.mkdir(parents=True,exist_ok=True);receipt.write_text(json.dumps(record,indent=2));receipt.chmod(0o600)
    save()
    for move in plan['moves']:
        source=P(move['source']);destination=P(move['destination'])
        files=copy_verified(source,destination)
        record['copied'].append({'source':str(source),'destination':str(destination),'manifestSha256':hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest(),'files':len(files),'bytes':sum(v[1] for v in files.values() if v[0]=='file'),'databases':verify_databases(destination)})
        save()
    complete_migration(record,receipt)

def remove_tree(root):
    for parent, dirs, files in os.walk(root):
        os.chmod(parent, P(parent).stat().st_mode | 0o700)
    shutil.rmtree(root)

def complete_migration(record,receipt):
    require_stopped()
    plan=record['plan']
    verify_volumes(plan['configuration'])
    config=P(plan['configFile'])
    def save():receipt.write_text(json.dumps(record,indent=2))
    for move in plan.get('bulkMoves',[]):
        source=P(move['source']);destination=P(move['destination'])
        if source.is_symlink() and source.resolve()==destination.resolve(): continue
        if not source.exists() and not destination.exists(): continue
        if destination.exists():
            original = None
            for copied in record['copied']:
                try: original=P(copied['source'])/source.relative_to(P(copied['destination']));break
                except ValueError: pass
            if original is None: raise RuntimeError('Unknown existing bulk destination')
            if original.is_dir():
                if manifest(original)!=manifest(destination): raise RuntimeError('Existing bulk copy mismatch')
            elif original.read_bytes()!=destination.read_bytes():raise RuntimeError('Existing bulk file mismatch')
            if source.exists():
                if source.is_dir():remove_tree(source)
                else:source.unlink()
            source.symlink_to(destination,target_is_directory=destination.is_dir())
            continue
        if source.is_dir(): copy_verified(source,destination);remove_tree(source)
        else:
            destination.parent.mkdir(parents=True,exist_ok=True)
            if destination.exists(): raise RuntimeError('Bulk destination exists')
            shutil.copy2(source,destination)
            if hashlib.sha256(source.read_bytes()).digest()!=hashlib.sha256(destination.read_bytes()).digest(): raise RuntimeError('Bulk checksum failed')
            source.unlink()
        source.symlink_to(destination,target_is_directory=destination.is_dir())
    for copied in record['copied']:
        original=P(copied['source']);dest=P(copied['destination'])
        if original.is_symlink() and original.with_name(original.name+'.migration-old').exists(): original=original.with_name(original.name+'.migration-old')
        for key,value in manifest(original).items():
            target=dest/key
            if value[0]=='link':
                if not target.is_symlink() or os.readlink(target)!=value[1]:raise RuntimeError('Relocated link mismatch')
            else:
                with target.open('rb') as f:
                    if target.stat().st_size!=value[1] or hashlib.file_digest(f,'sha256').hexdigest()!=value[2]:raise RuntimeError('Relocated file mismatch')
    for root in [plan['configuration']['dataRoot'],plan['configuration']['bulkRoot']]:
        P(root).mkdir(parents=True,exist_ok=True);(P(root)/'.local-ai-desktop-storage').write_text('Local AI Desktop storage v1\n')
    for move in plan['moves']:
        source=P(move['source']);destination=P(move['destination']);old=source.with_name(source.name+'.migration-old')
        if source.is_symlink() and source.resolve()==destination.resolve() and old.exists():continue
        if old.exists():raise RuntimeError('Rollback source already exists')
        source.rename(old)
        try:source.symlink_to(destination,target_is_directory=True)
        except BaseException:old.rename(source);raise
        record['switched'].append({'source':str(source),'old':str(old),'destination':str(destination)});save()
    config.parent.mkdir(parents=True,exist_ok=True)
    temp=config.with_suffix('.tmp');temp.write_text(json.dumps(plan['configuration'],indent=2));temp.chmod(0o600);temp.replace(config)
    record['completed']=True;save()
    print(json.dumps(record['copied'],indent=2))
    print('Copies verified and paths switched. Original .migration-old copies retained until application validation.')

def rollback(receipt):
    require_stopped();record=json.loads(receipt.read_text())
    verify_volumes(record['plan']['configuration'])
    for move in reversed(record['switched']):
        source=P(move['source']);old=P(move['old']);dest=P(move['destination'])
        if not source.is_symlink() or source.resolve()!=dest.resolve():raise RuntimeError('Source link changed; stop rollback')
        # Include any data written since migration. Keep the relocated copy intact.
        restored=source.with_name(source.name+'.rollback-copy')
        if restored.exists():raise RuntimeError('Rollback copy exists')
        shutil.copytree(dest,restored,symlinks=True,copy_function=shutil.copy2)
        # Materialize only links created by this migration; preserve all original user/package links.
        for bulk in record['plan'].get('bulkMoves',[]):
            try:relative=P(bulk['source']).relative_to(dest)
            except ValueError:continue
            link=restored/relative;bulk_target=P(bulk['destination'])
            if not link.is_symlink() or link.resolve()!=bulk_target.resolve():continue
            link.unlink()
            if bulk_target.is_dir():shutil.copytree(bulk_target,link,symlinks=True,copy_function=shutil.copy2)
            else:shutil.copy2(bulk_target,link)
        verify_databases(restored)
        source.unlink();restored.rename(source)
    config=P(record['plan']['configFile'])
    if config.exists():config.rename(config.with_suffix('.disabled'))
    record['rolledBack']=True;receipt.write_text(json.dumps(record,indent=2))

def verify_archived_originals(record):
    expected={move['old']:set() for move in record['switched']}
    with tarfile.open(record['plan']['backup'],'r:gz') as archive:
        for entry in archive:
            source=P('/'+entry.name)
            for move in record['switched']:
                try:relative=source.relative_to(move['source'])
                except ValueError:continue
                current=P(move['old'])/relative
                if entry.isfile() or entry.islnk():
                    expected[move['old']].add(str(relative))
                    # SQLite's shared-memory index is disposable; DB and WAL bytes remain mandatory.
                    if current.name.endswith('-shm'):break
                    if not current.is_file():raise RuntimeError('Original archived file missing')
                    with archive.extractfile(entry) as old_file, current.open('rb') as current_file:
                        if hashlib.file_digest(old_file,'sha256').digest()!=hashlib.file_digest(current_file,'sha256').digest():raise RuntimeError('Original content differs from archive: '+str(source))
                elif entry.issym():
                    expected[move['old']].add(str(relative))
                    if not current.is_symlink() or os.readlink(current)!=entry.linkname:raise RuntimeError('Original link changed')
                break
    for move in record['switched']:
        for key,value in manifest(P(move['old'])).items():
            if key in expected[move['old']]:continue
            if key.endswith('-shm') or (key.endswith('-wal') and value[0]=='file' and value[1]==0):continue
            raise RuntimeError('Unexpected original file: '+key)

def finalize(receipt):
    require_stopped();record=json.loads(receipt.read_text())
    verify_volumes(record['plan']['configuration'])
    if not record.get('completed') or record.get('rolledBack'):raise RuntimeError('Migration is not active')
    backup=P(record['plan']['backup'])
    with backup.open('rb') as f:
        if hashlib.file_digest(f,'sha256').hexdigest()!=record['backupSha256']:raise RuntimeError('Archive checksum mismatch')
    verify_archived_originals(record)
    for move,copy in zip(record['switched'],record['copied']):
        source=P(move['source']);old=P(move['old']);dest=P(move['destination'])
        if not source.is_symlink() or source.resolve()!=dest.resolve():raise RuntimeError('Source link changed')
        if not old.exists():continue
        digest=hashlib.sha256(json.dumps(manifest(old),sort_keys=True).encode()).hexdigest()
        # The archive check above validates every durable byte even if SQLite rebuilt a -shm index.
        if digest!=copy['manifestSha256']:record['sqliteTransientIndexChanged']=True
        verify_databases(dest)
    for move in record['switched']:
        old=P(move['old'])
        if old.exists():remove_tree(old)
    record['finalized']=True;receipt.write_text(json.dumps(record,indent=2))
    print('Verified originals removed; relocated data and complete archive retained.')

if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('--plan');a.add_argument('--receipt');a.add_argument('--rollback');a.add_argument('--finalize');a.add_argument('--resume');args=a.parse_args()
    if args.resume:complete_migration(json.loads(P(args.resume).read_text()),P(args.resume))
    elif args.finalize:finalize(P(args.finalize))
    elif args.rollback:rollback(P(args.rollback))
    else:migrate(json.loads(P(args.plan).read_text()),P(args.receipt))
