// Read the installed profile, start ONE isolated server, and never write user settings.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,stat} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
const settings=JSON.parse(await readFile(process.env.LOCAL_AI_TEST_PROFILE_CONFIG??resolve('runtime/app-data/runtime-settings.json'),'utf8'));
const profile=settings.models.find(p=>p.id==='qwen3.8:27b-q4_K_M');assert(profile,'Installed Qwen3.8-27B profile is required. No substitution.');
assert.equal(profile.displayName,'Qwen3.8-27B');await stat(profile.modelPath);await stat(settings.llamaServerPath);
const free=Number(execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim());assert(free>22000,'Need a free RTX 3090; do not unload an existing server');
const root=await mkdtemp('/tmp/lad-chat-readonly-qwen-');const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const args=['-m',profile.modelPath,'--alias',profile.id,'--host','127.0.0.1','--port',String(port),'--ctx-size','65536','--parallel','1','--gpu-layers',String(profile.gpuLayers??settings.gpuLayers??999),'--threads','8','--threads-batch','8','--batch-size','512','--ubatch-size','128','--flash-attn','on','--cache-type-k','f16','--cache-type-v','f16','--jinja','--fit','off','--no-warmup','--spec-type','none'];
const log=openSync(join(root,'llama-server.log'),'w',0o600);const child=spawn(settings.llamaServerPath,args,{detached:true,stdio:['ignore',log,log]});await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j)});child.unref();closeSync(log);
const metadata={root,pid:child.pid,port,modelId:profile.id,displayName:profile.displayName,modelPath:profile.modelPath,binary:settings.llamaServerPath,args,contextWindow:65536,kvCacheType:'f16',speculative:'none (isolated test launch only; user profile unchanged)'};
await writeFile(join(root,'server.json'),JSON.stringify(metadata,null,2),{mode:0o600});await writeFile('/tmp/lad-chat-readonly-qwen-current.json',JSON.stringify(metadata),{mode:0o600});console.log(JSON.stringify({root,pid:child.pid,port,model:profile.displayName,context:65536,kv:'f16'}));
