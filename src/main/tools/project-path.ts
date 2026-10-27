import { lstat, realpath, readFile, mkdir, open, rename, unlink, link, chmod, stat } from 'node:fs/promises';
import { dirname, resolve, relative, sep, parse } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import {constants} from 'node:fs';
import {paths} from '../services/paths';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { protectedInfrastructurePaths } from '../services/protected-runtime';
const execFileAsync = promisify(execFile);

export class PathPolicyError extends Error { readonly code = 'PERMISSION_DENIED'; readonly retrySameArguments = false; }
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !parse(rel).root; };
const protectedPart = (path: string) => path.split(sep).some(part => part === '.git' || part === '.local-ai-backups') || inside(resolve(paths.userData,'edit-backups'),path);

export async function projectPath(root: string, input: string, writing = false): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, input);
  if (!inside(canonicalRoot, candidate) || protectedPart(candidate)) throw new PathPolicyError('Path is outside the workspace or protected repository/recovery metadata. Use an approved Git command for repository operations.');
  let current = candidate; const missing: string[] = [];
  while (true) {
    try {
      const metadata = await lstat(current);
      if (writing && metadata.isSymbolicLink()) throw new PathPolicyError('Write destination must not be a symlink');
      current = await realpath(current); break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current); if (parent === current) throw error;
      missing.unshift(current.slice(parent.length + 1)); current = parent;
    }
  }
  const target = resolve(current, ...missing);
  if (writing && protectedInfrastructurePaths().some(path => inside(path, target))) {
    throw new PathPolicyError('PROTECTED_RUNTIME_PROCESS: application runtime files are protected. Use dedicated application controls.');
  }
  if (!inside(canonicalRoot, target) || protectedPart(target)) throw new PathPolicyError('Resolved destination escapes the workspace or targets protected metadata.');
  // Inspect all ancestors, including existing Git worktree pointer files.
  for (let parent = candidate; ; parent = dirname(parent)) {
    const marker = resolve(parent, '.git');
    let metadata: string | undefined;
    try {
      const info = await lstat(marker);
      metadata = info.isDirectory() || info.isSymbolicLink() ? await realpath(marker) : undefined;
      if (info.isFile()) { const text = await readFile(marker, 'utf8'); if (text.startsWith('gitdir: ')) metadata = await realpath(resolve(parent, text.slice(8).trim())); }
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    if (metadata) {
      if (inside(metadata, target)) throw new PathPolicyError('Git worktree metadata is protected. Use an approved Git command.');
      const common = await readFile(resolve(metadata, 'commondir'), 'utf8').then(text => realpath(resolve(metadata!, text.trim()))).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (common && inside(common, target)) throw new PathPolicyError('Shared Git worktree metadata is protected. Use an approved Git command.');
    }
    const hasBareLayout = await Promise.all(['HEAD', 'objects', 'refs'].map(path => lstat(resolve(parent, path)).then(() => true, () => false)));
    if (hasBareLayout.every(Boolean)) {
      const bare = await execFileAsync('/usr/bin/git', ['-C', parent, 'rev-parse', '--is-bare-repository'], { timeout: 2000 }).then(result => result.stdout.trim() === 'true', () => false);
      if (bare && inside(parent, target)) throw new PathPolicyError('Bare Git repository metadata is protected. Use an approved Git command.');
    }
    if (parent === dirname(parent)) break;
  }
  if (writing) {
    // Reject directory symlinks too; do not create a temporary file through one.
    for (let parent = candidate; inside(canonicalRoot, parent) && parent !== canonicalRoot; parent = dirname(parent)) {
      try { if ((await lstat(parent)).isSymbolicLink()) throw new PathPolicyError('Write destination has a symlink component'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return target;
}

async function privateDirectory(directory:string):Promise<void>{
  const parent=dirname(directory);if(parent!==directory)await privateDirectory(parent);
  try{const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new PathPolicyError('Recovery storage must not contain symlinks');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;try{await mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new PathPolicyError('Recovery storage changed');const parentHandle=await open(parent,'r');try{await parentHandle.sync();}finally{await parentHandle.close();}}
}
export async function snapshotFile(target:string,projectRoot:string):Promise<string>{
  const project=await realpath(projectRoot),directory=resolve(paths.userData,'edit-backups');
  if(inside(project,directory))throw new PathPolicyError('Edit backup storage must be outside the project');
  const key=createHash('sha256').update(project).digest('hex');
  const backup=resolve(directory,key,'legacy',randomUUID());await privateDirectory(backup);
  const info=await lstat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return undefined;});
  let hash:string|undefined;
  if(info){
    if(!info.isFile()||info.isSymbolicLink())throw new PathPolicyError('Preimage target must be a regular file');
    const source=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const data=await source.readFile(),after=await source.stat();if(after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw new PathPolicyError('Source changed during preimage capture');const output=await open(resolve(backup,'original'),'wx',0o600);try{await output.writeFile(data);await output.sync();}finally{await output.close();}hash=createHash('sha256').update(data).digest('hex');}finally{await source.close();}
  }
  const manifest=await open(resolve(backup,'manifest.json'),'wx',0o600);
  try{await manifest.writeFile(JSON.stringify({application:'local-ai-desktop',version:1,project,task:'legacy',target,existed:Boolean(info),preimage:'original',sha256:hash,mode:info?.mode}));await manifest.sync();}finally{await manifest.close();}
  for(const path of [backup,dirname(backup)]){const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}}
  return backup;
}

export async function atomicProjectWrite(target: string, content: string, createOnly = false): Promise<void> {
  const temporary = resolve(dirname(target), `.local-ai-stage-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    const mode = await stat(target).then(info => info.mode).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return 0o644; });
    await file.writeFile(content); await file.sync(); await chmod(temporary, mode); await file.close();
    if (createOnly) await link(temporary, target); else await rename(temporary, target);
  } finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}
