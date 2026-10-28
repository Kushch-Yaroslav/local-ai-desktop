// Snapshot the working tree, never the index. Builds cannot replace live source
// executables, and user runtime state/model files never enter the source archive.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, lstat, chmod, symlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
const root=resolve('.');
const snapshotOnly=process.argv.includes('--snapshot-only');
const candidate=process.argv.find(arg=>arg.startsWith('--candidate='))?.slice('--candidate='.length);
if(candidate && !/^RC[1-9][0-9]*$/.test(candidate))throw Error('Candidate must be RC followed by a positive integer');
const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(!snapshotOnly && metadata.version!=='0.3.0')throw Error('RC build requires reviewed 0.3.0 metadata');
const directory=join(root,'release',`${candidate?.toLowerCase() ?? 'rc'}-v${metadata.version}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
const source=join(directory,'source');await mkdir(source,{recursive:true});
const git=(...args)=>execFileSync('git',args,{cwd:root});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const entries=[...new Set(git('ls-files','-z','--cached','--others','--exclude-standard').toString().split('\0').filter(Boolean))].sort();
const files=[],excluded=[],deleted=[];
for(const name of entries){
  if(name.startsWith('runtime/') || /\.(?:gguf|db|db-wal|db-shm)$/i.test(name)){excluded.push(name);continue;}
  const from=join(root,name),to=join(source,name);let stat;
  try{stat=await lstat(from);}catch(error){if(error.code==='ENOENT'){deleted.push(name);continue;}throw error;}
  if(!stat.isFile())throw Error(`Non-regular source entry needs review: ${name}`);
  const bytes=await readFile(from);files.push({path:name,sha256:sha(bytes),mode:stat.mode&0o777});
  await mkdir(dirname(to),{recursive:true});await copyFile(from,to);await chmod(to,stat.mode&0o777);
}
const head=git('rev-parse','HEAD').toString().trim();
const epoch=git('show','-s','--format=%ct','HEAD').toString().trim();
const toolchain={node:process.version,npm:execFileSync('npm',['--version']).toString().trim(),rustc:execFileSync('rustc',['--version']).toString().trim(),cargo:execFileSync('cargo',['--version']).toString().trim(),electron:(await readFile(join(root,'node_modules/electron/dist/version'),'utf8')).trim(),electronBuilder:JSON.parse(await readFile(join(root,'node_modules/electron-builder/package.json'),'utf8')).version};
const sourceHash=sha(JSON.stringify(files));
const info={...(candidate ? {candidate} : {}),version:metadata.version,baseRevision:head,sourceManifestSha256:sourceHash,sourceDateEpoch:epoch,toolchain,dirtyWorkingTree:true};
await writeFile(join(directory,'source-manifest.json'),JSON.stringify({...info,files,excluded,deleted},null,2)+'\n');
await writeFile(join(source,'BUILD_INFO.json'),JSON.stringify(info,null,2)+'\n');
await writeFile(join(directory,'index-before.sha256'),sha(git('ls-files','--stage','-z'))+'\n');
await writeFile(join(directory,'working-tree-status.txt'),git('status','--short'));
execFileSync('tar',['--sort=name',`--mtime=@${epoch}`,'--owner=0','--group=0','--numeric-owner','-czf',join(directory,'source.tar.gz'),'-C',source,'.']);
await symlink(join(root,'node_modules'),join(source,'node_modules'),'dir');
console.log(`RC_DIRECTORY=${directory}`);
console.log(`SOURCE_MANIFEST_SHA256=${sourceHash}`);
if(!snapshotOnly){
 const child=spawn('npm',['run','package:linux'],{cwd:source,env:{...process.env,SOURCE_DATE_EPOCH:epoch},stdio:'inherit'});
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
 if(code!==0)throw Error(`Candidate build failed (${code}); source snapshot retained at ${directory}`);
 const artifact=join(source,'release',`local-ai-desktop_${metadata.version}_amd64.deb`);
 const bytes=await readFile(artifact);
 await writeFile(join(directory,'SHA256SUMS'),`${sha(bytes)}  source/release/local-ai-desktop_${metadata.version}_amd64.deb\n`);
 console.log(`RC_ARTIFACT=${artifact}\nRC_SIZE=${bytes.length}\nRC_SHA256=${sha(bytes)}`);
}
