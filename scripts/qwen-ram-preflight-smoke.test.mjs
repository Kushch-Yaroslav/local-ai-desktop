// One real 64K load, using an unchanged copy of the existing personal profile.
// Opt-in GPU test; no benchmark matrix or writes to the user's configuration.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {execFileSync} from 'node:child_process';
import {_electron} from 'playwright-core';
assert.equal(process.env.LOCAL_AI_RAM_GPU_SMOKE,'1','Explicit GPU smoke opt-in required');
const settings=resolve('runtime/app-data/runtime-settings.json'),before=await readFile(settings,'utf8'),config=JSON.parse(before);
const id='custom:e58faa02-8fe3-4217-9c3d-da322326cedc',profile=config.models.find(m=>m.id===id);assert(profile);
assert.equal(profile.advanced.expertCacheMiB,16384);assert.equal(profile.defaults.contextWindow,65536);assert.equal(profile.advanced.loadMode,'mmap');
const free=Number(execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8',timeout:3000}).trim());assert(free>22518,'Refuse GPU pressure or another large model');
const root=await mkdtemp('/tmp/lad-ram-preflight-');await mkdir(join(root,'app-data'));
await writeFile(join(root,'app-data/runtime-settings.json'),JSON.stringify({...config,models:[profile]}));
const sock=createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
let app,page,chat,pid,timer,watchdog,busy=false,failure='';const result={status:'RUNNING',root,profileId:id,samples:[]};
async function sample(){if(busy)return;busy=true;try{
 const mem=await readFile('/proc/meminfo','utf8'),vm=await readFile('/proc/vmstat','utf8');
 const row={at:new Date().toISOString(),availableBytes:Number(/^MemAvailable:\s+(\d+)/m.exec(mem)[1])*1024,pswpout:Number(/^pswpout (\d+)/m.exec(vm)[1])};
 if(row.availableBytes<7*1024**3)throw Error('RAM reserve violated');
 if(pid){const status=await readFile(`/proc/${pid}/status`,'utf8'),cg=(await readFile(`/proc/${pid}/cgroup`,'utf8')).trim().split(':').at(-1);const k=n=>Number(new RegExp('^'+n+':\\s+(\\d+)','m').exec(status)?.[1]??0)*1024;Object.assign(row,{rssBytes:k('VmRSS'),anonBytes:k('RssAnon'),fileBytes:k('RssFile'),processSwapBytes:k('VmSwap'),cgroupBytes:Number(await readFile('/sys/fs/cgroup'+cg+'/memory.current','utf8')),cgroupMaxBytes:Number(await readFile('/sys/fs/cgroup'+cg+'/memory.max','utf8')),cgroupSwapMax:(await readFile('/sys/fs/cgroup'+cg+'/memory.swap.max','utf8')).trim(),events:(await readFile('/sys/fs/cgroup'+cg+'/memory.events','utf8')).trim()});assert.equal(row.processSwapBytes,0);assert.equal(row.cgroupSwapMax,'0');assert(row.cgroupMaxBytes<=55*1024**3);row.gpuUsedMiB=Number(execFileSync('nvidia-smi',['--query-gpu=memory.used','--format=csv,noheader,nounits'],{encoding:'utf8',timeout:2000}).trim());}
 result.samples.push(row);
 }catch(e){failure=String(e);if(app)void app.close();}finally{busy=false;}}
try{
 await sample();assert(!failure,failure);
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:['--disable-gpu',resolve('dist/main/index.js')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_LLAMA_PORT:String(port)}});
 timer=setTimeout(()=>{failure='bounded smoke timeout';void app.close();},180000);watchdog=setInterval(()=>void sample(),2000);
 page=await app.firstWindow();page.setDefaultTimeout(30000);
 await page.locator('.runtime-setup-action:not([disabled])').waitFor();await page.locator('.runtime-setup-action').click();await page.locator('.runtime-model-select').filter({hasText:profile.displayName}).click();await page.getByRole('button',{name:/^(Advanced|Расширенный режим)$/}).click();await page.locator('.host-memory-budget').waitFor();result.hostUi=await page.locator('.host-memory-budget').innerText();assert.equal(await page.locator('.host-memory-budget [role="alert"]').count(),0);
 assert.equal(await page.locator('[aria-label="Expert cache budget"], [aria-label="Размер кэша экспертов"]').inputValue(),'16384');assert.equal(await page.locator('[aria-label="Profile context"], [aria-label="Контекст профиля"]').inputValue(),'65536');
 await page.locator('.runtime-setup-header-actions > button').click();
 chat=await page.evaluate(async id=>(await window.localAi.conversations.create(id)).id,id);
 const loaded=await page.evaluate(({chat,id})=>window.localAi.runtime.control({action:'restart',conversationId:chat,modelId:id}),{chat,id});const state=loaded.llamaRuntime;assert.equal(state.status,'ready',JSON.stringify(state));pid=state.serverPid;assert(state.placement.expertCacheMiB>16000);assert.equal(state.contextWindow,65536);assert(state.placement.kvMiB.CUDA0>=816);result.placement=state.placement;result.arguments=state.launchArguments;
 await sample();assert(!failure,failure);
 const res=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:id,messages:[{role:'user',content:'Reply with only the word ready.'}],max_tokens:16,temperature:0}),signal:AbortSignal.timeout(60000)});assert(res.ok,await res.clone().text());const answer=await res.json();assert(answer.choices[0].message.content);result.generation={completed:true,usage:answer.usage};await sample();assert(!failure,failure);
 const persisted=JSON.parse(await readFile(join(root,'app-data/runtime-settings.json'),'utf8')).models.find(m=>m.id===id);assert.deepEqual(persisted,profile,'Load must preserve profile');result.status='PASS';
} catch(e){result.status='FAILED';result.error=String(e);throw e;} finally {
 clearTimeout(timer);clearInterval(watchdog);if(app){if(pid&&page)await page.evaluate(chat=>window.localAi.runtime.control({action:'unload',conversationId:chat}),chat).catch(()=>{});await app.close().catch(()=>{});}assert.equal(await readFile(settings,'utf8'),before,'Personal profile changed');result.safetyFailure=failure||undefined;await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,root,error:result.error}));
}
