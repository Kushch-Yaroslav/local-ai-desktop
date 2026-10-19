/* eslint-disable @typescript-eslint/no-require-imports -- evaluated inside Electron main */
// Real Electron main process and installed llama-server, no inference or user data.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-p3-probe-');
const main=join(root,'probe.cjs');
await writeFile(main,"global.require=require; require('electron').app.whenReady().then(()=>{global.ready=true})");
const app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[main],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
try {
 const result=await app.evaluate(async(_,{modulePath,binary})=>{
   const {execFile}=require('node:child_process');
   const old=await new Promise(resolve=>execFile(binary,['--help'],{timeout:3000,maxBuffer:256*1024,env:{...process.env,LC_ALL:'C'}},(error,out,err)=>resolve({error:error?.message,bytes:out.length+err.length,support:!error&&/--spec-type\s[^\n]*\bdraft-mtp\b/.test(out+err)})));
   const updated=await require(modulePath).probeBackendMtp(binary);
   return {old,updated};
 },{modulePath:resolve('dist/main/services/mtp-capability.js'),binary:resolve('../llama.cpp/build-cuda/bin/llama-server')});
 console.log(JSON.stringify(result));assert.equal(result.updated.status,'supported');
}finally {await app.close();}
