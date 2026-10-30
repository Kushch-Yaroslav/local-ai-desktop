import './test-runtime-isolation';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {paths,ensureAppDirectories} from './paths';
import {startRuntimeSupervisor,stopRuntimeSupervisor} from './runtime-supervisor';
async function main(){
 ensureAppDirectories();process.env.LOCAL_AI_LLAMA_PORT=String(20000+process.pid%20000);
 process.env.LOCAL_AI_LAUNCHER_MANAGED='1'; // An inherited flag is not evidence of a live owner.
 try {
  const pids=await Promise.all(Array.from({length:8},()=>startRuntimeSupervisor()));assert.equal(new Set(pids).size,1);
  const state=JSON.parse(await readFile(join(paths.dataRoot,'llama-cpp-runtime-state.json'),'utf8'));assert.equal(state.status,'idle');assert.equal(state.serverPid,0);assert.equal(state.launcherPid,pids[0]);
  await rm(join(paths.dataRoot,'llama-cpp-mtp-launcher.pid'));
  await writeFile(join(paths.dataRoot,'llama-cpp-runtime-state.json'),JSON.stringify({status:'stopped',launcherPid:999999}));
  assert.equal(await startRuntimeSupervisor(),pids[0],'Recover the owned headless child even when both registration files were overwritten');
  console.log('PASS supervisor: cold start with inherited managed flag, eight concurrent starts share one owner, erased registration does not spawn a competitor');
 }finally{await stopRuntimeSupervisor();}
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
