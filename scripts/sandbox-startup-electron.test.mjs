import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { bounded, OwnedProcesses } from './sandbox-fixture-lifecycle.mjs';
import { _electron as electron } from 'playwright-core';
const log=(stage,detail='')=>console.log(`[sandbox ${new Date().toISOString()}] ${stage}${detail?' — '+detail:''}`);
async function stage(label,operation,timeout=5000){
  log('START '+label);
  try {const value=await bounded(label,operation,timeout);log('OK '+label);return value;}
  catch(error){log('FAIL '+label,String(error));throw error;}
}
const expectBlocked=process.argv.includes('--expect-blocked');
const inheritedLabel=process.argv.includes('--inherited-label');
let root,workspace,runtime,resultFile,traceFile,ledgerFile,startTrigger,provider,app,electronChild,context,owned,monitor,watchdog;
let step=0,sequence=0,taskId,port,statusChecks=0,fatal,traceCount=0,pendingSince,pendingStage;
const sockets=new Set();
const activeRequests=new Set();
let cleanupPromise,finishPromise;
let runCompleted=false;
async function cleanup(){
  cleanupPromise ??= (async()=>{
    log('START cleanup');
    const errors=[];
    const release=async(label,operation,timeout)=>{try{await stage(label,operation,timeout);}catch(error){errors.push(error);}};
    if(app && !runCompleted)await release('cancel fixture run',()=>app.evaluate(()=>{global.sandboxFixture?.cancel();return true;}),2000);
    if(app)await release('close fixture Electron IPC',()=>app.close(),3000);
    if(owned){owned.refresh();log('Fixture-owned PID cleanup',owned.live().map(record=>record.pid).join(', '));await release('stop fixture-owned processes',()=>owned.stop(),4000);}
    clearInterval(monitor);
    for(const pipe of electronChild?.stdio ?? [])pipe?.destroy?.();
    if(provider){
      for(const socket of sockets)socket.destroy();provider.closeAllConnections();
      await release('close HTTP provider',()=>new Promise((resolveClose,reject)=>provider.close(error=>error && error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolveClose())),2000);
    }
    if(root)await release('remove fixture files',()=>rm(root,{recursive:true,force:true}),3000);
    if(errors.length)throw new AggregateError(errors,'Fixture cleanup failed');
    log('OK cleanup');
  })();
  return cleanupPromise;
}
async function main(){
assert.notEqual(process.getuid(),0,'acceptance must run as the ordinary application user');
await stage('AppArmor installation/enforcement preflight',async()=>{
  let helper;try{helper=await lstat('/usr/lib/local-ai-desktop/bwrap');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!helper){assert(expectBlocked,'Dedicated helper is not installed; enforcing acceptance cannot run');log('Pre-install fail-closed diagnostic (not enforcing acceptance)');return;}
  assert(helper.isFile() && helper.uid===0 && (helper.mode & 0o6022)===0,'installed private helper must be trusted');
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(await readFile('/usr/lib/local-ai-desktop/bwrap')),digest(await readFile('/usr/bin/bwrap')),'helper must match distro binary');
  assert.equal(await readFile('/etc/apparmor.d/local-ai-desktop-bwrap','utf8'),await readFile('assets/apparmor/local-ai-desktop-bwrap','utf8'),'installed policy must match reviewed asset');
  const directory='/sys/kernel/security/apparmor/policy/profiles';
  const installed=new Map();
  for(const entry of await readdir(directory)){
    if(!entry.startsWith('local_ai_desktop_bwrap'))continue;
    const name=(await readFile(join(directory,entry,'name'),'utf8')).trim();
    const mode=(await readFile(join(directory,entry,'mode'),'utf8')).trim();installed.set(name,mode);
  }
  for(const name of ['local_ai_desktop_bwrap','local_ai_desktop_bwrap_child'])assert.equal(installed.get(name),'enforce',name+' must be installed and enforcing');
  log('Verified dedicated helper and both kernel profiles in enforce mode');
});
root=await stage('create isolated fixture',()=>mkdtemp(join(tmpdir(),'lad-unconfined-sandbox-')));
workspace=join(root,'workspace');runtime=join(root,'runtime');resultFile=join(root,'result.json');
startTrigger=join(root,'start.json');
traceFile=join(root,'trace.jsonl');ledgerFile=join(runtime,'owned-processes.json');
owned=new OwnedProcesses(process.pid,ledgerFile);
monitor=setInterval(()=>{try{owned.refresh();}catch(error){fatal ??= error;}},100);
const observed=[];
const runtimeExecutable=resolve(process.env.LOCAL_AI_AGENT_RUNTIME ?? 'rust-agent/target/debug/local-ai-agent-runtime');
const shellQuote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const commands=['pwd','ls -la','echo sandbox-echo-ok','cat hello.txt','python3 write.py','python3 stdin.py'];
const tool = argumentsObject => {pendingSince=Date.now();pendingStage=argumentsObject.task_action ?? argumentsObject.command;log('SEND tool '+pendingStage);return ({tool_calls:[{index:0,id:`call-${++sequence}`,type:'function',function:{name:'run_terminal',arguments:JSON.stringify({...argumentsObject,timeout_ms:argumentsObject.timeout_ms ?? 3000})}}]});};
await mkdir(workspace); await mkdir(runtime);
await writeFile(join(workspace,'stdin.py'),"import sys\nassert sys.stdin.read() == ''\nprint('terminal-stdin-eof')\n");

await writeFile(join(workspace,'write.py'),"from pathlib import Path\np=Path('generated.txt');p.write_text('workspace-write-ok');print(p.read_text())\n");
await writeFile(join(workspace,'helper.py'),"import os,sys\ntry: os.execv('/usr/lib/local-ai-desktop/bwrap',['bwrap','--version'])\nexcept PermissionError: print('Permission denied',file=sys.stderr);sys.exit(126)\n");
await writeFile(join(workspace,'nested.py'),"import subprocess,sys\nr=subprocess.run("+JSON.stringify([runtimeExecutable,'--terminal-exec',workspace,'printf unsafe-fallback > unsafe-fallback.txt','3000'])+",capture_output=True,text=True,timeout=5)\nprint(r.stdout,end='');print(r.stderr,file=sys.stderr,end='');sys.exit(r.returncode)\n");
await writeFile(join(workspace,'hello.txt'),'sandbox-cat-ok\n');
await writeFile(join(workspace,'server.py'),"from http.server import HTTPServer,BaseHTTPRequestHandler\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'owned-http-ok')\ns=HTTPServer(('127.0.0.1',0),Handler)\nprint('READY:'+str(s.server_port),flush=True)\ns.serve_forever()\n");
await writeFile(join(workspace,'request.py'),"import sys,urllib.request\nprint(urllib.request.urlopen('http://127.0.0.1:'+sys.argv[1],timeout=2).read().decode())\n");
await writeFile(join(workspace,'stopped.py'),"import sys,socket\ns=socket.socket();s.settimeout(1)\nassert s.connect_ex(('127.0.0.1',int(sys.argv[1])))!=0\nprint('owned-http-stopped')\n");
await writeFile(join(workspace,'namespace.py'),"import os,json,ctypes\nc=ctypes.CDLL(None,use_errno=True)\nr=[c.syscall(62,pid,15) for pid in "+JSON.stringify([])+"]\nprint(json.dumps({'pid':os.getpid(),'pid_ns':os.readlink('/proc/self/ns/pid'),'uid_map':open('/proc/self/uid_map').read().strip(),'gid_map':open('/proc/self/gid_map').read().strip(),'status':open('/proc/self/status').read(),'label':open('/proc/self/attr/current').read().strip()}))\n");
provider=createServer(async(request,response)=>{
  try {
    log('HTTP provider request');
    activeRequests.add(request.socket);
    const complete=()=>activeRequests.delete(request.socket);
    response.once('finish',complete);response.once('close',complete);
    pendingSince ??= Date.now();pendingStage ??= 'scripted provider HTTP response';
    if(process.argv.includes('--stall-provider'))return;
    let raw='';for await(const part of request){raw+=part;if(raw.length>2_000_000)throw Error('Fixture request too large');}
    const input=JSON.parse(raw);
    const last=input.messages.findLast(message=>message.role==='tool');
    if(last && last.tool_call_id!==observed.at(-1)?.id){
      let result; try { result=JSON.parse(last.content.split("\n")[0]); } catch { result={raw:last.content}; }
      observed.push({id:last.tool_call_id,result});
      log('RESULT '+pendingStage,JSON.stringify(result).slice(0,1800));
      pendingSince=undefined;
      const intentionalFailure=step>=commands.length+6;
      if(!expectBlocked && !intentionalFailure && (result.error || result.status==='error' || (result.exit_code!=null && result.exit_code!==0)))throw Error(`${pendingStage} failed: ${JSON.stringify(result)}`);
      if(result.task_id)taskId=result.task_id;
      port=result.output?.match(/READY:(\d+)/)?.[1] ?? port;
    }
    let delta, finish='tool_calls';
    if(expectBlocked && observed.length){delta={content:'Blocked fixture completed'};finish='stop';}
    else if(step<commands.length){const command=commands[step++];delta=tool({command,timeout_ms:command==='python3 stdin.py'?1000:5000});}
    else if(step===commands.length){step++;delta=tool({command:'python3 namespace.py'});}
    else if(step===commands.length+1){step++;delta=tool({task_action:'start',command:'python3 server.py'});}
    else if(step===commands.length+2){if(port && statusChecks>0){step++;delta=tool({command:`python3 request.py ${port}`});}else{if(statusChecks>=25)throw Error('Managed HTTP readiness timed out');statusChecks++;await new Promise(done=>setTimeout(done,100));delta=tool({task_action:'status',task_id:taskId,command:''});}}
    else if(step===commands.length+3){step++;delta=tool({task_action:'stop',task_id:taskId,command:''});}
    else if(step===commands.length+4){step++;delta=tool({command:`python3 stopped.py ${port}`});}
    else if(step===commands.length+5){step++;delta=tool({command:`kill -0 ${context.dummyPid}`});}
    else if(step===commands.length+6){step++;delta=tool({command:'python3 helper.py'});}
    else if(step===commands.length+7){step++;delta=tool({command:'python3 nested.py'});}
    else {delta={content:'Sandbox fixture verified'};finish='stop';}
    if(sequence>80)throw new Error('Fixture failed to become ready');
    response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);
  } catch(error){fatal ??= error;log('FAIL provider stage',String(error));if(!response.headersSent)response.writeHead(500);response.end(String(error));}
});
provider.requestTimeout=5000;provider.headersTimeout=5000;provider.keepAliveTimeout=1000;
provider.on('connection',socket=>{sockets.add(socket);socket.setTimeout(5000,()=>{if(activeRequests.has(socket))fatal ??= Error('Scripted provider HTTP response timed out after 5000 ms');socket.destroy();});socket.once('close',()=>sockets.delete(socket));});
await stage('start scripted HTTP provider',()=>new Promise((resolveListen,reject)=>{provider.once('error',reject);provider.listen(0,'127.0.0.1',()=>{provider.removeListener('error',reject);resolveListen();});}));
provider.on('error',error=>{fatal ??= error;});

  await chmod('scripts/electron-unconfined-fixture.sh',0o755);
  app=await stage('launch unconfined Electron fixture',()=>electron.launch({chromiumSandbox:true,timeout:10000,executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/agent-reliability/sandbox-startup-main.cjs')],env:{...process.env,LOCAL_AI_SANDBOX_TRACE:traceFile,LOCAL_AI_SANDBOX_LEDGER:ledgerFile,LOCAL_AI_SANDBOX_RESULT:resultFile,LOCAL_AI_SANDBOX_TRIGGER:startTrigger,LOCAL_AI_TEST_INHERIT_APPARMOR_LABEL:inheritedLabel?'1':'',LOCAL_AI_RUNTIME_ROOT:runtime,LOCAL_AI_SANDBOX_WORKSPACE:workspace,LOCAL_AI_AGENT_ENDPOINT:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`}}),12000);
  electronChild=app.process();
  app.on('close',()=>{fatal ??= Error('Fixture Electron closed unexpectedly');});
  owned.refresh();
  await stage('first fixture window',()=>app.firstWindow({timeout:5000}));
  if(process.argv.includes('--stall-ipc'))await stage('injected stalled IPC',()=>app.evaluate(()=>{global.sandboxFixture.stalledPromise=new Promise(()=>{});return global.sandboxFixture.stalledPromise;}),2000);
  context=await stage('read fixture context IPC',()=>app.evaluate(()=>global.sandboxFixture.context));
  assert.equal(context.uid,process.getuid());assert.equal(context.gid,process.getgid());
  if(!inheritedLabel)assert.equal(context.label,'unconfined','test must match the real application label');
  await writeFile(join(workspace,'host.json'),JSON.stringify(context));
  await writeFile(join(workspace,'protected.py'),`import ctypes,json\nh=json.load(open('host.json'))\nc=ctypes.CDLL(None)\nassert c.syscall(62,h['pid'],0)==-1\nassert c.syscall(62,h['dummyPid'],0)==-1\nprint('protected-host-inaccessible')\n`);
  // The namespace check includes a direct syscall attack after the metadata.
  const namespace=await readFile(join(workspace,'namespace.py'),'utf8');
  const seccompProbe="import errno\nc=ctypes.CDLL(None,use_errno=True)\nstatus=open('/proc/self/status').read()\nassert 'NoNewPrivs:\\t1' in status and 'Seccomp:\\t2' in status\nfor syscall,args in [(165,(0,0,0,0,0)),(166,(0,0)),(272,(0,)),(308,(-1,0)),(311,(0,0,0,0,0,0))]:\n ctypes.set_errno(0)\n assert c.syscall(syscall,*args)==-1 and ctypes.get_errno()==errno.EPERM, str(syscall)\nprint('seccomp-harmless-probes-blocked')\n";
  // Invalid operands / zero flags make these checks non-destructive even if a
  // regression allows a syscall. Only the isolation filter should yield EPERM.
  await writeFile(join(workspace,'namespace.py'),namespace+await readFile(join(workspace,'protected.py'),'utf8')+seccompProbe);
  // Use the fixture's existing file control channel. DevTools evaluation of a
  // busy Electron main context can fail with "Promise was collected" even for
  // a synchronous return value; that is not an Agent/sandbox failure.
  await stage('start Rust acceptance run',()=>writeFile(startTrigger,JSON.stringify({environment:{}})));
  log('START await acceptance result');
  let outcome;
  for(let attempt=0;attempt<400;attempt++){
    if(fatal)throw fatal;
    if(pendingSince && Date.now()-pendingSince>6000)throw Error(`Tool/HTTP stage ${pendingStage} timed out after 6000 ms`);
    try{const entries=(await readFile(traceFile,'utf8')).trim().split('\n');for(const entry of entries.slice(traceCount)){const trace=JSON.parse(entry);log('FIXTURE '+trace.stage,trace.detail);}traceCount=entries.length;}catch(error){if(error.code!=='ENOENT')throw error;}
    try{outcome=JSON.parse(await readFile(resultFile,'utf8'));}catch{ /* Fixture still running. */ }
    if(outcome?.events || outcome?.error)break;
    await new Promise(done=>setTimeout(done,100));
  }
  assert(!outcome?.error,outcome?.error);
  assert(outcome?.events,'Fixture did not finish: '+JSON.stringify({step,taskId,port,last:observed.slice(-3)}));
  runCompleted=true;
  log('OK acceptance result');
  log('START acceptance assertions');
  const events=outcome.events;
  const runtimeError=events.find(event=>event.type==='error');
  assert(!runtimeError,'Rust run failed during '+(pendingStage ?? 'startup')+': '+JSON.stringify(runtimeError));
  assert(outcome.alive);
  assert.deepEqual(outcome.approvalRequests,[],'Scoped Autopilot must not request permission for the authorized fixture');
  assert(!events.some(event=>event.type==='approval-request'),'no approval UI events');
  if(expectBlocked){
    assert(observed.some(({result})=>result.code==='PROTECTED_RUNTIME_PROCESS' && result.setup_required===true && result.retrySameArguments===false));
    console.log('Reproduced Electron (unconfined, UID/GID '+context.uid+'/'+context.gid+') → Rust → bwrap structured sandbox startup denial; protected fixture host processes survived.');
  }else{
    assert(observed.some(({result})=>result.task_id===taskId && result.status==='running'),'managed status must confirm running task');
    assert(observed.some(({result})=>result.task_id===taskId && result.status==='stopped'),'managed stop must confirm stopped task');
    const results=JSON.stringify(observed);
    for(const expected of ['terminal-stdin-eof','sandbox-echo-ok','sandbox-cat-ok','workspace-write-ok','owned-http-ok','owned-http-stopped','protected-host-inaccessible','seccomp-harmless-probes-blocked','PROTECTED_RUNTIME_PROCESS'])assert(results.includes(expected),expected+': '+results);
    assert(observed.some(({result})=>result.stdout===workspace+'\n'),'pwd');
    assert(observed.some(({result})=>result.stdout?.includes('hello.txt')),'ls');
    const info=JSON.parse(observed.find(({result})=>result.stdout?.includes('uid_map')).result.stdout.split('\n')[0]);
    assert.match(info.status,/NoNewPrivs:\s+1/);assert.match(info.status,/Seccomp:\s+2/);
    for(const cap of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(info.status,new RegExp(cap+':\\s+0+'));
    assert.notEqual(info.pid_ns,context.pidNamespace,'payload must be in a separate PID namespace');
    assert.match(info.uid_map,new RegExp('\\b'+context.uid+'\\b'));assert.match(info.gid_map,new RegExp('\\b'+context.gid+'\\b'));
    if(!inheritedLabel){
      assert(info.label.includes('local_ai_desktop_bwrap//&local_ai_desktop_bwrap_child'),'payload must retain both stacked profiles: '+info.label);
      assert(info.label.endsWith(' (enforce)'),'payload must be enforcing: '+info.label);
    }
    assert.equal(await readFile(join(workspace,'generated.txt'),'utf8'),'workspace-write-ok');
    const helperProbe=observed.at(-2).result.execution ?? observed.at(-2).result;
    assert.equal(helperProbe.exit_code,126,'direct helper must fail at exec');
    assert.match(helperProbe.stderr,/Permission denied/,'AppArmor must deny helper execution');
    console.log('Effective payload security:',JSON.stringify({label:info.label,security:info.status.split('\n').filter(line=>/^(NoNewPrivs|Seccomp|CapInh|CapPrm|CapEff|CapBnd|CapAmb):/.test(line)),pidNamespace:info.pid_ns,helperExecDenied:true}));
    // Re-exec the production executor inside its sandbox. It cannot establish
    // another namespace under the inherited seccomp/child policy. An insecure
    // fallback would execute the marker command, which must never happen.
    const failedStartup=observed.at(-1).result;
    const nested=JSON.parse(failedStartup.stdout.trim());
    assert.equal(nested.code,'PROTECTED_RUNTIME_PROCESS');
    assert(nested.setup_required===true || nested.error?.includes('sandbox helper must be a root-owned'),
      'nested execution must fail closed at namespace setup or helper identity validation');
    assert.equal(nested.retrySameArguments,false);
    await assert.rejects(readFile(join(workspace,'unsafe-fallback.txt')), {code:'ENOENT'});
    assert(events.some(e=>e.type==='token'&&e.content.includes('Sandbox fixture verified')));
    console.log(`${inheritedLabel?'Inherited-label comparison (NOT candidate-policy acceptance)':'Actual unconfined'} Electron → Rust → bwrap: pwd/ls/echo/cat, UID/GID maps, seccomp/NNP, managed HTTP response/stop, protected host processes, zero approval prompts and forced namespace failure without fallback passed. Parent label: ${context.label}`);
  }
  log('OK acceptance assertions');
}
async function finish(code){
  finishPromise ??= (async()=>{
  try{await cleanup();}catch(error){console.error('[sandbox] CLEANUP FAILED',error);code=1;}
  clearTimeout(watchdog);clearInterval(monitor);
  log('EXIT',String(code));process.exit(code);
  })();return finishPromise;
}
watchdog=setTimeout(()=>{console.error('[sandbox] Global 90-second watchdog expired');void finish(1);},90000);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{log('INTERRUPTED',signal);void finish(1);});
main().then(()=>finish(0),error=>{console.error('[sandbox] ACCEPTANCE FAILED',error);return finish(1);});
