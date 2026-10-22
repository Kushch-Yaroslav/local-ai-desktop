// Opt-in real Qwen3.6. Read-only installed GGUF, owned server, temporary project/runtime.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve,join} from 'node:path';
import {_electron} from 'playwright-core';
const binary=process.env.LOCAL_AI_TEST_LLAMA_SERVER??resolve('../llama.cpp/build-cuda/bin/llama-server');
const model=process.env.LOCAL_AI_TEST_QWEN_GGUF??resolve('../llama-models/Qwen3.6-35B-A3B-Q4_K_M/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf');
await stat(binary);await stat(model);
const free=Number(execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim());assert(free>22000,'Need 22000 MiB free; never unload an existing user model');
const root=await mkdtemp('/tmp/lad-visual-real-qwen-'),project=await mkdtemp('/tmp/lad-visual-real-qwen-project-'),id='qwen3.6:35b-a3b-ud-q4_k_m';
const source=`<!doctype html><style>body{margin:20px;font:16px sans-serif}.checkout{display:block;width:60px;overflow:hidden;white-space:nowrap;margin:20px 0}#unrelated{position:absolute;top:320px;left:20px}</style><button id="checkout" class="checkout">Complete purchase securely</button><button id="second" class="checkout">Continue shopping now</button><p id="unrelated">Independent text on a different row</p>`;
await writeFile(join(project,'index.html'),source);
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const fd=openSync(join(root,'llama-server.log'),'w');
const args=['-m',model,'--alias',id,'--host','127.0.0.1','--port',String(port),'--ctx-size','32768','--parallel','1','--gpu-layers','999','--n-cpu-moe','4','--threads','8','--threads-batch','8','--batch-size','512','--ubatch-size','128','--flash-attn','on','--cache-type-k','f16','--cache-type-v','f16','--jinja','--fit','off','--no-warmup','--spec-type','none'];
const server=spawn(binary,args,{stdio:['ignore',fd,fd]});let app,result={result:'INTERRUPTED',root,project,model,provider:'real Qwen3.6-35B-A3B, Vision Off',serverPid:server.pid};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const began=Date.now();for(;;){assert.equal(server.exitCode,null,'Owned llama-server failed');try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{ /* starting */ }assert(Date.now()-began<180000,'Owned server startup timeout');await sleep(500);}
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_TEST_MODEL_ID:id,LOCAL_AI_AGENT_ENDPOINT:`http://127.0.0.1:${port}/v1/chat/completions`}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();const chat=await app.evaluate(()=>global.visualFixture.chat);
 await ui.evaluate(({chat,id})=>window.localAi.conversations.update(chat,{modelId:id,contextWindow:32768}),{chat,id});
 await ui.evaluate(chat=>window.localAi.visualDebug.open(chat,'index.html?currency=UAH#/shop?sort=price'),chat);
 const before=await app.evaluate(()=>global.visualFixture.info());const area=await ui.evaluate(async chat=>{const d=await window.localAi.visualDebug.command(chat,{action:'new-area'});const area=d.issues.at(-1);await window.localAi.visualDebug.command(chat,{action:'selection',enabled:true,groupId:area.id});return area;},chat);
 await app.evaluate(()=>global.visualFixture.drag('#checkout'));
 let document;for(let i=0;i<100;i++){document=await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat);if(document.regions.length)break;await sleep(100);}assert.equal(document.regions[0].anchors[0].selector,'#checkout');assert(document.regions[0].anchors[0].findings.some(f=>f.category==='text-clipping'));assert(!document.regions[0].anchors[0].findings.some(f=>f.category==='element-overlap'));
 await ui.evaluate(chat=>window.localAi.visualDebug.command(chat,{action:'selection',enabled:false}),chat);
 const spec={target:'/index.html?currency=UAH#/shop?sort=price',viewport:'desktop',preconditions:[],required_state:[],steps:[],assertion:{source:'layout',operator:'equals',expected:0},timeout_ms:6000};
 const prompt=`Fix the selected checkout button's text clipping in this temporary project. DOM evidence says scrollWidth > clientWidth, width 60px, overflow hidden; the independent text is on a different Y row and is not overlapping. Confirm the implementation by reading index.html; fix the shared .checkout rule so both existing buttons are readable, preserving their text and #unrelated. No terminal, installations, other browsers, new projects, or Vision. Keep the full selected URL including ?currency=UAH#/shop?sort=price. Use existing file tools and web_project. Register exactly one deliverable id ${area.id}, check browser, with criterion id layout, kind runtime, description Readable buttons on the selected hash route, scenario ${JSON.stringify(spec)}. Mark implemented after the fix, run web_project action qa scenario_refs [{"deliverable_id":"${area.id}","criterion_id":"layout"}], then verify with fresh evidence IDs. Finish briefly in Russian: state the root cause (clipping vs overlap), actual verification, and that Vision was Off.`;
 await ui.evaluate(({chat,id,prompt,regions})=>{window.__realVisualEvents=[];window.__realVisualDone=false;window.localAi.chat.onStream(e=>{window.__realVisualEvents.push(e);if(e.type==='approval-request')void window.localAi.chat.approve({conversationId:e.conversationId,generationId:e.generationId,approvalId:e.approval.approvalId,decision:'once'});});window.localAi.chat.send({conversationId:chat,model:id,mode:'agent',generationId:'visual-real-qwen',persistUserMessage:true,messages:[{id:'visual-real-user',conversationId:chat,role:'user',content:prompt,regionReferences:regions,createdAt:new Date().toISOString()}]}).catch(e=>{window.__realVisualError=String(e);}).finally(()=>{window.__realVisualDone=true;});},{chat,id,prompt,regions:document.regions});
 const started=Date.now();let events=[];for(;;){const current=await ui.evaluate(()=>({events:window.__realVisualEvents,done:window.__realVisualDone,error:window.__realVisualError}));events=current.events;assert(!current.error,current.error);const error=events.find(e=>e.type==='error');assert(!error,JSON.stringify(error));if(current.done)break;assert(Date.now()-started<300000,'Real Qwen run timed out');await sleep(250);}
 const after=await app.evaluate(()=>global.visualFixture.info());assert.equal(after.id,before.id);assert.equal(after.ownership,'user');assert(events.some(e=>e.type==='done'));
 const fixed=await readFile(join(project,'index.html'),'utf8');assert.notEqual(fixed,source);assert(fixed.includes('Independent text on a different row'));
 const doc=await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat);const issue=doc.issues.find(i=>i.id===area.id);assert.equal(issue.status,'Verified',JSON.stringify(issue));
 const geometry=await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>Array.from(globalThis.document.querySelectorAll('button')).map(e=>({clientWidth:e.clientWidth,scrollWidth:e.scrollWidth}))));assert(geometry.every(g=>g.scrollWidth<=g.clientWidth+1));
 const final=events.filter(e=>e.type==='token').map(e=>e.content).join('');assert(/обрез|clipp/i.test(final),final);
 result={...result,result:'PASS',wallSeconds:(Date.now()-started)/1000,issue,geometry,final};await writeFile(join(root,'events.json'),JSON.stringify(events,null,2));console.log(JSON.stringify(result));
}catch(error){result={...result,result:'FAIL',error:String(error)};if(app){try{await writeFile(join(root,'events.json'),JSON.stringify(await app.evaluate(()=>window.__realVisualEvents),null,2));}catch{ /* preserve original failure */ }}throw error;}
finally{await app?.close();if(server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),sleep(5000)]);if(server.exitCode===null)server.kill('SIGKILL');}closeSync(fd);result.serverStopped=server.exitCode!==null||server.signalCode!==null;await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));}
