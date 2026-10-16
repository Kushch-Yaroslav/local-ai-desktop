import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
const executable=process.env.LOCAL_AI_TEST_LLAMA_SERVER,modelPath=process.env.LOCAL_AI_TEST_QWEN_GGUF;
assert(executable&&modelPath&&existsSync(executable)&&existsSync(modelPath),'Set LOCAL_AI_TEST_LLAMA_SERVER and LOCAL_AI_TEST_QWEN_GGUF to installed binaries/model');
const output=resolve('artifacts/live-browser');await mkdir(output,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'lad-live-qwen-')),project=await mkdtemp(join(tmpdir(),'lad-live-qwen-project-')),alias='qwen3.6:35b-a3b-ud-q4_k_m',port=18081,base=`http://127.0.0.1:${port}`;
// Never adopt or stop an existing listener. This test owns only its child.
let occupied=false;try{await fetch(base+'/health',{signal:AbortSignal.timeout(1000)});occupied=true;}catch{/* listener/model is not ready yet */}assert(!occupied,'Test port already occupied');
const args=['-m',modelPath,'--alias',alias,'--host','127.0.0.1','--port',String(port),'--ctx-size','65536','--gpu-layers','999','--flash-attn','on','--cache-type-k','f16','--cache-type-v','f16','--cache-type-k-draft','f16','--cache-type-v-draft','f16','--kv-offload','--parallel','1','--jinja','--reasoning','on','--reasoning-format','auto','--fit','off','--n-cpu-moe','4','--threads','8','--threads-batch','8','--batch-size','1024','--ubatch-size','128','--load-mode','none','--no-warmup','--spec-type','draft-mtp','--spec-draft-n-max','2'];
const fd=openSync(join(output,'qwen-server.log'),'w'),server=spawn(executable,args,{stdio:['ignore',fd,fd]});
let application,result={result:'INTERRUPTED',root,pid:server.pid,args,mtp:true};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  const readyStart=Date.now();for(;;){if(server.exitCode!==null)throw Error('llama-server exited during load');try{const response=await fetch(base+'/health');if(response.ok)break;}catch{/* listener/model is not ready yet */}if(Date.now()-readyStart>120000)throw Error('model load timeout');await sleep(500);}
  const slots=await (await fetch(base+'/slots')).json();await writeFile(join(output,'qwen-slots.json'),JSON.stringify(slots,null,2));
  application=await electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/live-browser/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_LLAMA_CPP_URL:base,LOCAL_AI_AGENT_ENDPOINT:base+'/v1/chat/completions',LOCAL_AI_CONTEXT_FIXTURE_LIMIT:'65536'}});
  const page=await application.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.locator('.conversation').waitFor();
  const info=await application.evaluate(()=>global.liveFixture.prepareQwen());
  await page.locator('.chat-select').filter({hasText:'Live Browser workspace'}).click();
  await page.getByRole('button',{name:/Load selected configuration/}).click();
  await page.waitForFunction(()=>document.querySelector('.context-active')?.textContent.includes('64K'));
  await page.evaluate(({conversationId})=>window.localAi.chat.setPermissions(conversationId,'absolute_autopilot',true),info);
  await page.evaluate(()=>{
    window.liveTest={events:[],states:[],frames:0,frameHashes:[]};
    window.localAi.chat.onStream(e=>window.liveTest.events.push(e));
    window.localAi.liveBrowser.onEvent(e=>{if(e.type==='state')window.liveTest.states.push(e.state);else{window.liveTest.frames++;if(window.liveTest.frameHashes.length<100)window.liveTest.frameHashes.push(e.frame.data.slice(-1000));}});
  });
  const prompt='Small browser acceptance task. Replace index.html with a polished self-contained HTML/CSS/JS page titled Orbit Lab: dark blue background, large heading, continuously animated Canvas dots, navigation links #home (id=home) and #work (id=work), and a text input id=name. Use web_project to open it, click #work, fill #name with Local AI, and scroll down then back. Then change the main heading to Orbit Lab Updated in index.html, call web_project reload, click #home so the updated heading is visible, and read to confirm it. This is a small disposable test: skip plan and deliverables metadata, use file tools and web_project, do not run terminal commands or install packages. Finish with a short factual report. Do not use vision.';
  await page.locator('.composer textarea').fill(prompt);await page.locator('.send-button:not(.stop)').click();
  const started=Date.now();let hidden=false,reopened=false,hiddenAt=0,hiddenTools=0,observedDuringHidden=false;
  while(Date.now()-started<300000){
    const approve=page.getByRole('button',{name:'Allow once',exact:true});if(await approve.count())await approve.click();
    const sample=await page.evaluate(()=>({events:window.liveTest.events.map(e=>({type:e.type,tool:e.activity?.toolName,state:e.activity?.state,message:e.message})),states:window.liveTest.states.length,frames:window.liveTest.frames}));
    if(!hidden&&await page.locator('.mode-split .live-address').count()&&sample.frames>3){await page.screenshot({path:join(output,'qwen-live.png')});await page.getByRole('button',{name:'Chat Only',exact:true}).click();hidden=true;hiddenAt=Date.now();hiddenTools=sample.events.filter(e=>e.type==='tool').length;}
    if(hidden&&!reopened&&Date.now()-hiddenAt>1800&&(sample.events.filter(e=>e.type==='tool').length>hiddenTools||Date.now()-hiddenAt>8000)){observedDuringHidden=sample.events.filter(e=>e.type==='tool').length>hiddenTools;await page.locator('.live-reopen').click();reopened=true;}
    if(sample.events.some(e=>['done','error','cancelled'].includes(e.type)))break;
    await sleep(120);
  }
  if(hidden&&!reopened){observedDuringHidden=await page.evaluate(n=>window.liveTest.events.filter(e=>e.type==='tool').length>n,hiddenTools);await page.locator('.live-reopen').click();reopened=true;}
  const trace=await page.evaluate(()=>window.liveTest);await writeFile(join(output,'qwen-events.json'),JSON.stringify(trace,null,2));
  assert(trace.events.some(e=>e.type==='done'),'real Qwen did not finish normally');assert(!trace.events.some(e=>e.type==='error'),JSON.stringify(trace.events.filter(e=>e.type==='error')));
  const toolMap=new Map();for(const event of trace.events)if(event.type==='tool')toolMap.set(event.activity.id,{...toolMap.get(event.activity.id),...event.activity});
  const tools=[...toolMap.values()].filter(t=>t.toolName&&t.state!=='running');
  assert(tools.some(t=>t.toolName==='web_project'));
  assert(trace.frames>=5);assert(new Set(trace.frameHashes).size>=3);
  const sessions=new Set(trace.states.map(s=>s.sessionId));assert.equal(sessions.size,1,'real agent and UI retain same session');
  const actions=trace.states.filter(s=>s.action).map(s=>s.action.kind);for(const action of ['click','fill','reload'])assert(actions.includes(action),`Qwen missed ${action}`);
  const html=await readFile(join(project,'index.html'),'utf8');assert(html.includes('Orbit Lab Updated'),'project edit did not reach disk');
  await page.screenshot({path:join(output,'qwen-final.png')});assert(hidden&&reopened&&observedDuringHidden,'agent must make tool progress while panel is hidden');assert.deepEqual(errors,[]);
  result={...result,result:'PASS',wallSeconds:(Date.now()-started)/1000,tools:tools.map(t=>({name:t.toolName,state:t.state})),frames:trace.frames,uniqueFrames:new Set(trace.frameHashes).size,sessions:sessions.size,actions:[...new Set(actions)],hidden,reopened,observedDuringHidden,errors,final:trace.events.findLast(e=>e.type==='done')?.assistant?.content};
  console.log(JSON.stringify(result));
} catch(error){result={...result,result:'FAIL',error:String(error)};throw error;}
finally {
  if(application){try{await application.close();}catch{/* owned child cleanup follows */}}
  if(server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),sleep(5000)]);if(server.exitCode===null)server.kill('SIGKILL');}
  closeSync(fd);result.serverStopped=server.exitCode!==null||server.signalCode!==null;await writeFile(join(output,'qwen-result.json'),JSON.stringify(result,null,2));
}
