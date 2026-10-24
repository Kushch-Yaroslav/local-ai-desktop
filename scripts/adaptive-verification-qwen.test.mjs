// Opt-in real Qwen3.6. Read-only installed GGUF, owned server, temporary project/runtime.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdtemp,writeFile,readFile,stat,symlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve,join} from 'node:path';
import {createServer as createViteServer} from 'vite';
import react from '@vitejs/plugin-react';
import {_electron} from 'playwright-core';
const binary=process.env.LOCAL_AI_TEST_LLAMA_SERVER??resolve('../llama.cpp/build-cuda/bin/llama-server');
const model=process.env.LOCAL_AI_TEST_QWEN_GGUF??resolve('../llama-models/Qwen3.6-35B-A3B-Q4_K_M/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf');
await stat(binary);await stat(model);
const free=Number(execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim());assert(free>22000,'Need 22000 MiB free; never unload an existing user model');
const root=await mkdtemp('/tmp/lad-adaptive-real-qwen-'),project=await mkdtemp('/tmp/lad-adaptive-real-qwen-project-'),id='qwen3.6:35b-a3b-ud-q4_k_m';
const source='.sticker{border-radius:2px;width:180px;height:54px;background:#792fbb;color:white}.sticker:hover{background:#9459d0}';
await symlink(resolve('node_modules'),join(project,'node_modules'),'dir');
await writeFile(join(project,'index.html'),'<div id="root"></div><script type="module" src="/App.jsx"></script>');
await writeFile(join(project,'App.jsx'),"import React from 'react';import{createRoot}from'react-dom/client';import Card from './Card.jsx';createRoot(document.getElementById('root')).render(<Card/>);");
await writeFile(join(project,'Card.jsx'),"import React from 'react';import s from './Card.module.css';export default function Card(){return <button id=\"checkout\" className={s.sticker}>3 al prezzo di 1</button>}");
await writeFile(join(project,'Card.module.css'),source);
const previewPortServer=createServer();await new Promise(r=>previewPortServer.listen(0,'127.0.0.1',r));const previewPort=previewPortServer.address().port;await new Promise(r=>previewPortServer.close(r));
const vite=await createViteServer({configFile:false,root:project,plugins:[react()],server:{host:'127.0.0.1',port:previewPort,strictPort:true,fs:{allow:[project,resolve('node_modules')]}}});await vite.listen();
const preview=`http://127.0.0.1:${vite.httpServer.address().port}/index.html?currency=EUR#/it/product/1`;
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
 await ui.evaluate(({chat,preview})=>window.localAi.visualDebug.open(chat,preview),{chat,preview});
 assert((await ui.evaluate(chat=>window.localAi.browserQa.status(chat),chat)).autonomous,'Adaptive verification must be on');
 const sid=await app.evaluate(()=>global.visualFixture.entry().state.sessionId);await ui.evaluate(sid=>window.localAi.liveBrowser.workspace(sid,{viewport:{width:1920,height:1080},scale:'fit',pan:{x:0,y:0}}),sid);
 const before=await app.evaluate(()=>global.visualFixture.info());const area=await ui.evaluate(async chat=>{const d=await window.localAi.visualDebug.command(chat,{action:'new-area'});const area=d.issues.at(-1);await window.localAi.visualDebug.command(chat,{action:'selection',enabled:true,groupId:area.id});return area;},chat);
 await app.evaluate(()=>global.visualFixture.drag('#checkout'));
 let document;for(let i=0;i<100;i++){document=await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat);if(document.regions.length)break;await sleep(100);}assert.equal(document.regions[0].anchors[0].selector,'#checkout');assert.equal(document.regions[0].anchors[0].styles['border-radius'],'2px');
 await ui.evaluate(chat=>window.localAi.visualDebug.command(chat,{action:'selection',enabled:false}),chat);
 const prompt=`Correct the selected badge: its corners should have border-radius 28px, currently 2px. This is a temporary React/Vite CSS Modules project. Inspect the real implementation and make a minimal shared CSS change, preserving text and hover. Testing and verification is enabled: choose a proportionate method based on project configuration and available diagnostics; avoid redundant screenshots or full builds for one CSS property. Preserve original URL ${preview} and actual CSS viewport 1920x1080 when checking the affected element. Record completed work in deliverables using EXACTLY id ${area.id} (the existing area, never a new badge ID), text describing the fix and confirmed absolute source paths. Mark it implemented after the actual edit. Work completion is separate from QA Verified. Computed CSS inspection is enough for this task; do not create temporary checker scripts or attempt to obtain a formal Verified label. Use permitted file/browser tools, no installation or other browsers. Finish honestly with evidence and limitations; do not claim multimodal Vision.`;
 await ui.evaluate(()=>{window.__realVisualEvents=[];window.__realVisualDone=false;window.localAi.chat.onStream(e=>{window.__realVisualEvents.push(e);if(['done','error','cancelled'].includes(e.type))window.__realVisualDone=true;if(e.type==='approval-request')void window.localAi.chat.approve({conversationId:e.conversationId,generationId:e.generationId,approvalId:e.approval.approvalId,decision:'once'});});});
 await ui.getByRole('article',{name:`Area ${area.number}`,exact:true}).getByRole('button',{name:'Send to agent',exact:true}).click();
 assert(await ui.locator('.attachment-draft .visual-region-chip').count(),'Structured regions must be visible in composer');
 await ui.locator('.composer textarea').fill(prompt);await ui.locator('.send-button:not(.stop)').click();
 const started=Date.now();let events=[];for(;;){const current=await ui.evaluate(()=>({events:window.__realVisualEvents,done:window.__realVisualDone,error:window.__realVisualError}));events=current.events;assert(!current.error,current.error);const error=events.find(e=>e.type==='error');assert(!error,JSON.stringify(error));if(current.done)break;assert(Date.now()-started<300000,'Real Qwen run timed out');await sleep(250);}
 const after=await app.evaluate(()=>global.visualFixture.info());assert.equal(after.id,before.id);assert.equal(after.ownership,'user');assert(events.some(e=>e.type==='done'));
 const fixed=await readFile(join(project,'Card.module.css'),'utf8');assert.notEqual(fixed,source);
 const doc=await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat);const issue=doc.issues.find(i=>i.id===area.id);
 const geometry=await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>({radius:getComputedStyle(document.querySelector('#checkout')).borderRadius,url:location.href,width:innerWidth})));
 assert.equal(geometry.radius,'28px','Live Native Page must reflect actual Vite CSS');assert.equal(geometry.url,preview);assert.equal(geometry.width,1920);
 assert.equal(issue.workflow?.state,'completed',JSON.stringify(issue));
 const run=await app.evaluate(()=>global.visualFixture.db.listAnalysisRuns(global.visualFixture.chat).at(-1));
 await writeFile(join(root,'run.json'),JSON.stringify(run,null,2));
 const screenshotCount=await app.evaluate((_,task)=>global.visualFixture.db.taskScreenshotCount(global.visualFixture.chat,task),run.logicalTaskId);assert(screenshotCount<=8);
 assert(run.actions.some(a=>a.toolName==='web_project'&&['inspect','qa'].includes(a.arguments?.action)&&a.state==='completed'),'Real model must inspect actual browser behavior');
 const final=events.filter(e=>e.type==='token').map(e=>e.content).join('');
 result={...result,result:'PASS',wallSeconds:(Date.now()-started)/1000,issue,geometry,screenshotCount,final};await writeFile(join(root,'events.json'),JSON.stringify(events,null,2));
}catch(error){result={...result,result:'FAIL',error:String(error)};if(app){try{const ui=await app.firstWindow();await writeFile(join(root,'events.json'),JSON.stringify(await ui.evaluate(()=>window.__realVisualEvents),null,2));await writeFile(join(root,'run.json'),JSON.stringify(await app.evaluate(()=>global.visualFixture.db.listAnalysisRuns(global.visualFixture.chat).at(-1)),null,2));}catch{ /* preserve original failure */ }}throw error;}
finally{
 // These are handles returned by this harness's own spawn/launch, never a
 // process-name lookup. Always release the owned model even if Electron fails.
 try{
  if(app){
   let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture Electron close exceeded 15s')),15000);})]);}
   finally{clearTimeout(timer);}
  }
 }catch(error){
  result.cleanupError=String(error);result.result='FAIL';
  const child=app?.process();
  if(child?.pid&&child.exitCode===null&&child.signalCode===null){
   // Verify current parent, exact fixture argv and temporary runtime before
   // signalling the direct child. Never select another model by name.
   const argv=(await readFile(`/proc/${child.pid}/cmdline`,'utf8')).split('\0');
   const env=(await readFile(`/proc/${child.pid}/environ`,'utf8')).split('\0');
   const status=await readFile(`/proc/${child.pid}/stat`,'utf8');const fields=status.slice(status.lastIndexOf(')')+2).split(' ');
   result.cleanupProcess={pid:child.pid,ppid:Number(fields[1]),pgid:Number(fields[2]),argv,runtime:root};
   if(Number(fields[1])===process.pid&&argv.includes(resolve('test-fixtures/visual-debugging/main.cjs'))&&env.includes('LOCAL_AI_RUNTIME_ROOT='+root)){
    child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   }
  }
 }
 finally{
  if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),sleep(5000)]);if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await Promise.race([new Promise(r=>server.once('exit',r)),sleep(2000)]);}}
  result.serverStopped=server.exitCode!==null||server.signalCode!==null;
  try{await vite.close();}finally{closeSync(fd);await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));}
 }
}

assert.equal(result.result,'PASS',JSON.stringify(result));assert(result.serverStopped,'Owned model must exit');assert(!result.cleanupError,result.cleanupError);console.log(JSON.stringify(result));
