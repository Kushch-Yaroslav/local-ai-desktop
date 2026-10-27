// Real TS edits and hard termination/restart of the real Rust worker; tiny files only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,stat,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
const root=await mkdtemp('/tmp/lad-edit-backups-');process.env.LOCAL_AI_RUNTIME_ROOT=join(root,'app');
const require=createRequire(import.meta.url);const {ReadonlyProjectTools}=require('../dist/main/tools/project-tools.js');const {paths,ensureAppDirectories}=require('../dist/main/services/paths.js');ensureAppDirectories();
const {atomicProjectWrite}=require('../dist/main/tools/project-path.js');
const a=join(root,'project-a'),b=join(root,'project-b');await mkdir(join(a,'nested'),{recursive:true});await mkdir(b);
const signal=new AbortController().signal,approve=async()=>({approved:true,reason:'once'});
const tools=await ReadonlyProjectTools.open(a,approve),other=await ReadonlyProjectTools.open(b,approve);
const call=async(tool,name,args)=>JSON.parse(await tool.execute({name,arguments:args},signal,'backup-fixture'));
const created=await call(tools,'create_file',{path:'nested/same.txt',content:'original'});assert(created.created);assert(created.backup.startsWith(paths.userData));assert(!JSON.parse(await readFile(join(created.backup,'manifest.json'))).existed);
await chmod(join(a,'nested/same.txt'),0o751);
const edit=await call(tools,'apply_patch',{patch:'*** Begin Patch\n*** Update File: nested/same.txt\n@@\n-original\n+edited\n*** End Patch'});assert(edit.applied,JSON.stringify(edit));const snapshot=edit.backups[0];assert.equal(await readFile(join(snapshot,'original'),'utf8'),'original');
const invalid=await call(tools,'apply_patch',{patch:'*** Begin Patch\n*** Update File: nested/same.txt\n@@\n-no-match\n+bad\n*** End Patch'});assert(invalid.error);assert.equal(await readFile(join(a,'nested/same.txt'),'utf8'),'edited');
const parallel=await Promise.all(['one.txt','two.txt'].map(path=>call(tools,'create_file',{path,content:'parallel'})));assert(parallel.every(r=>r.created));assert.notEqual(parallel[0].backup,parallel[1].backup);
const otherCreated=await call(other,'create_file',{path:'same.txt',content:'other'});assert.notEqual(resolve(otherCreated.backup,'../..'),resolve(snapshot,'../..'));
// Recovery bytes are durable and restore the original mode through the existing atomic writer.
const manifest=JSON.parse(await readFile(join(snapshot,'manifest.json')));const bytes=await readFile(join(snapshot,'original'));assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);await atomicProjectWrite(join(a,'nested/same.txt'),bytes.toString());await chmod(join(a,'nested/same.txt'),manifest.mode);assert.equal((await stat(join(a,'nested/same.txt'))).mode&0o777,0o751);
const cancelled=new AbortController();cancelled.abort();assert((JSON.parse(await tools.execute({name:'create_file',arguments:{path:'cancelled.txt',content:'bad'}},cancelled.signal,'cancel'))).error);

let actions=[],index=0,worker;
const provider=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const action=actions[index++];res.writeHead(200,{'content-type':'text/event-stream'});const delta=action?{tool_calls:[{index:0,id:'backup-'+index,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:'Edited the fixture.'};res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:action?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const storage=join(paths.userData,'edit-backups');
async function crashAfterEdit(content){
 actions=[['read_file',{path:'nested/same.txt'}],['write_file',{path:'nested/same.txt',content}]];index=0;
 worker=spawn(resolve('rust-agent/target/debug/local-ai-agent-runtime'),[],{stdio:['pipe','pipe','pipe'],env:{...process.env,LOCAL_AI_EDIT_BACKUP_ROOT:storage,LOCAL_AI_EDIT_TASK:'persistent-logical-task'}});
 const exit=once(worker,'exit');const lines=createInterface({input:worker.stdout});let backup;
 const watchdog=setTimeout(()=>worker.kill('SIGKILL'),15000);
 worker.stdin.write(JSON.stringify({type:'run',run_id:'backup-'+content,endpoint:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,model:'fixture',system:'Use the provided project file tools.',user:'Read and modify nested/same.txt as requested, preserving recoverable preimages.',project_root:a,context_limit:65536,reasoning_mode:'fast',supports_reasoning:false,web_mode:'off',browser_qa:false,policy:'auto',permissions:{mode:'autonomous',trusted_roots:[]},approval_ui:false,history:[]})+'\n');
 for await(const line of lines){const event=JSON.parse(line);if(event.type==='tool_result'&&event.name==='write_file'){const result=JSON.parse(event.content);assert(result.backup,JSON.stringify(result));backup=result.backup;worker.kill('SIGKILL');break;}if(event.type==='agent_error')throw Error(event.message);}
 clearTimeout(watchdog);await exit;assert(backup,'Rust edit must finish before deliberate worker crash');assert.equal(await readFile(join(a,'nested/same.txt'),'utf8'),content);return backup;
}
try{
 const first=await crashAfterEdit('rust-first');assert.equal(await readFile(join(first,'original'),'utf8'),'original');const second=await crashAfterEdit('rust-second');assert.equal(await readFile(join(second,'original'),'utf8'),'rust-first');assert.equal(await readFile(join(first,'original'),'utf8'),'original');
 for(const project of [a,b])assert(!(await readdir(project,{recursive:true})).some(path=>path.split('/').includes('.local-ai-backups')),'No edit backups in source directories');
 console.log(JSON.stringify({result:'PASS',root,checks:['TS create/edit/invalid edit/concurrent operations','distinct project identity','preimage hash and permissions','cancel before edit','real Rust worker hard crash and restart retains both generations','no .local-ai-backups in either project']}));
}finally{if(worker?.exitCode===null)worker.kill('SIGKILL');provider.closeAllConnections();await new Promise(r=>provider.close(r));}
