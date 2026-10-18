// Real owned production launcher/controller and Rust checkpoint across MTP reloads.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
const root=await mkdtemp('/tmp/lad-p2-reload-'),project=await mkdtemp('/tmp/lad-p2-reload-workspace-');process.env.LOCAL_AI_RUNTIME_ROOT=root;
const require=createRequire(import.meta.url),{ensureAppDirectories}=require('../dist/main/services/paths.js');ensureAppDirectories();
const {loadRuntimeConfiguration,saveRuntimeConfiguration}=require('../dist/main/services/runtime-settings.js'),{LlamaRuntimeController}=require('../dist/main/services/llama-runtime-controller.js'),{RustAgentRuntime}=require('../dist/main/services/rust-agent-runtime.js'),{liveMultimodal}=require('../dist/main/services/browser-vision.js');
const free=Number(execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim());assert(free>21000,'Another model may be using VRAM; refusing to start');
const binary=process.env.LOCAL_AI_TEST_LLAMA_SERVER??resolve('../llama.cpp/build-cuda/bin/llama-server'),model=process.env.LOCAL_AI_TEST_QWEN_GGUF??resolve('../llama-models/qwen3.8-27b-q4_K_M.gguf'),projector=process.env.LOCAL_AI_TEST_PROJECTOR??resolve('../llama-models/qwen3.8-27b-mmproj.gguf'),id='qwen3.8:27b-q4_K_M';
saveRuntimeConfiguration({...loadRuntimeConfiguration(),modelsPath:resolve('../llama-models'),llamaServerPath:binary,imageProcessingDevice:'cpu',browserVision:'on',autonomousBrowserQa:false,models:[{id,displayName:'Qwen3.8 reload fixture',modelPath:model,mmprojPath:projector,gpuLayers:null,supportsTools:true,mtpMode:'on',speculative:'mtp',builtin:true}]});
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const endpoint=`http://127.0.0.1:${port}/v1/chat/completions`;
const control=new LlamaRuntimeController({stateFile:join(root,'llama-cpp-runtime-state.json'),requestFile:join(root,'llama-cpp-runtime-request.env'),launcherPidFile:join(root,'llama-cpp-mtp-launcher.pid')});
const launcher=spawn('bash',[resolve('run-local-ai-desktop-llama-cpp-mtp.sh')],{env:{...process.env,LOCAL_AI_APP_DIR:resolve('.'),LOCAL_AI_LLAMA_PORT:String(port),LOCAL_AI_LAUNCHER_HEADLESS:'1',LOCAL_AI_PARENT_PID:String(process.pid)},stdio:'ignore'}),delay=ms=>new Promise(r=>setTimeout(r,ms));
const result={root,project,switches:[],errors:[]},pids=[];let memory;
try{
 for(let i=0;(await control.state()).status!=='idle';i++){assert(i<100&&launcher.exitCode===null);await delay(100);}
 const runtime=new RustAgentRuntime(endpoint),options={fast:{chat_template_kwargs:{enable_thinking:false}},final:{chat_template_kwargs:{enable_thinking:false}}};
 await writeFile(join(project,'index.html'),'<canvas width=384 height=256></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="blue";c.fillRect(20,20,200,150);</script>');await writeFile(join(project,'a.txt'),'initial');await writeFile(join(project,'b.txt'),'beta result');
 for(const [index,mode] of ['on','off','auto','off'].entries()){
  const previous=await control.state(),started=performance.now(),sw=await control.switchTo(id,16384,'q8_0',true,'cpu',mode);const reloadMs=performance.now()-started;assert(sw.ok,JSON.stringify(sw));assert.equal(sw.state.speculativeMode,mode==='off'?'none':'mtp');assert.equal(sw.state.mtpMode,mode);assert(await liveMultimodal(endpoint),'projector remains available with each MTP selection');pids.push(sw.state.serverPid);
  if(previous.serverPid){let alive=true;try{process.kill(previous.serverPid,0);}catch{alive=false;}assert(!alive,'previous model PID must be gone');}
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Reply exactly READY.'}],max_tokens:32,temperature:0,chat_template_kwargs:{enable_thinking:false}})});assert(response.ok);const body=await response.json();assert(body.choices[0].message.content.includes('READY'));
  const policy=['on','on','auto','off'][index];saveRuntimeConfiguration({...loadRuntimeConfiguration(),browserVision:policy});
  const browserEvents=[],browserReports=[];
  for await(const e of runtime.stream(id,[{id:'picture',conversationId:'policy-'+result.switches.length,role:'user',content:'Read-only: web_project open index.html, then screenshot with clip x=0 y=0 width=384 height=256. Finish briefly. Do not use qa or other tools.',createdAt:new Date().toISOString()}],[{id:'p',root:project,slot:1,label:'vision policy fixture'}],AbortSignal.timeout(120000),16384,'fast','auto','policy-'+result.switches.length,undefined,undefined,true,options,[],undefined,async()=>({approved:true,reason:'once'}),undefined,{mode:'strict',trusted_roots:[]},undefined,undefined,s=>{if(s.report)browserReports.push(s.report);}))browserEvents.push(e);
  assert(browserEvents.some(e=>e.type==='done'));const snapshot=browserReports.find(r=>r.scope==='capture');assert(snapshot,'actual screenshot operation required');assert.equal(snapshot.visual.analyzed,policy!=='off','requested policy must match actual image transmission');
  result.switches.push({mode,visionPolicy:policy,imageAnalyzed:snapshot.visual.analyzed,effective:sw.state.speculativeMode,pid:sw.state.serverPid,reloadMs,modeValidationMs:performance.now()-started,imageAnalysisMs:snapshot.visual.latencyMs,imageCount:snapshot.visual.imageCount,projector:sw.state.projectorDevice,memory:{gpu:execFileSync('nvidia-smi',['--query-gpu=memory.used,memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim(),rssKiB:Number((await readFile(`/proc/${sw.state.serverPid}/status`,'utf8')).match(/^VmRSS:\s+(\d+)/m)?.[1])}});
  if(mode==='on'){
   const events=[];let requested=false,pauseAt;const ids=new Set();
   for await(const e of runtime.stream(id,[{id:'u',conversationId:'reload-chat',role:'user',content:'Use replace_text on a.txt: replace initial with completed exactly once. Then read b.txt and report. No browser or terminal. Preserve task memory marker.',createdAt:new Date().toISOString()}],[{id:'p',root:project,slot:1,label:'reload fixture'}],AbortSignal.timeout(180000),16384,'fast','off','before-reload',{entries:[{id:'marker',finding:'checkpoint sentinel',status:'inferred'}]},'reload-chat',true,options,[],undefined,async()=>({approved:true,reason:'once'}),undefined,{mode:'strict',trusted_roots:[]},'reload-task')){
    events.push(e);if(e.type==='tool'&&['replace_text','write_file','apply_patch'].includes(e.activity.toolName))ids.add(e.activity.id);
    if(e.type==='tool'&&ids.has(e.activity.id)&&e.activity.state==='completed'&&!requested){requested=true;pauseAt=performance.now();void runtime.steer('before-reload','Pause','pause');}
    if(e.type==='paused')result.pauseMs=performance.now()-pauseAt;
   }
   assert(events.some(e=>e.type==='paused'));memory=events.findLast(e=>e.type==='task-memory')?.memory;assert(memory?.entries.some(e=>e.id==='marker'));assert.equal(await readFile(join(project,'a.txt'),'utf8'),'completed');await writeFile(join(root,'saved-checkpoint.json'),JSON.stringify(memory));
  }
 }
 // The projector stays loaded, so exercise Vision transitions without an MTP change/reload.
 result.loadedVisionTransitions=[];
 for(const policy of ['on','auto','off']){
  saveRuntimeConfiguration({...loadRuntimeConfiguration(),browserVision:policy});
  const transitions=[],reports=[];
  for await(const e of runtime.stream(id,[{id:`loaded-${policy}`,conversationId:`loaded-${policy}`,role:'user',content:'Read-only: web_project open index.html, then screenshot with clip x=0 y=0 width=384 height=256. Finish briefly. Do not call qa.',createdAt:new Date().toISOString()}],[{id:'p',root:project,slot:1,label:'loaded Vision transition'}],AbortSignal.timeout(120000),16384,'fast','auto',`loaded-${policy}`,undefined,undefined,true,options,[],undefined,async()=>({approved:true,reason:'once'}),undefined,{mode:'strict',trusted_roots:[]},undefined,undefined,e=>{if(e.report)reports.push(e.report);}))transitions.push(e);
  assert(transitions.some(e=>e.type==='done'));const report=reports.find(r=>r.scope==='capture');assert(report,'real screenshot after loaded Vision setting change');assert.equal(report.visual.analyzed,policy!=='off');result.loadedVisionTransitions.push({policy,analyzed:report.visual.analyzed,latencyMs:report.visual.latencyMs,imageCount:report.visual.imageCount,effectiveMtp:(await control.state()).speculativeMode});
 }
 const events=[];for await(const e of runtime.stream(id,[{id:'resume',conversationId:'reload-chat',role:'user',content:'Continue from the paused checkpoint. a.txt edit is already complete; do not repeat it. Read b.txt and report its content. Preserve marker.',createdAt:new Date().toISOString()}],[{id:'p',root:project,slot:1,label:'reload fixture'}],AbortSignal.timeout(180000),16384,'fast','off','after-reload',memory,'reload-chat',true,options,[],undefined,async()=>({approved:true,reason:'once'}),undefined,{mode:'strict',trusted_roots:[]},'reload-task'))events.push(e);
 assert(events.some(e=>e.type==='done'));assert(!events.some(e=>e.type==='error'));assert(!events.some(e=>e.type==='tool'&&['replace_text','write_file','apply_patch','create_file'].includes(e.activity.toolName)),'resume must not repeat the completed mutation');assert.equal(await readFile(join(project,'a.txt'),'utf8'),'completed');assert(events.some(e=>e.type==='task-memory'&&e.memory.entries.some(item=>item.id==='marker')));result.resumed=true;result.result='PASS';
}catch(e){result.errors.push(String(e));throw e;}finally{
 launcher.kill('SIGTERM');await Promise.race([new Promise(r=>launcher.once('exit',r)),delay(15000)]);result.cleanup=pids.map(pid=>{try{process.kill(pid,0);return{pid,alive:true};}catch{return{pid,alive:false};}});await mkdir(resolve('artifacts/p2'),{recursive:true});await writeFile(resolve('artifacts/p2/runtime-reload.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
