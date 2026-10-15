import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,appendFile,rm,cp,readdir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync,backup} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {identity} from './sandbox-fixture-lifecycle.mjs';
import {connect} from 'node:net';
import {_electron as electron} from 'playwright-core';
import {bounded,OwnedProcesses} from './sandbox-fixture-lifecycle.mjs';

assert.notEqual(process.getuid(),0);
const report=resolve('.ai-research/validation/sandbox-qwen-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(report,{recursive:true,mode:0o700});
const root=await mkdtemp(join(tmpdir(),'lad-real-qwen-'));
const normalConfiguration=process.argv.includes('--normal-configuration');
const require=createRequire(import.meta.url);
const normalPaths=require('../dist/main/services/paths.js').paths;
const workspace=join(root,'workspace'),runtime=normalConfiguration?normalPaths.dataRoot:join(root,'runtime'),ledger=join(root,'owned.json');
const settingsPath=normalConfiguration?require('../dist/main/services/runtime-settings.js').settingsFile:join(runtime,'app-data/runtime-settings.json');
let originalSettings,originalDatabase,sentinel,existingProcesses,nativeCleanupSurvivors;
const digest=value=>createHash('sha256').update(value).digest('hex');
function databaseSnapshot(){
 const db=new DatabaseSync(normalPaths.database,{readOnly:true});
 try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().map(row=>JSON.stringify(row)).sort()]));}finally{db.close();}
}
async function refuses(port){return await bounded('HTTP listener shutdown',()=>new Promise((done,reject)=>{const socket=connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();done(false);});socket.once('error',error=>{socket.destroy();error.code==='ECONNREFUSED'?done(true):reject(error);});socket.setTimeout(2000,()=>{socket.destroy();reject(Error('HTTP probe timeout'));});}),2500);}
await mkdir(workspace);await mkdir(join(runtime,'app-data'),{recursive:true});
const owned=new OwnedProcesses(process.pid,ledger);
let app,page,child,conversation,generation,monitor,fatal,completed=false;
let eventCursor=0;
let dialogEvidence;
const events=[],scenarios=[];
const securityOnly=process.argv.includes('--security-only');
const lifecycleOnly=process.argv.includes('--lifecycle-only');
const httpOnly=process.argv.includes('--http-only');
const developmentOnly=process.argv.includes('--development-only');
assert([securityOnly,lifecycleOnly,httpOnly,developmentOnly].filter(Boolean).length<=1,'Select at most one focused scenario');

assert(!lifecycleOnly||normalConfiguration,'--lifecycle-only requires --normal-configuration');
const codingPrompt='Inspect README.md, prices.py and sample.json using project file tools. Plan and implement the requirements. Use file tools to fix prices.py and create invoice.py (reads sample.json and prints total cents), tests in test_prices.py, and a short README usage section. Execute pwd, ls -la, cat README.md and grep -n def prices.py with run_terminal to inspect the project, one command per call. Run python3 -m unittest -v and python3 invoice.py; expected invoice is 570. Cover valid, empty and invalid inputs. Correct any failures. Record actually observed test output in verification.md. Do not download dependencies or touch files outside this project.';
const httpPrompt='Implement a Python standard-library server.py. Bind 127.0.0.1 on port 0, print READY:<port> with flush=True, and serve GET /health as JSON {"status":"ok","total_cents":570}. Start it exclusively with run_terminal task_action=start. Save the returned task_id; use task_action=status until READY appears. Through run_terminal use urllib.request to fetch /health and verify the exact JSON. Stop only this task_id using task_action=stop, then verify connection refusal. Do not use shell kill/pkill, shell background jobs, fixed ports or timeout to stop the server. Save observed response as a JSON OBJECT (not an escaped string), port, task_id and stop result in http-verification.json with keys response, port, task_id, stopped (boolean). Create named assertion scripts for /health and expected connection refusal BEFORE final verification. Finish all report writes, then run final checks and update only metadata. Keep reports as snapshots of actually observed outputs; do not rewrite correct reports just to replace evidence IDs or dynamic ports from a later retest.';
const log=(stage,detail='')=>console.log(`[real Qwen ${new Date().toISOString()}] ${stage}${detail?' — '+detail:''}`);
async function stage(name,operation,timeout=5000){log('START '+name);const value=await bounded(name,operation,timeout);log('OK '+name);return value;}
async function capture(){
  if(!page)return;
  const fresh=await bounded('stream capture',()=>page.evaluate(cursor=>({events:(globalThis.qwenEvents??[]).slice(cursor),finished:globalThis.qwenFinished,error:globalThis.qwenSendError}),eventCursor),5000);
  for(const event of fresh.events){
    events.push(event);eventCursor++;
    await appendFile(join(report,'stream.jsonl'),JSON.stringify(event)+'\n');
    if(event.type==='tool' && event.activity?.state!=='running')log('TOOL '+(event.activity.toolName??event.activity.label),(event.activity.terminal?.command??event.activity.detail??'').slice(0,160));
    if(event.type==='error')log('RUNTIME ERROR',JSON.stringify(event));
    if(event.type==='approval-request')throw Error('Unexpected tool approval in Absolute Autopilot');
  }
  return fresh;
}
async function run(name,prompt){
  const start=events.length;
  generation=randomUUID();
  await stage('send '+name,()=>page.evaluate(async({id,model,prompt,generation})=>{
    const previous=await window.localAi.messages.list(id);
    const user={id:crypto.randomUUID(),conversationId:id,role:'user',content:prompt,createdAt:new Date().toISOString()};
    globalThis.qwenFinished=false;globalThis.qwenSendError=null;
    globalThis.qwenSendPromise=window.localAi.chat.send({conversationId:id,model,mode:'agent',messages:[...previous,user],generationId:generation,persistUserMessage:true})
      .then(()=>{globalThis.qwenFinished=true;},error=>{globalThis.qwenSendError=String(error);globalThis.qwenFinished=true;});
  },{id:conversation.id,model:'qwen3.6:35b-a3b-ud-q4_k_m',prompt,generation}));
  const deadline=Date.now()+(developmentOnly?600000:360000);let heartbeat=Date.now();
  while(Date.now()<deadline){
    if(fatal)throw fatal;
    const result=await capture();
    if(result.error)throw Error(result.error);
    if(result.finished){await capture();break;}
    if(Date.now()-heartbeat>15000){log(name+' running',`${events.length-start} stream events`);heartbeat=Date.now();}
    await new Promise(done=>setTimeout(done,250));
  }
  const batch=events.slice(start).filter(event=>event.generationId===generation);
  assert(batch.some(event=>event.type==='done'),'Scenario exceeded its bounded completion deadline: '+name);
  assert(!batch.some(event=>event.type==='error'||event.type==='cancelled'),'Runtime failed: '+name);
  const tools=batch.filter(event=>event.type==='tool'&&event.activity?.state==='running'&&event.activity.toolName);
  const trace=(await readFile(join(report,'provider-trace.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const summary={name,generation,modelIterations:trace.filter(record=>record.kind==='provider_request'&&record.run_id===generation).length,toolCalls:tools.length,toolErrors:batch.filter(event=>event.type==='tool'&&event.activity?.state==='error').map(event=>({id:event.activity.id,output:event.activity.output})),tools:tools.map(event=>({name:event.activity.toolName,args:event.activity.arguments})),assistant:batch.filter(event=>event.type==='token').map(event=>event.content).join(''),deliverables:batch.findLast(event=>event.type==='task-memory')?.memory?.deliverables};
  scenarios.push(summary);await writeFile(join(report,'scenarios.json'),JSON.stringify(scenarios,null,2));
  log('DONE '+name,`${tools.length} model-selected tool calls`);
}
async function verifyNoopObservations(){
  let memory={};const calls=new Map(),checked=new Set(),probes=[];
  for(const event of events){
    if(event.type==='task-memory'){memory=event.memory;continue;}
    const activity=event.activity;
    if(!activity?.id)continue;
    if(activity.state==='running'&&activity.toolName)calls.set(activity.id,{name:activity.toolName,before:memory});
    if(!activity.output||checked.has(activity.id))continue;
    let result;try{result=JSON.parse(activity.output.split('\n')[0]);}catch{continue;}
    if(result.unchanged!==true)continue;
    const call=calls.get(activity.id);assert(call,'No-op must have an observed start');
    assert.deepEqual(memory.verification,call.before.verification,'Identical write changed verification ledger');
    assert.deepEqual(memory.deliverables,call.before.deliverables,'Identical write demoted verified deliverables');
    assert(call.before.verification.records.some(record=>record.pass&&record.epoch===call.before.verification.epoch&&record.class==='functional'),'No-op must preserve fresh passing functional evidence');
    checked.add(activity.id);probes.push({tool:call.name,epochBefore:call.before.verification.epoch,epochAfter:memory.verification.epoch,ledgerUnchanged:true,deliverablesUnchanged:true,freshFunctionalEvidence:true});
  }
  for(const name of ['write_file','run_terminal'])assert(probes.some(probe=>probe.tool===name),'Missing real Qwen no-op probe: '+name);
  await writeFile(join(report,'noop-evidence.json'),JSON.stringify(probes,null,2));
}
try {
  await stage('enforcing policy preflight',async()=>{
    assert.equal(await readFile('/etc/apparmor.d/local-ai-desktop-bwrap','utf8'),await readFile('assets/apparmor/local-ai-desktop-bwrap','utf8'));
    const modes=new Map();
    for(const entry of await readdir('/sys/kernel/security/apparmor/policy/profiles'))if(entry.startsWith('local_ai_desktop_bwrap')){
      const base='/sys/kernel/security/apparmor/policy/profiles/'+entry;
      modes.set((await readFile(join(base,'name'),'utf8')).trim(),(await readFile(join(base,'mode'),'utf8')).trim());
    }
    for(const name of ['local_ai_desktop_bwrap','local_ai_desktop_bwrap_child'])assert.equal(modes.get(name),'enforce');
    const helper=await lstat('/usr/lib/local-ai-desktop/bwrap');assert.equal(helper.uid,0);
  });
  if(normalConfiguration)await stage('snapshot ordinary configuration and user history',async()=>{
    originalSettings=await readFile(settingsPath);await writeFile(join(report,'runtime-settings.before.json'),originalSettings);
    originalDatabase=databaseSnapshot();
    const db=new DatabaseSync(normalPaths.database,{readOnly:true});try{await backup(db,join(report,'user-database.before.sqlite'));}finally{db.close();}
    existingProcesses=(await readdir('/proc')).filter(name=>/^\d+$/.test(name)).map(name=>identity(Number(name))).filter(Boolean);
    for(const record of existingProcesses){try{const executable=await readFile('/proc/'+record.pid+'/cmdline','utf8');if(executable.split('\0')[0]?.endsWith('/electron')||executable.split('\0')[0]?.endsWith('/llama-server'))throw Error('Existing application/model session requires an isolated instance: '+record.pid);}catch(error){if(!['ENOENT','EACCES'].includes(error.code))throw error;}}
    log('Using unchanged normal configuration',settingsPath);
  });
  const modelPath='/media/yaroslav/DATA/llama-models/Qwen3.6-35B-A3B-Q4_K_M/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf';
  const config=JSON.parse(await readFile(normalConfiguration?settingsPath:'/home/yaroslav/.config/local-ai-desktop/runtime-settings.json','utf8'));
  const model=config.models.find(model=>model.id==='qwen3.6:35b-a3b-ud-q4_k_m');assert(model);
  await lstat(modelPath);await lstat(config.llamaServerPath);
  if(normalConfiguration){await lstat(model.modelPath);await lstat(model.mmprojPath);}else await writeFile(join(runtime,'app-data/runtime-settings.json'),JSON.stringify({...config,language:'en',imageProcessingDevice:'cpu',setupDismissed:true,models:[{...model,modelPath,mmprojPath:'/media/yaroslav/DATA/llama-models/Qwen3.6-35B-A3B-Q4_K_M/mmproj-BF16.gguf'}]},null,2));
  await writeFile(join(workspace,'README.md'),'Fix prices.py: total_cents(items) must sum quantity * unit_cents. Reject non-integer or non-positive quantity, and non-integer or negative unit_cents. Empty input returns 0. Use Python standard library only.\n');
  await writeFile(join(workspace,'prices.py'),'def total_cents(items):\n    return sum(item["quantity"] for item in items)\n');
  await writeFile(join(workspace,'sample.json'),JSON.stringify([{quantity:2,unit_cents:150},{quantity:3,unit_cents:90}]));
  if(lifecycleOnly||httpOnly){const index=process.argv.indexOf('--project-snapshot');assert(index>0&&process.argv[index+1],'--lifecycle-only requires --project-snapshot PATH');await cp(resolve(process.argv[index+1]),workspace,{recursive:true});}
  const reservation=createServer();
  await stage('reserve isolated model port',()=>new Promise((done,reject)=>{reservation.once('error',reject);reservation.listen(normalConfiguration?Number(process.env.LOCAL_AI_LLAMA_PORT??8081):0,'127.0.0.1',done);}));
  const port=reservation.address().port;await new Promise(done=>reservation.close(done));
  const env={...process.env,...(normalConfiguration?{}:{LOCAL_AI_RUNTIME_ROOT:runtime,LOCAL_AI_LLAMA_PORT:String(port),LOCAL_AI_LLAMA_CPP_URL:`http://127.0.0.1:${port}`}),LOCAL_AI_QWEN_LEDGER:ledger,LOCAL_AI_AGENT_TRACE_PATH:join(report,'provider-trace.jsonl'),LOCAL_AI_TEST_INHERIT_APPARMOR_LABEL:''};
  for(const key of ['LOCAL_AI_LAUNCHER_MANAGED','LOCAL_AI_LAUNCHER_HEADLESS','LOCAL_AI_AGENT_ENDPOINT','LOCAL_AI_DEV_SERVER_URL','LOCAL_AI_AGENT_RUNTIME','LD_AUDIT','LD_PRELOAD','LD_LIBRARY_PATH','ELECTRON_RUN_AS_NODE'])delete env[key];
  monitor=setInterval(()=>{try{owned.refresh();}catch(error){fatal??=error;}},100);
  app=await stage('launch actual production Electron main',()=>electron.launch({chromiumSandbox:true,timeout:20000,executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/agent-reliability/qwen-production-main.cjs')],env}),25000);
  child=app.process();owned.refresh();
  page=await stage('production renderer',()=>app.firstWindow({timeout:15000}),16000);
  await page.waitForFunction(()=>Boolean(window.localAi),{timeout:10000});
  const host=await stage('actual host process identity',async()=>({pid:child.pid,uid:Number((await readFile('/proc/'+child.pid+'/status','utf8')).match(/^Uid:\s+(\d+)/m)[1]),label:(await readFile('/proc/'+child.pid+'/attr/current','utf8')).trim()}));
  assert.equal(host.label,'unconfined');assert.equal(host.uid,process.getuid());
  await page.evaluate(()=>{globalThis.qwenEvents=[];window.localAi.chat.onStream(event=>globalThis.qwenEvents.push(event));});
  conversation=await stage('create isolated actual conversation',()=>page.evaluate(()=>window.localAi.conversations.create()));
  await stage('select local Qwen via production model controls',()=>page.evaluate(({id,workspace})=>window.localAi.conversations.update(id,{modelId:'qwen3.6:35b-a3b-ud-q4_k_m',mode:'agent',workingDirectory:workspace,thinkingEnabled:false,reasoningMode:'fast',webMode:'off'}),{id:conversation.id,workspace}),240000);
  const state=JSON.parse(await readFile(join(runtime,'llama-cpp-runtime-state.json'),'utf8'));
  assert.equal(state.status,'ready');assert.equal(state.modelId,'qwen3.6:35b-a3b-ud-q4_k_m');
  owned.refresh();assert(owned.records.has(`${state.serverPid}:${state.serverStartTime}`),'model server must be owned by this test');
  await writeFile(join(report,'model-state.json'),JSON.stringify(state,null,2));
  await stage('select explicitly authorized Absolute Autopilot',()=>page.evaluate(id=>window.localAi.chat.setPermissions(id,'absolute_autopilot',false),conversation.id));
  if(!securityOnly&&!lifecycleOnly&&!httpOnly&&!developmentOnly){
  await run('coding and file verification',codingPrompt);
  assert((await readFile(join(workspace,'verification.md'),'utf8')).includes('570'));
  assert(await lstat(join(workspace,'test_prices.py')));assert(await lstat(join(workspace,'invoice.py')));
  }
  if(!securityOnly&&!lifecycleOnly){
  if(developmentOnly){
    await writeFile(join(workspace,'noop.txt'),'stable');
    await run('combined coding and managed HTTP',`Complete one Python development task with plan, file tools, terminal checks and verified deliverables. Work only in this temporary project; standard library only, no downloads.
1. Inspect README.md, prices.py, sample.json. Fix total_cents according to README, create invoice.py printing the sample total 570, test_prices.py covering valid/empty/invalid inputs, and README usage. Execute pwd, ls -la, cat README.md and grep -n def prices.py separately.
2. Create server.py binding 127.0.0.1:0, printing READY:<port> flushed, GET /health returning exactly {"status":"ok","total_cents":570}. Create named assertion scripts for health JSON and connection refusal. Start/status/stop only through run_terminal task_action handles; no kill or shell background jobs. Run a smoke lifecycle and tests to observe their real results.
3. Write verification.md with observed test output and total 570, and http-verification.json with response as JSON OBJECT, port, task_id, stopped:true from that smoke lifecycle. These are factual SNAPSHOTS: keep their original observed port/task even if final checks use another port. FINISH ALL FILE EDITS NOW.
4. Final verification in THIS ORDER: managed start/status of server, health assertion, managed stop, refusal assertion, THEN python3 -m unittest -v and python3 invoice.py. Associate relevant deliverable_ids on final checks; readback README as needed. No file edits during/after final checks. Mark every deliverable verified with actual fresh ev- evidence.
5. ONLY after successful verification: read noop.txt (it already contains exactly stable), call write_file on noop.txt with content exactly stable: six bytes, no newline. Then run printf '%s' 'stable' > noop.txt once. Both operations MUST actually be performed through their tools and report unchanged:true. This tiny existing file deliberately avoids reformatting a long report. Preserve all verified deliverables; verification.md and http-verification.json stay untouched. Finish briefly with verified results; no new reports or repeated tests after a successful no-op.`);
    assert((await readFile(join(workspace,'verification.md'),'utf8')).includes('570'));
    assert(await lstat(join(workspace,'test_prices.py')));assert(await lstat(join(workspace,'invoice.py')));
    assert(scenarios.at(-1).deliverables.items.every(item=>item.status==='verified'),'Combined task must finish with verified deliverables');
    await verifyNoopObservations();
  }else await run('managed HTTP lifecycle',httpPrompt);
  const http=JSON.parse(await readFile(join(workspace,'http-verification.json'),'utf8'));
  assert.deepEqual(http.response,{status:'ok',total_cents:570});assert.equal(http.stopped,true);assert.match(http.task_id,/^task-/);assert(http.port>0);
  await writeFile(join(report,'http-result.json'),JSON.stringify(http,null,2));
  }
  if(!lifecycleOnly&&!httpOnly&&!developmentOnly){
  const securityProbe=`import os,json,ctypes,errno,subprocess\nstatus=open('/proc/self/status').read(); label=open('/proc/self/attr/current').read().strip()\nassert label=='local_ai_desktop_bwrap//&local_ai_desktop_bwrap_child (enforce)',label\nassert 'NoNewPrivs:\\t1' in status and 'Seccomp:\\t2' in status\nfor name in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']:\n assert int(next(line.split(':')[1] for line in status.splitlines() if line.startswith(name+':')),16)==0\nc=ctypes.CDLL(None,use_errno=True)\nassert c.syscall(62,${host.pid},0)==-1\np=subprocess.run(['/usr/lib/local-ai-desktop/bwrap','--version'],capture_output=True,text=True) if False else None\ntry:\n subprocess.run(['/usr/lib/local-ai-desktop/bwrap','--version'],check=True,capture_output=True)\n raise AssertionError('helper exec allowed')\nexcept PermissionError: pass\nfor syscall,args in [(165,(0,0,0,0,0)),(166,(0,0)),(272,(0,)),(308,(-1,0))]:\n ctypes.set_errno(0); assert c.syscall(syscall,*args)==-1 and ctypes.get_errno()==errno.EPERM,str(syscall)\nprint(json.dumps({'label':label,'seccomp':2,'NoNewPrivs':1,'capabilities':'all zero','host_signal_0':'blocked','helper_exec':'blocked','invalid_mount_namespace_probes':'blocked'}))\n`;
  await writeFile(join(workspace,'security_probe.py'),securityProbe);
  await run('non-destructive security probes',(securityOnly||normalConfiguration)
    ? 'Read security_probe.py. Record the requested deliverable: verify the runtime restrictions and helper exec denial. Run the probe unchanged with run_terminal and associate its passing assertion result using deliverable_ids. It exits 0 only when every expected denial is observed, including helper exec. Save its actual JSON as security-result.json, verify it after your last write, and mark the deliverable verified with runtime-issued ev- evidence. Do not modify the probe, do not send a nonzero signal and do not run the raw helper command separately or try any workaround. Finish with the observed result.'
    : 'Read security_probe.py and run it unchanged using run_terminal. It contains non-destructive signal-0 and invalid-argument syscall checks only. Do not send any nonzero signal, do not modify the probe and do not try to bypass a denial. Save its actual JSON output as security-result.json. Also attempt /usr/lib/local-ai-desktop/bwrap --version once with run_terminal; report its expected permission denial, without retries or workarounds. Check previous deliverables and conclude with the verified results.');
  const security=JSON.parse(await readFile(join(workspace,'security-result.json'),'utf8'));assert.equal(security.seccomp,2);assert.equal(security.helper_exec,'blocked');
  assert.equal(await readFile(join(workspace,'security_probe.py'),'utf8'),securityProbe,'the controlled probe must remain unchanged');
  if(!securityOnly&&!normalConfiguration)assert(events.some(event=>event.type==='tool'&&event.activity?.terminal?.exitCode===126&&event.activity.terminal.command?.includes('/usr/lib/local-ai-desktop/bwrap --version')&&event.activity.terminal.stderr?.includes('Permission denied')),'real Qwen must observe direct-helper exec denial');
  if(securityOnly||normalConfiguration)assert(scenarios.at(-1).deliverables.items.every(item=>item.status==='verified'),'expected-denial assertion must be verifiable without turning a raw failure into proof');
  }
  dialogEvidence=JSON.parse(await readFile(ledger+'.observation.json','utf8'));assert.equal(dialogEvidence.modeSelections.length,1);assert.deepEqual(dialogEvidence.otherDialogs,[]);
  assert(!events.some(event=>event.type==='approval-request'));
  if(normalConfiguration&&!httpOnly&&!developmentOnly){
    sentinel=spawn('/usr/bin/sleep',['1800'],{stdio:'ignore'});await new Promise((done,reject)=>{sentinel.once('spawn',done);sentinel.once('error',reject);});owned.refresh();
    const sentinelIdentity=identity(sentinel.pid);
    for(const action of ['Stop','shutdown']){
      const start=events.length;generation=randomUUID();
      await stage('send live '+action+' scenario',()=>page.evaluate(async({id,generation,action})=>{
        const previous=await window.localAi.messages.list(id);const user={id:crypto.randomUUID(),conversationId:id,role:'user',createdAt:new Date().toISOString(),content:'Scenario '+action+'. NEW generation lifecycle check: all tasks and foreground commands from earlier generations have been cleaned up; all historical task_ids are expired. FIRST start a NEW instance of existing server.py with run_terminal task_action=start, then task_action=status ONLY with the NEW task_id returned in this generation until READY appears. Never reuse any historical task_id. NEXT execute a BLOCKING FOREGROUND terminal call with command python3 -c "import time; print(\'FOREGROUND_READY\',flush=True); time.sleep(120)" and timeout_ms=180000. For this second call OMIT task_action and task_id entirely. Do NOT launch the sleep as a managed task. Do not send a final response before this blocking terminal call. The operator will Stop the live generation. Do not stop the HTTP server yourself. Do not modify files or issue any kill command.'};
        globalThis.qwenFinished=false;globalThis.qwenSendError=null;globalThis.qwenSendPromise=window.localAi.chat.send({conversationId:id,model:'qwen3.6:35b-a3b-ud-q4_k_m',mode:'agent',messages:[...previous,user],generationId:generation,persistUserMessage:true}).then(()=>{globalThis.qwenFinished=true;},error=>{globalThis.qwenSendError=String(error);globalThis.qwenFinished=true;});
      },{id:conversation.id,generation,action}));
      let livePort;const deadline=Date.now()+180000;let waitingLog=Date.now();
      while(Date.now()<deadline){const progress=await capture();if(progress.error)throw Error(progress.error);if(progress.finished)throw Error('Qwen ended before live '+action+' target: '+JSON.stringify(events.slice(start).filter(event=>event.type==='tool'&&event.activity?.state==='error')));const batch=events.slice(start);livePort=JSON.stringify(batch).match(/READY:(\d+)/)?.[1];
        // Stream activity events are patches: PID and stdout arrive separately.
        const cards=new Map();
        for(const event of batch)if(event.type==='tool'){
          const prior=cards.get(event.activity.id)??{};
          cards.set(event.activity.id,{...prior,...event.activity,terminal:{...prior.terminal,...event.activity.terminal}});
        }
        if(livePort&&[...cards.values()].some(activity=>activity.state==='running'&&activity.terminal.command?.includes('time.sleep(120)')&&activity.terminal.pid>1&&activity.terminal.stdout?.includes('FOREGROUND_READY')))break;
        if(Date.now()-waitingLog>15000){log('await live '+action+' target',batch.length+' events');waitingLog=Date.now();}
        await new Promise(done=>setTimeout(done,250));
      }
      assert(livePort,'Qwen failed to start a managed server for '+action);assert.equal(await refuses(Number(livePort)),false);
      if(action==='Stop'){
        await stage('normal chat Stop IPC while terminal and managed server are live',()=>page.evaluate(({id,generation})=>window.localAi.chat.stop(id,generation),{id:conversation.id,generation}),15000);await capture();
        assert(events.slice(start).some(event=>event.type==='cancelled'));assert(identity(state.serverPid)?.startTime===state.serverStartTime,'Stop must preserve owned model server');
      }else{
        // Archive only this test conversation before shutdown; never copy or remove user evidence.
        await writeFile(join(report,'test-messages.json'),JSON.stringify(await page.evaluate(id=>window.localAi.messages.list(id),conversation.id),null,2));
        await stage('normal application shutdown with live owned work',()=>app.close(),20000);app=null;page=null;
      }
      for(let attempt=0;attempt<30&&!(await refuses(Number(livePort)));attempt++)await new Promise(done=>setTimeout(done,100));
      assert.equal(await refuses(Number(livePort)),true,'Managed listener survives '+action);
      assert.equal(identity(sentinel.pid)?.startTime,sentinelIdentity.startTime,'Unrelated isolated sentinel was terminated');
      const trace=(await readFile(join(report,'provider-trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      scenarios.push({name:'live '+action,generation,modelIterations:trace.filter(record=>record.kind==='provider_request'&&record.run_id===generation).length,toolCalls:events.slice(start).filter(event=>event.type==='tool'&&event.activity?.state==='running'&&event.activity.toolName).length,port:Number(livePort),listenerStopped:true,sentinelSurvived:true});
      await writeFile(join(report,'scenarios.json'),JSON.stringify(scenarios,null,2));
    }
    // Shutdown has completed: a fresh ordinary main can delete this test chat through its trusted DB API without launching a model.
    const db=require('../dist/main/services/database.js');
    const store=new db.Database(normalPaths.database);store.deleteConversation(conversation.id);store.close();await require('../dist/main/services/agent-evidence.js').discardAgentEvidence(normalPaths.userData,conversation.id,true);conversation=null;
    for(let attempt=0;attempt<30;attempt++){owned.refresh();nativeCleanupSurvivors=owned.live().filter(record=>record.pid!==sentinel.pid);if(!nativeCleanupSurvivors.length)break;await new Promise(done=>setTimeout(done,100));}
    assert.deepEqual(nativeCleanupSurvivors,[],'Application shutdown left owned processes requiring forced cleanup');
  }
  completed=true;log('PASS real Qwen scenarios',report);
} catch(error){fatal=error;log('FAIL',String(error));throw error;}
finally {
  const errors=[];const release=async(name,action,timeout=5000)=>{try{await stage(name,action,timeout);}catch(error){errors.push(String(error));}};
  if(page&&conversation&&generation&&!completed)await release('cancel own generation',()=>page.evaluate(({id,generation})=>window.localAi.chat.stop(id,generation),{id:conversation.id,generation}));
  if(normalConfiguration&&page&&conversation)await release('archive and remove only test conversation',async()=>{
    await writeFile(join(report,'test-messages.json'),JSON.stringify(await page.evaluate(id=>window.localAi.messages.list(id),conversation.id),null,2));
    await page.evaluate(id=>window.localAi.conversations.delete(id),conversation.id);conversation=null;
  });
  if(app)await release('close own application and model supervisor',()=>app.close(),20000);
  if(developmentOnly)await release('verify native shutdown before fallback cleanup',async()=>{
    for(let attempt=0;attempt<30;attempt++){owned.refresh();nativeCleanupSurvivors=owned.live();if(!nativeCleanupSurvivors.length)break;await new Promise(done=>setTimeout(done,100));}
    assert.deepEqual(nativeCleanupSurvivors,[],'Native shutdown left owned children');
  });
  await release('stop remaining positively owned children',()=>owned.stop(),5000);clearInterval(monitor);
  for(const pipe of child?.stdio??[])pipe?.destroy?.();
  if(normalConfiguration&&conversation)await release('remove only test conversation after shutdown',async()=>{const {Database}=require('../dist/main/services/database.js');const store=new Database(normalPaths.database);try{store.deleteConversation(conversation.id);}finally{store.close();}await require('../dist/main/services/agent-evidence.js').discardAgentEvidence(normalPaths.userData,conversation.id,true);conversation=null;});
  for(const [source,target] of [[workspace,'project'],...(normalConfiguration?[]:[[join(runtime,'logs'),'application-logs'],[join(runtime,'sqlite'),'sqlite'],[join(runtime,'app-data/agent-evidence'),'agent-evidence']])]){
    try{await cp(source,join(report,target),{recursive:true});}catch(error){if(error.code!=='ENOENT')errors.push(String(error));}
  }
  for(const name of ['protected-runtime-events.jsonl','protected-runtime.json']){
    try{await cp(join(runtime,name),join(report,name));}catch(error){if(error.code!=='ENOENT')errors.push(String(error));}
  }
  try{await cp(ledger,join(report,'owned-ledger.json'));}catch(error){if(error.code!=='ENOENT')errors.push(String(error));}
  if(normalConfiguration&&originalSettings){await release('verify ordinary settings and existing conversations unchanged',async()=>{
    assert.equal(digest(await readFile(settingsPath)),digest(originalSettings),'User configuration was modified');
    const after=databaseSnapshot();const changes=[];for(const [table,rows] of Object.entries(originalDatabase)){const remaining=new Set(after[table]);for(const row of rows)if(!remaining.has(row))changes.push(table+': '+digest(row));}
    await writeFile(join(report,'preservation.json'),JSON.stringify({settingsPath,settingsUnchanged:true,existingRowsChanged:changes,nativeCleanupSurvivors},null,2));assert.deepEqual(changes,[],'Existing user rows changed');
    for(const record of existingProcesses){if(record.state==='Z')continue;const current=identity(record.pid);if(current&&current.startTime===record.startTime&&['T','t'].includes(record.state))assert.equal(current.state,record.state);}
  });}
  await writeFile(join(report,'summary.json'),JSON.stringify({completed,normalConfiguration,settingsPath,nativeCleanupSurvivors,error:fatal?String(fatal):null,scenarios,toolApprovalPrompts:events.filter(event=>event.type==='approval-request').length,dialogEvidence,cleanupErrors:errors,ownedProcesses:[...owned.records.values()],ownedSurvivors:owned.live(),root},null,2));
  await rm(root,{recursive:true,force:true});
  if(errors.length)throw new Error('Qwen cleanup errors: '+errors.join('; '));
}
