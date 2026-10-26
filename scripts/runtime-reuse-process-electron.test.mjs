// Real Electron IPC + production launcher + temporary HTTP model-server process.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {_electron} from 'playwright-core';

const root=await mkdtemp('/tmp/lad-runtime-reuse-process-'),modelsPath=join(root,'models');
await mkdir(modelsPath);await mkdir(join(root,'app-data'));
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const str=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
const modelPath=join(modelsPath,'fixture.gguf'),id='custom:123e4567-e89b-42d3-a456-426614174099';
const entries={'general.architecture':'llama','llama.context_length':65536,'llama.block_count':1,'tokenizer.chat_template':'{% if tools %}tools{% endif %}'};
await writeFile(modelPath,Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(Object.keys(entries).length),...Object.entries(entries).flatMap(([k,v])=>[str(k),u32(typeof v==='string'?8:4),typeof v==='string'?str(v):u32(v)])]));
const binary=join(root,'fixture-server.cjs');
await writeFile(binary,`#!/usr/bin/env node
const http=require('node:http'),fs=require('node:fs');
const args=process.argv.slice(2),get=(key,fallback)=>args[args.indexOf(key)+1]||fallback;
if(args.includes('--help')||args.includes('--version')){console.log('--model --ctx-size --port --alias --fit --threads --threads-batch --batch-size --ubatch-size --flash-attn --load-mode --cache-type-k --cache-type-v --kv-offload --gpu-layers');process.exit(0);}
const ctx=Number(get('--ctx-size','32768')),alias=get('--alias','fixture'),kv=get('--cache-type-k','f16');
fs.appendFileSync(${JSON.stringify(join(root,'launches.jsonl'))},JSON.stringify({pid:process.pid,args})+'\\n');
console.log('llama_kv_cache: size = 1 MiB K ('+kv+'): 1 MiB V ('+kv+'): 1 MiB');
setTimeout(()=>http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/v1/models'?{data:[{id:alias,meta:{n_ctx:ctx,n_ctx_train:65536,size:128}}]}:req.url==='/props'?{default_generation_settings:{n_ctx:ctx},total_slots:1}:{status:'ok'}));}).listen(Number(get('--port','8081')),'127.0.0.1'),500);
`,{mode:0o700});
const config={schemaVersion:2,llamaServerPath:binary,llamaServerInput:binary,modelsPath,models:[{id,displayName:'Reuse process fixture',modelPath,mmprojPath:'',gpuLayers:0,supportsTools:true,toolCallingMode:'auto',speculative:'none',mtpMode:'off',builtin:false,defaults:{contextWindow:32768,kvCacheType:'f16',kvOffload:true}}],setupDismissed:true,language:'en'};
await writeFile(join(root,'app-data/runtime-settings.json'),JSON.stringify(config));
const portProbe=createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
const env={...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_APP_DIR:resolve('.'),LOCAL_AI_LLAMA_PORT:String(port),LOCAL_AI_LLAMA_CPP_URL:`http://127.0.0.1:${port}`,LOCAL_AI_LAUNCHER_MANAGED:'1',LOCAL_AI_LAUNCHER_HEADLESS:'1'};
const launcher=spawn('bash',[resolve('run-local-ai-desktop-llama-cpp-mtp.sh')],{env,stdio:['ignore','pipe','pipe']});let launcherLog='';launcher.stdout.on('data',c=>launcherLog+=c);launcher.stderr.on('data',c=>launcherLog+=c);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<300;i++){if(await fn())return;await delay(100);}throw Error(label+'\n'+launcherLog);}
const state=async()=>{try{return JSON.parse(await readFile(join(root,'llama-cpp-runtime-state.json'),'utf8'));}catch{return {};}};
const launches=async()=>{try{return (await readFile(join(root,'launches.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);}catch{return [];}};
let app;
try{
 await until(async()=>(await state()).status==='idle','Launcher idle');
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:['--disable-gpu',resolve('dist/main/index.js')],env});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();
 const chat=await ui.evaluate(id=>window.localAi.conversations.create(id),id);
 await ui.reload();await ui.locator('.chat-select').first().click();
 await ui.evaluate(({chat,id})=>window.localAi.conversations.update(chat.id,{modelId:id,contextWindow:32768,llamaKvCacheType:'f16',llamaKvOffload:true}),{chat,id});
 await until(async()=>(await state()).status==='ready','First explicit model load');
 const first=await state(),pid=first.serverPid;assert(pid>0);assert.equal((await launches()).length,1);
 const second=await ui.evaluate(()=>window.localAi.conversations.create());await ui.reload();await ui.locator('.chat-select').first().click();
 await ui.evaluate(({second,id})=>window.localAi.conversations.update(second.id,{modelId:id,contextWindow:32768,llamaKvCacheType:'f16',llamaKvOffload:true}),{second,id});
 await ui.reload();await ui.locator('.chat-select').first().click();await ui.getByText('Ready to use',{exact:true}).waitFor();
 await ui.locator('.composer textarea').fill('Ready without reloading weights');assert(await ui.locator('.send-button:not(.stop)').isEnabled());
 await ui.locator('.chat-select').last().click();await ui.locator('.chat-select').first().click();
 assert.equal((await state()).serverPid,pid);assert.equal((await launches()).length,1);process.kill(pid,0);
 const result={result:'PASS',root,serverPid:pid,launches:await launches(),checks:['Production supervisor health/context/KV confirmation','Two real SQLite chats bind the same fingerprint','One live server PID across chat switching','Ready to use and enabled Composer']};
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({result:'PASS',root,serverPid:pid}));
}catch(error){console.error('Artifacts:',root);throw error;}
finally{await app?.close();launcher.kill('SIGTERM');await new Promise(r=>{if(launcher.exitCode!==null)r();else launcher.once('exit',r);});await writeFile(join(root,'launcher-output.log'),launcherLog);}
