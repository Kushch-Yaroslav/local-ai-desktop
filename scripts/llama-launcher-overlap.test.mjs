import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';
const root=await mkdtemp(join(tmpdir(),'lad-launcher-overlap-'));await mkdir(join(root,'scripts'));
const script=join(root,'run-local-ai-desktop-llama-cpp-mtp.sh');
const source=await readFile(process.env.LAD_LAUNCHER_SOURCE??resolve('run-local-ai-desktop-llama-cpp-mtp.sh'),'utf8');
await writeFile(script,source.replace(/(log "launcher.cleanup[^\n]+\n)/,'$1  sleep 1\n'));
const env={...process.env,LOCAL_AI_APP_DIR:resolve('.'),LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_LAUNCHER_HEADLESS:'1',LOCAL_AI_LLAMA_PORT:'18961',LOCAL_AI_ELECTRON_BIN:process.execPath};
const delay=ms=>new Promise(r=>setTimeout(r,ms));const children=[];
async function waitFor(test){for(let i=0;i<200;i++){if(await test())return;await delay(50);}throw Error('Timeout '+root);}
async function state(){try{return JSON.parse(await readFile(join(root,'llama-cpp-runtime-state.json')));}catch{return {};}}
function start(){const child=spawn('bash',[script],{env,stdio:'ignore'});children.push(child);return child;}
try {
 for(let round=0;round<6;round++){
  const old=start();await waitFor(async()=>(await state()).launcherPid===old.pid&&(await state()).status==='idle');
  old.kill('SIGTERM');const next=start();
  await waitFor(async()=>(await state()).launcherPid===next.pid&&(await state()).status==='idle');
  await waitFor(async()=>old.exitCode!==null||old.signalCode!==null);await delay(150);assert.equal((await state()).launcherPid,next.pid);assert.equal(Number((await readFile(join(root,'llama-cpp-mtp-launcher.pid'),'utf8')).trim()),next.pid);
  next.kill('SIGTERM');await waitFor(async()=>next.exitCode!==null||next.signalCode!==null);
 }
 console.log('PASS six deterministic overlapping launcher exits/starts; successor PID and idle state preserved. '+root);
}finally{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM');}
