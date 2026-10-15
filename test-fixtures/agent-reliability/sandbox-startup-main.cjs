const { app, BrowserWindow } = require('electron');
const { join, resolve } = require('node:path');
const { readFileSync, writeFileSync, appendFileSync, renameSync, readlinkSync, watchFile, unwatchFile } = require('node:fs');
const childProcess = require('node:child_process');
const ledger=[];
const trace=(stage,detail='')=>appendFileSync(process.env.LOCAL_AI_SANDBOX_TRACE,JSON.stringify({time:new Date().toISOString(),stage,detail})+'\n');
function record(pid) {
  try {
    const raw=readFileSync(`/proc/${pid}/stat`,'utf8');const fields=raw.slice(raw.lastIndexOf(') ')+2).trim().split(/\s+/);
    const ppid=Number(fields[1]);
    const parent=readFileSync(`/proc/${ppid}/stat`,'utf8');
    const parentStartTime=parent.slice(parent.lastIndexOf(') ')+2).trim().split(/\s+/)[19];
    ledger.push({pid,ppid,parentStartTime,startTime:fields[19]});
    writeFileSync(process.env.LOCAL_AI_SANDBOX_LEDGER+'.tmp',JSON.stringify(ledger));
    renameSync(process.env.LOCAL_AI_SANDBOX_LEDGER+'.tmp',process.env.LOCAL_AI_SANDBOX_LEDGER);
  } catch(error) { trace('ownership-record-error',String(error)); }
}
record(process.pid);
const originalSpawn=childProcess.spawn;
childProcess.spawn=function(...args){
  const child=originalSpawn.apply(this,args);
  child.once('spawn',()=>{record(child.pid);trace('child-spawn',`${child.pid}: ${args[0]}`);});
  child.once('error',error=>trace('child-error',String(error)));
  child.once('exit',(code,signal)=>trace('child-exit',`${child.pid}: ${code}/${signal}`));
  return child;
};
const { spawn }=childProcess;
let controller,runTimer;
trace('electron-entry');
app.disableHardwareAcceleration();
app.setPath('userData', join(process.env.LOCAL_AI_RUNTIME_ROOT, 'electron-profile'));
app.whenReady().then(() => {
  const { ensureAppDirectories } = require(resolve('dist/main/services/paths'));
  ensureAppDirectories();
  const { protectedRuntime } = require(resolve('dist/main/services/protected-runtime'));
  protectedRuntime.start();
  const { RustAgentRuntime } = require(resolve('dist/main/services/rust-agent-runtime'));
  const dummy = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
  trace('electron-ready');
  global.sandboxFixture = {
    context: { pid: process.pid, dummyPid: dummy.pid, uid: process.getuid(), gid: process.getgid(), pidNamespace:readlinkSync('/proc/self/ns/pid'), label: readFileSync('/proc/self/attr/current', 'utf8').trim() },
    async run() {
      const events = [];
      const approvalRequests = [];
      global.sandboxFixture.approvalRequests = approvalRequests;
      global.sandboxFixture.events = events;
      controller=new AbortController();
      runTimer=setTimeout(()=>{trace('run-timeout');controller.abort();},40000);
      const agent = new RustAgentRuntime(process.env.LOCAL_AI_AGENT_ENDPOINT);
      try { for await (const event of agent.stream('fixture', [{id:'u',conversationId:'sandbox',role:'user',content:'Run the sandbox acceptance fixture',createdAt:new Date().toISOString()}],
        [{ id:'workspace', slot:1, label:'Temporary sandbox project', root:process.env.LOCAL_AI_SANDBOX_WORKSPACE }],
        controller.signal,65536,'fast','off','sandbox-smoke',undefined,'sandbox',false,undefined,[],undefined,async request => { approvalRequests.push(request); return {approved:false,reason:'fixture_no_prompts'}; },undefined,{mode:'autonomous',trusted_roots:[]})) {events.push(event);if(event.type==='error')trace('runtime-error',JSON.stringify(event));}
      return events; } finally { clearTimeout(runTimer);trace('run-finished'); }
    },
    alive() { try { process.kill(dummy.pid, 0); return true; } catch { return false; } },
    cancel() {clearTimeout(runTimer);controller?.abort();trace('run-cancel');},
    start() {
      if(global.sandboxFixture.activeRun)return;
      trace('run-start');
      global.sandboxFixture.activeRun=global.sandboxFixture.run().then(events=>{
        writeFileSync(process.env.LOCAL_AI_SANDBOX_RESULT,JSON.stringify({events,approvalRequests:global.sandboxFixture.approvalRequests,alive:global.sandboxFixture.alive()}));
      },error=>{writeFileSync(process.env.LOCAL_AI_SANDBOX_RESULT,JSON.stringify({error:String(error)}));});
    },
  };
  writeFileSync(process.env.LOCAL_AI_SANDBOX_RESULT+'.context.json',JSON.stringify(global.sandboxFixture.context));
  const trigger=process.env.LOCAL_AI_SANDBOX_TRIGGER;
  if(trigger)watchFile(trigger,{interval:50},()=>{
    let control;try{control=JSON.parse(readFileSync(trigger,'utf8'));}catch{return;}
    unwatchFile(trigger);
    const allowed=['LD_AUDIT','LD_PRELOAD','LD_LIBRARY_PATH','LD_DEBUG','GLIBC_TUNABLES','GCONV_PATH','NODE_OPTIONS','BASH_ENV'];
    for(const [key,value] of Object.entries(control.environment??{})){if(!allowed.includes(key)||typeof value!=='string')throw Error('Invalid fixture environment key');process.env[key]=value;}
    writeFileSync(process.env.LOCAL_AI_SANDBOX_RESULT+'.environment.json',JSON.stringify(Object.fromEntries(allowed.filter(key=>key in (control.environment??{})).map(key=>[key,process.env[key]]))));
    if(control.waitForConfirmation){
      const confirmation=trigger+'.confirmed';
      watchFile(confirmation,{interval:50},()=>{
        let confirmed;try{confirmed=JSON.parse(readFileSync(confirmation,'utf8'));}catch{return;}
        if(JSON.stringify(confirmed)!==JSON.stringify(control.environment))throw Error('Loader environment confirmation mismatch');
        unwatchFile(confirmation);trace('loader-environment-confirmed-before-rust');global.sandboxFixture.start();
      });
    }else global.sandboxFixture.start();
  });
  app.once('before-quit', () => {if(trigger){unwatchFile(trigger);unwatchFile(trigger+'.confirmed');}global.sandboxFixture.cancel(); dummy.kill(); protectedRuntime.stop(); });
  global.sandboxFixture.window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  global.sandboxFixture.window.loadURL('about:blank').catch(error=>{trace('window-error',String(error));app.exit(1);});
}).catch(error => { console.error(error); app.exit(1); });
