// Real owned launcher/server, production controller, real Qwen. No model downloads.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
const tokenComparison = process.env.LOCAL_AI_MTP_TOKEN_COMPARISON === '1';
const root = await mkdtemp(join(tmpdir(), 'lad-p1-mtp-'));
process.env.LOCAL_AI_RUNTIME_ROOT = root;
const require = createRequire(import.meta.url);
const { ensureAppDirectories } = require('../dist/main/services/paths.js'); ensureAppDirectories();
const { saveRuntimeConfiguration, loadRuntimeConfiguration } = require('../dist/main/services/runtime-settings.js');
const { LlamaRuntimeController } = require('../dist/main/services/llama-runtime-controller.js');
const { parseMtpMetrics } = require('../dist/main/services/mtp-diagnostics.js');
const { RustAgentRuntime } = require('../dist/main/services/rust-agent-runtime.js');
const binary=process.env.LOCAL_AI_TEST_LLAMA_SERVER ?? resolve('../llama.cpp/build-cuda/bin/llama-server');
const model=process.env.LOCAL_AI_TEST_QWEN_GGUF ?? resolve('../llama-models/qwen3.8-27b-q4_K_M.gguf');
const modelId='qwen3.8:27b-q4_K_M', context=16384;
const config={...loadRuntimeConfiguration(),llamaServerPath:binary,modelsPath:resolve('../llama-models'),gpuLayers:999,models:[{id:modelId,displayName:'Qwen MTP test',modelPath:model,mmprojPath:'',gpuLayers:null,supportsTools:true,speculative:'mtp',mtpMode:'off',builtin:true}]};
saveRuntimeConfiguration(config);
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const base=`http://127.0.0.1:${port}`, controller=new LlamaRuntimeController({stateFile:join(root,'llama-cpp-runtime-state.json'),requestFile:join(root,'llama-cpp-runtime-request.env'),launcherPidFile:join(root,'llama-cpp-mtp-launcher.pid')});
let launcher;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const results={model,binary,context,kv:'q8_0',gpuLayers:999,seed:42,temperature:0,root,rows:[],switches:[],deterministic:[],errors:[]};
const out=resolve(`artifacts/p1-mtp/${tokenComparison?'token-comparison':'benchmark'}.json`); await mkdir(resolve('artifacts/p1-mtp'),{recursive:true});
const persist=()=>writeFile(out,JSON.stringify(results,null,2));
function memory(pid){
  const gpu=execFileSync('nvidia-smi',['--query-gpu=memory.used,memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim().split(',').map(Number);
  let processGpuMiB;try{const rows=execFileSync('nvidia-smi',['--query-compute-apps=pid,used_gpu_memory','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim().split('\n');processGpuMiB=Number(rows.find(s=>Number(s.split(',')[0])===pid)?.split(',')[1]);}catch{/* unavailable */}
  return readFile(`/proc/${pid}/status`,'utf8').then(s=>({gpuUsedMiB:gpu[0],gpuFreeMiB:gpu[1],...(Number.isFinite(processGpuMiB)?{processGpuMiB}:{}),rssMiB:Number(s.match(/^VmRSS:\s+(\d+)/m)?.[1])/1024}));
}
const metrics=async()=>{try{const r=await fetch(base+'/metrics');return r.ok?parseMtpMetrics(await r.text()):undefined;}catch{return undefined;}};
async function generate(mode,scenario,prompt,thinking=false){
  const before=await metrics(),state=await controller.state(),memBefore=await memory(state.serverPid);
  const start=performance.now();let first,content='',reasoning='',finish,timings,usage,calls=[];
  const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:modelId,messages:[{role:'user',content:prompt}],stream:true,stream_options:{include_usage:true},max_tokens:thinking?4096:1536,temperature:0,seed:42,cache_prompt:false,chat_template_kwargs:{enable_thinking:thinking},...(thinking?{reasoning_effort:'medium'}:{})}),signal:AbortSignal.timeout(180000)});
  if (!response.ok) throw Error((await response.text()).slice(0,500));
  let buffer='';const decoder=new TextDecoder();for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});let i;while((i=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,i);buffer=buffer.slice(i+2);for(const line of event.split('\n'))if(line.startsWith('data: ')&&line!=='data: [DONE]'){const e=JSON.parse(line.slice(6)),choice=e.choices?.[0],d=choice?.delta??{};if((d.content||d.reasoning_content)&&first===undefined)first=performance.now()-start;content+=d.content??'';reasoning+=d.reasoning_content??'';if(d.tool_calls)calls.push(...d.tool_calls);if(choice?.finish_reason)finish=choice.finish_reason;if(e.timings)timings=e.timings;if(e.usage)usage=e.usage;}}}
  const after=await metrics(), elapsedMs=performance.now()-start;
  const drafted=before&&after?after.drafted-before.drafted:undefined,accepted=before&&after?after.accepted-before.accepted:undefined;
  const row={mode,scenario,maxTokens:thinking?4096:1536,elapsedMs,ttftMs:first,finish,complete:finish==='stop',contentChars:content.length,reasoningChars:reasoning.length,toolDeltas:calls.length,timings,usage,...(drafted!==undefined?{drafted,accepted,acceptance:drafted?accepted/drafted:undefined}:{}),memoryBefore:memBefore,memoryAfter:await memory(state.serverPid)};
  assert(content.trim(),`no final content: ${mode}/${scenario}`);assert(!calls.length,'unexpected tool markup');assert(!content.includes('<tool_call>'),'raw tool call markup');
  results.rows.push(row);await persist();console.log(JSON.stringify({mode,scenario,tps:timings?.predicted_per_second,complete:row.complete,drafted,accepted}));
}
async function agent(mode){
  const project=join(root,'project');await mkdir(project,{recursive:true});await writeFile(join(project,'a.txt'),'alpha fixture\n');await writeFile(join(project,'b.txt'),'beta fixture\n');
  const runtime=new RustAgentRuntime(base+'/v1/chat/completions');const start=performance.now(),before=await metrics();const events=[];
  const controllerAbort=new AbortController();const timer=setTimeout(()=>controllerAbort.abort(),180000);
  try{for await(const e of runtime.stream(modelId,[{id:'u',conversationId:`${mode}-chat`,role:'user',content:'Read-only task. Read a.txt with read_file, then read b.txt on a separate step. State both exact contents and finish. No plan, no edits, no terminal.',createdAt:new Date().toISOString()}],[{id:'fixture',slot:1,root:project,label:'fixture'}],controllerAbort.signal,context,'fast','off',`mtp-agent-${mode}`,undefined,undefined,true,{main:{chat_template_kwargs:{enable_thinking:false}},final:{chat_template_kwargs:{enable_thinking:false}}})){events.push(e);}}
  finally{clearTimeout(timer);}
  const starts=events.filter(e=>e.type==='tool'&&e.activity.toolName==='read_file').map(e=>e.activity.id),successful=events.filter(e=>e.type==='tool'&&starts.includes(e.activity.id)&&e.activity.state==='completed');
  assert(successful.length>=2,`${mode}: missing actual file tools`);assert(events.some(e=>e.type==='done'));assert(!events.some(e=>e.type==='error'));const after=await metrics(),state=await controller.state();
  results.rows.push({mode,scenario:'C-agent',elapsedMs:performance.now()-start,complete:true,successfulReads:successful.length,errors:events.filter(e=>e.type==='tool'&&e.activity.state==='error').length,telemetry:events.filter(e=>e.type==='agent-telemetry').map(e=>e.telemetry),...(before&&after?{drafted:after.drafted-before.drafted,accepted:after.accepted-before.accepted}:{}),memoryAfter:await memory(state.serverPid)});await persist();
}
const ownedPids=[];
try{
 launcher=spawn('bash',[resolve('run-local-ai-desktop-llama-cpp-mtp.sh')],{env:{...process.env,LOCAL_AI_APP_DIR:resolve('.'),LOCAL_AI_LLAMA_PORT:String(port),LOCAL_AI_LAUNCHER_HEADLESS:'1',LOCAL_AI_PARENT_PID:String(process.pid)},stdio:['ignore','ignore','pipe']});let err='';launcher.stderr.on('data',c=>err+=c);
 for(let i=0;i<300;i++){try{if((await controller.state()).status==='idle')break;}catch{/* state not published yet */}if(launcher.exitCode!==null)throw Error(err);await delay(50);}
 for(const [index,mode]of (tokenComparison?['off','on','off']:['off','on','auto','off','off']).entries()){
  const prior=await controller.state();
  // Fifth pass restarts the supervisor to prove saved Off survives a fresh launcher.
  if(index===4){launcher.kill('SIGTERM');await new Promise(r=>launcher.once('exit',r));launcher=spawn('bash',[resolve('run-local-ai-desktop-llama-cpp-mtp.sh')],{env:{...process.env,LOCAL_AI_APP_DIR:resolve('.'),LOCAL_AI_LLAMA_PORT:String(port),LOCAL_AI_LAUNCHER_HEADLESS:'1',LOCAL_AI_PARENT_PID:String(process.pid)},stdio:'ignore'});await delay(700);}
  const start=performance.now(),sw=await controller.switchTo(modelId,context,'q8_0',true,undefined,mode);assert(sw.ok,JSON.stringify(sw));
  assert.equal(sw.state.speculativeMode,mode==='off'?'none':'mtp');assert.equal(sw.state.mtpMode,mode);ownedPids.push(sw.state.serverPid);
  saveRuntimeConfiguration({...loadRuntimeConfiguration(),models:loadRuntimeConfiguration().models.map(m=>({...m,mtpMode:mode}))});
  assert.equal(loadRuntimeConfiguration().models[0].mtpMode,mode);
  if(prior.serverPid&&prior.serverPid!==sw.state.serverPid){let alive=true;try{process.kill(prior.serverPid,0);}catch{alive=false;}assert(!alive,'previous owned server survived reload');}
  const label=index===3?'off-after-on':index===4?'off-after-restart':mode;
  results.switches.push({mode:label,pid:sw.state.serverPid,elapsedMs:performance.now()-start,memory:await memory(sw.state.serverPid)});await persist();
  if (tokenComparison) {
    const promptText='Explain cooperative cancellation in four substantial paragraphs. Include safe operation boundaries, checkpoints, deduplication of file edits and recovery invariants.';
    const template=await fetch(base+'/apply-template',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:promptText}],chat_template_kwargs:{enable_thinking:false}})});
    assert(template.ok);const {prompt}=await template.json();
    const response=await fetch(base+'/completion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,n_predict:768,temperature:0,seed:42,cache_prompt:false,return_tokens:true})});
    const body=await response.json();assert(response.ok);assert(Array.isArray(body.tokens)&&body.tokens.length>0);
    const diagnostic={mode:index===2?'off-repeat':mode,prompt,tokens:body.tokens,content:body.content,timings:body.timings,metrics:await metrics()};
    results.deterministic.push(diagnostic);await persist();console.log(JSON.stringify({mode:diagnostic.mode,tokens:body.tokens.length}));
    continue;
  }
  await generate(label,'A-technical','Explain cooperative cancellation in four substantial paragraphs. Include safe operation boundaries, checkpoints, deduplication of file edits and recovery invariants.');
  await generate(label,'B-code','Write a concise self-contained TypeScript bounded retry function in at most 30 lines with AbortSignal, max 3 attempts, exponential delay, and no retry after cancellation. Include only code and one usage line.');
  await agent(label);
  await generate(label,'D-reasoning','A runtime journals a completed atomic edit before starting the next operation. A pause may arrive during the edit or immediately afterward. Think through both interleavings and identify exactly when resume could duplicate an edit. Give the final invariant and solution in at most 100 words.',true);
  if(index<2){const r=await fetch(base+'/completion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'The first ten prime numbers are',n_predict:64,temperature:0,seed:42,cache_prompt:false,return_tokens:true})});const body=await r.json();assert(r.ok,JSON.stringify(body));assert(Array.isArray(body.tokens)&&body.tokens.length>0,'backend did not return token IDs');results.deterministic.push({mode,tokens:body.tokens,content:body.content,timings:body.timings});await persist();}
  await copyFile(join(root,'logs/llama-cpp-mtp-server.log'),resolve(`artifacts/p1-mtp/server-${label}.log`));
 }
 results.deterministicEqual=JSON.stringify(results.deterministic[0].tokens)===JSON.stringify(results.deterministic[1].tokens);results.success=true;if(tokenComparison){const [a,b,c]=results.deterministic;results.offRepeatEqual=JSON.stringify(a.tokens)===JSON.stringify(c.tokens);results.firstDivergence=a.tokens.findIndex((id,i)=>id!==b.tokens[i]);results.samePrompt=results.deterministic.every(d=>d.prompt===a.prompt);}
}catch(error){results.errors.push(String(error));throw error;}finally{
 if(launcher?.exitCode===null){launcher.kill('SIGTERM');await Promise.race([new Promise(r=>launcher.once('exit',r)),delay(15000)]);}
 results.cleanup=ownedPids.map(pid=>{try{process.kill(pid,0);return{pid,alive:true};}catch{return{pid,alive:false};}});await persist();console.log(`Benchmark artifact: ${out}; runtime: ${root}`);
}
