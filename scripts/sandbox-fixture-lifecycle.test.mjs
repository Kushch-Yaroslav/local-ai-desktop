import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import { bounded, identity, OwnedProcesses } from './sandbox-fixture-lifecycle.mjs';

await assert.rejects(bounded('stalled IPC',()=>new Promise(()=>{}),20),/timeout/);
assert.equal(await bounded('completed IPC',()=>42,20),42);
assert(!process.getActiveResourcesInfo().includes('Timeout'),'deadline timers must be released');
const root=await mkdtemp(join(tmpdir(),'lad-lifecycle-test-'));
const ledger=join(root,'owned.json');
const bystander=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
const script=`
const {spawn}=require('node:child_process');
const {readFileSync,writeFileSync}=require('node:fs');
const identity=${identity.toString()};
const parent=identity(process.pid);
const child=spawn(process.execPath,['-e',"require('node:http').createServer((q,s)=>s.end('owned')).listen(0,'127.0.0.1',function(){console.log(JSON.stringify({port:this.address().port,pid:process.pid}))})"],{stdio:['ignore','pipe','ignore']});
child.stdout.once('data',data=>{
 const entry={...identity(child.pid),parentStartTime:parent.startTime};
 writeFileSync(${JSON.stringify(ledger)},JSON.stringify([entry]));
 process.stdout.write(data,()=>process.exit(0));
});
`;
const parent=spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','pipe']});
const scope=new OwnedProcesses(parent.pid,ledger);
try {
  const ready=await bounded('owned server start',()=>new Promise((resolve,reject)=>{
    parent.once('error',reject);parent.stdout.once('data',data=>resolve(JSON.parse(data)));
  }),3000);
  await bounded('parent exit',()=>parent.exitCode!==null?undefined:new Promise(resolve=>parent.once('exit',resolve)),3000);
  scope.refresh();
  assert(scope.live().some(record=>record.pid===ready.pid),'orphan must remain tracked by authenticated birth identity');
  const body=await bounded('HTTP response',()=>new Promise((resolve,reject)=>{
    const request=get(`http://127.0.0.1:${ready.port}`,{agent:false},response=>{
      let body='';response.on('data',part=>body+=part);response.once('end',()=>resolve(body));response.once('error',reject);
    });request.setTimeout(1000,()=>request.destroy(new Error('HTTP timeout')));request.once('error',reject);
  }),2000);
  assert.equal(body,'owned');
  // A stale identity must never authorize a signal to the bystander.
  scope.add({...identity(bystander.pid),startTime:'invalid-reused-identity'});
  await bounded('owned orphan stop',()=>scope.stop(),4000);
  assert.equal(scope.live().length,0);
  process.kill(bystander.pid,0);
  console.log('PASS: bounded IPC, timer release, HTTP response, orphan ownership cleanup, stale PID rejection, unrelated bystander survival');
} finally {
  await scope.stop();
  for(const child of [parent,bystander]){
    if(child.exitCode===null){child.kill('SIGKILL');await bounded('fixture child exit',()=>new Promise(resolve=>child.once('exit',resolve)),2000);}
    for(const pipe of child.stdio)pipe?.destroy?.();
  }
  await rm(root,{recursive:true,force:true});
}
