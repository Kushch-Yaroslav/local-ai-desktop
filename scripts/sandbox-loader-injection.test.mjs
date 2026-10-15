import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { _electron as electron } from 'playwright-core';
import { bounded, OwnedProcesses } from './sandbox-fixture-lifecycle.mjs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { agentRuntimeEnvironment }=require('../dist/main/services/agent-environment.js');
const run=promisify(execFile);
const root=await mkdtemp(join(tmpdir(),'lad-loader-regression-'));
const workspace=join(root,'workspace'),runtime=join(root,'runtime'),marker=join(workspace,'marker.log'),library=join(workspace,'marker.so');
const resultFile=join(root,'result.json'),ledger=join(runtime,'owned.json');
const owned=new OwnedProcesses(process.pid,ledger);
let app,child,provider,monitor;
let stopping=false;
let runCompleted=false;
const observed=[];
const sockets=new Set();
const note=message=>console.log('[loader regression] '+message);
const markers=async()=>{try{return (await readFile(marker,'utf8')).split('\n').filter(Boolean);}catch(error){if(error.code!=='ENOENT')throw error;return [];}};
const reset=()=>writeFile(marker,'');
try {
  assert.notEqual(process.getuid(),0);
  const modes=new Map();
  for(const entry of await readdir('/sys/kernel/security/apparmor/policy/profiles')){
    if(!entry.startsWith('local_ai_desktop_bwrap'))continue;
    const base='/sys/kernel/security/apparmor/policy/profiles/'+entry;
    modes.set((await readFile(join(base,'name'),'utf8')).trim(),(await readFile(join(base,'mode'),'utf8')).trim());
  }
  for(const name of ['local_ai_desktop_bwrap','local_ai_desktop_bwrap_child'])assert.equal(modes.get(name),'enforce');
  await mkdir(workspace);await mkdir(runtime);
  monitor=setInterval(()=>owned.refresh(),100);
  const source=`
#define _GNU_SOURCE
#include <link.h>
#include <stdio.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <sys/syscall.h>
static void marker(const char *kind){
 char exe[1024]={0},label[512]={0};ssize_t n=readlink("/proc/self/exe",exe,sizeof(exe)-1);if(n>=0)exe[n]=0;
 FILE *f=fopen("/proc/self/attr/current","r");if(f){fgets(label,sizeof(label),f);fclose(f);}
 for(char *p=label;*p;p++)if(*p=='\\n')*p=' ';
 int seccomp=-1,nnp=-1;char line[512],cap[64]={0};
 f=fopen("/proc/self/status","r");if(f){while(fgets(line,sizeof(line),f)){sscanf(line,"Seccomp: %d",&seccomp);sscanf(line,"NoNewPrivs: %d",&nnp);if(!strncmp(line,"CapEff:",7))sscanf(line+7,"%63s",cap);}fclose(f);}
 errno=0;long ur=syscall(SYS_unshare,0);int ue=errno;
 errno=0;long mr=syscall(SYS_mount,0,0,0,0,0);int me=errno;
 long host_signal=syscall(SYS_kill,${process.pid},0);
 f=fopen(${JSON.stringify(marker)},"a");if(f){fprintf(f,"%s pid=%d exe=%s label=%s seccomp=%d nnp=%d cap=%s unshare=%ld:%d mount=%ld:%d host_signal=%ld\\n",kind,getpid(),exe,label,seccomp,nnp,cap,ur,ue,mr,me,host_signal);fclose(f);}
}
__attribute__((constructor)) static void constructor(void){marker("constructor");}
unsigned int la_version(unsigned int version){marker("audit");return LAV_CURRENT;}
`;
  await writeFile(join(root,'marker.c'),source);
  await run('/usr/bin/cc',['-shared','-fPIC','-o',library,join(root,'marker.c')],{timeout:15000});
  const fixed={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'};
  // Apply poisoned variables only AFTER aa-exec entered unconfined. Otherwise
  // aa-exec's own secure transition could strip them and fake a passing test.
  const supervisor=join(root,'unconfined-exec.py');
  await writeFile(supervisor,"import json,subprocess,sys\nenv=json.loads(sys.argv[1])\np=subprocess.run(sys.argv[2:],env=env,stdin=subprocess.DEVNULL,capture_output=True,timeout=8)\nsys.stdout.buffer.write(p.stdout);sys.stderr.buffer.write(p.stderr);sys.exit(p.returncode)\n");
  const unconfined=(args,env)=>run('/usr/bin/aa-exec',['-p','unconfined','--','/usr/bin/python3',supervisor,JSON.stringify(env),...args],{env:fixed,timeout:10000,maxBuffer:64000});
  for(const variable of ['LD_AUDIT','LD_PRELOAD']){
    await reset();
    await unconfined(['/usr/lib/local-ai-desktop/bwrap','--version'],{...fixed,[variable]:library});
    const control=await markers();
    assert(control.some(line=>line.includes('exe=/usr/lib/local-ai-desktop/bwrap')&&line.includes('local_ai_desktop_bwrap (enforce)')),'positive control must execute real marker library under setup');
    note(variable+' positive control confirmed');
    await reset();
    // Deliberately poison the raw CLI caller to test the Rust→bwrap boundary
    // independently. Its own loader may run; bwrap's loader must never do so.
    const direct=await unconfined([resolve('rust-agent/target/debug/local-ai-agent-runtime'),'--terminal-exec',workspace,'echo confined-payload','3000'],{...fixed,HOME:process.env.HOME,[variable]:library});
    const result=JSON.parse(direct.stdout);
    assert.equal(result.exit_code,0);assert.match(result.stdout,/confined-payload/);
    assert(!(await markers()).some(line=>line.includes('exe=/usr/lib/local-ai-desktop/bwrap')),'setup injection must be absent');
    note(variable+' rejected at Rust→Bubblewrap; confined payload executed successfully');
  }
  await reset();
  const poison={...fixed,HOME:process.env.HOME,HTTPS_PROXY:'http://fixture.invalid',LD_AUDIT:library,LD_PRELOAD:library,LD_LIBRARY_PATH:root,LD_DEBUG:'all',GLIBC_TUNABLES:'hostile',GCONV_PATH:root,NODE_OPTIONS:'--require hostile',BASH_ENV:join(root,'startup')};
  const safe=agentRuntimeEnvironment(poison);
  const direct=await unconfined([resolve('rust-agent/target/debug/local-ai-agent-runtime'),'--terminal-exec',workspace,'echo confined-payload','3000'],safe);
  assert.equal(JSON.parse(direct.stdout).exit_code,0);assert.deepEqual(await markers(),[]);
  note('Closed Electron→Rust environment: zero runtime/bootstrap/setup markers');
  // An x deny controls execve of the helper path. Executing its bytes through
  // the system ELF loader is a distinct path, and must never regain setup
  // rights. Marker-only code measures the actual inherited kernel boundary.
  const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
  await reset();
  const manual=await unconfined([resolve('rust-agent/target/debug/local-ai-agent-runtime'),'--terminal-exec',workspace,
    `LD_AUDIT=${quote(library)} /lib64/ld-linux-x86-64.so.2 /usr/lib/local-ai-desktop/bwrap --version`,'3000'],safe);
  assert.equal(JSON.parse(manual.stdout).exit_code,0);
  const confined=await markers();assert(confined.length>0,'manual-loader positive control must load the marker');
  for(const record of confined){
    assert(record.includes('local_ai_desktop_bwrap//&local_ai_desktop_bwrap_child (enforce)'),record);
    assert(record.includes('seccomp=2 nnp=1 cap=0000000000000000'),record);
    assert(record.includes('unshare=-1:1 mount=-1:1 host_signal=-1'),record);
  }
  note('Measured manual-loader payload: '+confined[0]);
  note('Manual ELF-loader path can run helper bytes, but retains enforcing child, seccomp/NNP, zero capabilities and blocked namespace/mount/host signal-0; no setup reacquisition');
  await reset();
  const directHelper=await unconfined([resolve('rust-agent/target/debug/local-ai-agent-runtime'),'--terminal-exec',workspace,'/usr/lib/local-ai-desktop/bwrap --version','3000'],safe);
  const denial=JSON.parse(directHelper.stdout);assert.equal((denial.execution??denial).exit_code,126);assert.deepEqual(await markers(),[]);
  provider=createServer(async(request,response)=>{
    try{
      let raw='';for await(const part of request){raw+=part;if(raw.length>1000000)throw Error('large fixture request');}
      const input=JSON.parse(raw),last=input.messages.findLast(message=>message.role==='tool');
      if(last)observed.push(JSON.parse(last.content.split('\n')[0]));
      const delta=last?{content:'Loader fixture finished'}:{tool_calls:[{index:0,id:'loader-pwd',type:'function',function:{name:'run_terminal',arguments:JSON.stringify({command:'pwd',timeout_ms:3000})}}]};
      response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:last?'stop':'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
    }catch(error){response.writeHead(500);response.end(String(error));}
  });
  provider.requestTimeout=5000;provider.headersTimeout=5000;provider.keepAliveTimeout=1000;
  provider.on('connection',socket=>{sockets.add(socket);socket.setTimeout(5000,()=>socket.destroy());socket.once('close',()=>sockets.delete(socket));});
  await bounded('listen',()=>new Promise((done,reject)=>{provider.once('error',reject);provider.listen(0,'127.0.0.1',done);}));
  app=await bounded('Electron launch',()=>electron.launch({chromiumSandbox:true,timeout:10000,executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/agent-reliability/sandbox-startup-main.cjs')],env:{...process.env,LOCAL_AI_TEST_INHERIT_APPARMOR_LABEL:'',LOCAL_AI_SANDBOX_TRACE:join(root,'trace.jsonl'),LOCAL_AI_SANDBOX_LEDGER:ledger,LOCAL_AI_SANDBOX_RESULT:resultFile,LOCAL_AI_SANDBOX_TRIGGER:join(root,'start.json'),LOCAL_AI_RUNTIME_ROOT:runtime,LOCAL_AI_SANDBOX_WORKSPACE:workspace,LOCAL_AI_AGENT_ENDPOINT:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`}}),12000);
  child=app.process();await app.firstWindow({timeout:5000});
  const context=await bounded('actual Electron context',async()=>{
    for(;;){try{return JSON.parse(await readFile(resultFile+'.context.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(done=>setTimeout(done,50));}
  });assert.equal(context.label,'unconfined');
  // A fixture-owned trigger applies exact marker paths after trusted Electron
  // startup, before the real production stream spawn. No user app is poisoned.
  const electronPoison={LD_AUDIT:library,LD_PRELOAD:library,LD_LIBRARY_PATH:root,LD_DEBUG:'all',GLIBC_TUNABLES:'hostile',GCONV_PATH:root,NODE_OPTIONS:'--require hostile',BASH_ENV:root+'/startup'};
  await writeFile(join(root,'start.json'),JSON.stringify({environment:electronPoison,waitForConfirmation:true}));
  const actualEnvironment=await bounded('loader environment before Rust spawn',async()=>{
    for(;;){try{return JSON.parse(await readFile(resultFile+'.environment.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(done=>setTimeout(done,50));}
  },5000);
  assert.deepEqual(actualEnvironment,electronPoison);
  assert.equal(observed.length,0,'Rust must not contact the provider before environment confirmation');
  assert(!(await readFile(join(root,'trace.jsonl'),'utf8')).includes('local-ai-agent-runtime'),'Rust must not spawn before exact environment confirmation');
  note('Confirmed BEFORE Rust spawn: '+JSON.stringify(actualEnvironment));
  await writeFile(join(root,'start.json.confirmed'),JSON.stringify(actualEnvironment));
  const outcome=await bounded('run completion',async()=>{
    while(!stopping){try{const value=JSON.parse(await readFile(resultFile,'utf8'));if(value.error)throw Error(value.error);return value;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(done=>setTimeout(done,100));}
    throw Error('Fixture stopped before run completion');
  },15000);
  assert.deepEqual(JSON.parse(await readFile(resultFile+'.environment.json','utf8')),electronPoison,'Exact inherited loader paths must actually reach Electron before stream spawn');
  assert(outcome.alive);assert.deepEqual(outcome.approvalRequests,[]);assert(outcome.events.some(event=>event.type==='token'&&event.content.includes('Loader fixture finished')));
  runCompleted=true;
  assert(observed.some(result=>result.exit_code===0&&result.stdout===workspace+'\n'),'actual Electron run must execute the confined payload');
  assert.deepEqual(await markers(),[],'actual Electron→Rust→bwrap path must never load either marker');
  note('Actual unconfined Electron→Rust→Bubblewrap: successful confined pwd, zero audit/preload markers, zero Autopilot prompts');
} finally {
  stopping=true;
  const errors=[];
  const release=async(operation)=>{try{await operation();}catch(error){errors.push(error);}};
  if(app&&!runCompleted){try{await bounded('cancel',()=>app.evaluate(()=>{global.sandboxFixture.cancel();return true;}),2000);}catch{/* ownership cleanup remains */}}
  if(app)await release(()=>bounded('close Electron',()=>app.close(),3000));
  await release(()=>owned.stop());clearInterval(monitor);
  for(const pipe of child?.stdio ?? [])pipe?.destroy?.();
  if(provider){for(const socket of sockets)socket.destroy();provider.closeAllConnections();await release(()=>bounded('close provider',()=>new Promise(done=>provider.close(done)),2000));}
  await release(()=>rm(root,{recursive:true,force:true}));
  if(errors.length)throw new AggregateError(errors,'Loader fixture cleanup failed');
}
