// Real GPU integration, isolated profile/port; never starts or stops the user's launcher.
import assert from 'node:assert/strict';import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';import {createServer} from 'node:net';
const free=Number(execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim());assert(free>21000,'GPU occupied: refusing a second heavy model');
const root=await mkdtemp(join(tmpdir(),'lad-launcher-real-'));process.env.LOCAL_AI_RUNTIME_ROOT=root;
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));process.env.LOCAL_AI_LLAMA_PORT=String(port);
const config=JSON.parse(await readFile('runtime/app-data/runtime-settings.json','utf8'));const profile=config.models.find(m=>/Artemis-31B/i.test(m.displayName));assert(profile);const alternate={...profile,id:'custom:54fee245-c190-4bc4-8d83-548e6c274b19',displayName:'Isolated Artemis alias'};
await mkdir(join(root,'app-data'),{recursive:true});await writeFile(join(root,'app-data/runtime-settings.json'),JSON.stringify({...config,models:[profile,alternate]}));
const require=createRequire(import.meta.url),{ensureAppDirectories}=require('../dist/main/services/paths.js');ensureAppDirectories();
const {startRuntimeSupervisor,stopRuntimeSupervisor}=require('../dist/main/services/runtime-supervisor.js'),{LlamaRuntimeController}=require('../dist/main/services/llama-runtime-controller.js');
const files={stateFile:join(root,'llama-cpp-runtime-state.json'),requestFile:join(root,'llama-cpp-runtime-request.env'),launcherPidFile:join(root,'llama-cpp-mtp-launcher.pid')};
await writeFile(files.stateFile,JSON.stringify({status:'ready',modelId:profile.id,contextWindow:57344,launcherPid:999999,serverPid:999998}));
const control=new LlamaRuntimeController(files,180000,{ensureLauncher:startRuntimeSupervisor});const steps=[];const started=Date.now();
async function load(context,kv,offload,force=false,id=profile.id){const begin=Date.now();const result=await control.switchTo(id,context,kv,offload,undefined,'off',force);assert(result.ok,JSON.stringify(result));assert.equal(result.state.contextWindow,context);assert.equal(result.state.kvCacheType,kv);assert.equal(result.state.kvOffload,offload);assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).ok,true);steps.push({modelId:id,context,kv,offload,force,pid:result.state.serverPid,ms:Date.now()-begin});console.log(JSON.stringify(steps.at(-1)));return result.state;}
try {
 assert.equal((await control.state()).status,'offline');
 const first=await load(4096,'q8_0',true);
 const dup=await Promise.all([control.switchTo(profile.id,4096,'q8_0',true,undefined,'off'),control.switchTo(profile.id,4096,'q8_0',true,undefined,'off')]);assert(dup.every(x=>x.ok&&x.state.serverPid===first.serverPid));
 const restart=await load(4096,'q8_0',true,true);assert.notEqual(restart.serverPid,first.serverPid);
 let changed=await load(8192,'f16',false);assert.notEqual(changed.serverPid,restart.serverPid);
 const args=(await readFile(`/proc/${changed.serverPid}/cmdline`,'utf8')).split('\0');assert(args.includes(String(port)));assert(args.includes('--no-kv-offload'));assert.equal(args[args.indexOf('--cache-type-k')+1],'f16');assert.equal(args[args.indexOf('--ctx-size')+1],'8192');
 changed=await load(4096,'q8_0',true,false,alternate.id);const models=await(await fetch(`http://127.0.0.1:${port}/v1/models`)).json();assert(models.data.some(m=>m.id===alternate.id));
 process.kill(changed.serverPid,'SIGKILL');await new Promise(r=>setTimeout(r,1600));assert.equal((await control.state()).status,'offline');
 await load(4096,'q8_0',true);
 assert((await control.unload()).ok);
 const bad=join(root,'failed-server');await writeFile(bad,'#!/bin/sh\nexit 17\n',{mode:0o755});await writeFile(join(root,'app-data/runtime-settings.json'),JSON.stringify({...config,llamaServerPath:bad,models:[profile,alternate]}));
 const failure=await control.switchTo(profile.id,4096,'q8_0',true,undefined,'off');assert(!failure.ok);steps.push({startupFailure:failure.error,status:failure.state.status});
 await writeFile(join(root,'app-data/runtime-settings.json'),JSON.stringify({...config,models:[profile,alternate]}));await load(4096,'q8_0',true);
 console.log('PASS real offline → ready, duplicate Load, force restart, context/KV, crash/recovery, startup failure/recovery');
}finally {await stopRuntimeSupervisor();await writeFile(join(root,'result.json'),JSON.stringify({root,port,model:profile.displayName,elapsedMs:Date.now()-started,steps},null,2));console.log('Artifacts '+root);}
