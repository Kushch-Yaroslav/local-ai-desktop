// Smoke the real npm start launcher; no model, IPC or application main fixture.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';
import {bounded,OwnedProcesses} from './sandbox-fixture-lifecycle.mjs';

assert.notEqual(process.getuid(),0);
const require=createRequire(import.meta.url);
const {settingsFile}=require('../dist/main/services/runtime-settings.js');
const settings=await readFile(settingsFile);
const root=await mkdtemp(join(tmpdir(),'lad-normal-startup-'));
const owned=new OwnedProcesses(process.pid,join(root,'ledger.json'));
let browser,monitor,launcher;
const stage=async(name,operation,timeout=5000)=>{console.log('[normal startup] START '+name);const result=await bounded(name,operation,timeout);console.log('[normal startup] OK '+name);return result;};
try{
  await stage('ensure no existing application/model session',async()=>{for(const pid of (await readdir('/proc')).filter(name=>/^\d+$/.test(name))){try{const exe=(await readFile('/proc/'+pid+'/cmdline','utf8')).split('\0')[0];assert(!exe?.endsWith('/electron')&&!exe?.endsWith('/llama-server'),'An existing application/model session requires an isolated instance: '+pid);}catch(error){if(!['ENOENT','EACCES'].includes(error.code))throw error;}}});
  // Loopback CDP is solely observation of this test's ordinary app window.
  // Leave all Node helper invocations and the production entry point intact.
  const reservation=createServer();
  await stage('reserve observation port',()=>new Promise((done,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',done);}));
  const port=reservation.address().port;
  await new Promise(done=>reservation.close(done));
  const executable=resolve('node_modules/electron/dist/electron');
  assert(!executable.includes("'"));
  const wrapper=join(root,'electron');
  await writeFile(wrapper,`#!/bin/bash\nif [[ "\${ELECTRON_RUN_AS_NODE:-}" == 1 ]]; then exec '${executable}' "$@"; fi\nexec '${executable}' --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} "$@"\n`,{mode:0o700});
  const env={...process.env,LOCAL_AI_ELECTRON_BIN:wrapper,LOCAL_AI_DIAGNOSTICS:'1'};
  for(const key of ['LOCAL_AI_LAUNCHER_MANAGED','LOCAL_AI_LAUNCHER_HEADLESS','LOCAL_AI_PARENT_PID','LOCAL_AI_AGENT_ENDPOINT','LOCAL_AI_DEV_SERVER_URL','ELECTRON_RUN_AS_NODE'])delete env[key];
  monitor=setInterval(()=>owned.refresh(),50);
  launcher=spawn('/usr/bin/aa-exec',['-p','unconfined','--','npm','start'],{cwd:resolve('.'),env,stdio:['ignore','pipe','pipe']});
  launcher.stdout.on('data',data=>process.stdout.write(data));launcher.stderr.on('data',data=>process.stderr.write(data));
  await stage('ordinary npm start window',async()=>{
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      if(launcher.exitCode!==null)throw Error('Normal launcher exited: '+launcher.exitCode);
      try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000});return;}catch{await new Promise(done=>setTimeout(done,100));}
    }
    throw Error('Normal launcher did not expose its window');
  },32000);
  const page=browser.contexts()[0].pages()[0];
  await page.waitForFunction(()=>Boolean(window.localAi),{timeout:10000});
  const state=await stage('real preload/settings/runtime IPC',()=>page.evaluate(async()=>({runtime:await window.localAi.runtime.state(),settings:await window.localAi.settings.get(),conversations:await window.localAi.conversations.list()})));
  assert.equal(state.runtime.status,'idle','Startup must not activate a stored model implicitly');
  assert.equal(state.runtime.modelId,null);
  assert(state.conversations.length>0,'Existing user history must be visible');
  assert.equal(await readFile(settingsFile,'utf8'),settings.toString(),'Startup changed user settings');
  console.log(JSON.stringify({renderer:page.url(),startup:'idle',userConversations:state.conversations.length,configuration:settingsFile}));
  await stage('normal last-window close',()=>page.close());
  await stage('normal launcher exit',async()=>{for(let i=0;i<200;i++){if(launcher.exitCode!==null){assert.equal(launcher.exitCode,0);return;}await new Promise(done=>setTimeout(done,100));}throw Error('Launcher did not exit after normal application shutdown');},22000);
  for(let i=0;i<30;i++){owned.refresh();if(!owned.live().length)break;await new Promise(done=>setTimeout(done,100));}
  assert.deepEqual(owned.live(),[],'Normal shutdown left owned processes');
  console.log('[normal startup] PASS real npm start, existing configuration/history, idle model and trusted application shutdown');
}finally{
  if(browser)await bounded('disconnect observation socket',()=>browser.close(),5000);
  clearInterval(monitor);
  await owned.stop();
  for(const pipe of launcher?.stdio??[])pipe?.destroy?.();
  await rm(root,{recursive:true,force:true});
}
