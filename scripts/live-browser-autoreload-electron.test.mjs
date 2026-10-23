import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
const root=await mkdtemp(join(tmpdir(),'lad-auto-electron-')),output=resolve('artifacts/live-browser/auto-electron');await mkdir(output,{recursive:true});
let application;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  application=await electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/live-browser/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,ELECTRON_ENABLE_LOGGING:'1',ELECTRON_ENABLE_STACK_DUMPING:'1'}});
  application.process().stderr.on('data',data=>appendFileSync(join(output,'electron-stderr.log'),data));
  const page=await application.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.locator('.chat-select').filter({hasText:'Live Browser workspace'}).click();await application.evaluate(()=>global.liveFixture.autoSetup());await page.locator('.mode-split').waitFor();
  const wait=async predicate=>{const start=Date.now();while(true){try{if(await predicate())return;}catch{/* Page context swaps during reload */}if(Date.now()-start>8000){const diagnosis=await application.evaluate(()=>global.liveFixture.autoDiagnostics());throw Error('Auto-reload UI timeout: '+JSON.stringify(diagnosis));}await sleep(50);}};
  const snapshot=()=>application.evaluate(()=>global.liveFixture.autoSnapshot());
  await wait(async()=>/Chromium/.test(await page.locator('.live-footer').innerText()));
  await application.evaluate(()=>global.liveFixture.autoEdit('html'));await wait(async()=>(await snapshot()).heading==='HTML v2');
  await application.evaluate(()=>global.liveFixture.autoEdit('css'));await wait(async()=>(await snapshot()).color==='rgb(90, 40, 120)');

  await application.evaluate(()=>global.liveFixture.autoEdit('js'));await wait(async()=>(await snapshot()).js==='JS v2');await sleep(300);
  await page.screenshot({path:join(output,'automatic-html-css-js.png')});
  await page.getByRole('button',{name:'Chat Only',exact:true}).click();const hidden=(await snapshot()).loads;await application.evaluate(()=>global.liveFixture.autoEdit('hidden'));await sleep(900);assert.equal((await snapshot()).loads,hidden);assert(await page.locator('.mode-chat').count());
  const other=page.locator('.chat-select').filter({hasText:'Separate chat'});await other.click();await sleep(500);assert.equal((await snapshot()).loads,hidden);assert.equal(await page.locator('.live-manual-open').count(),0);
  await page.locator('.chat-select').filter({hasText:'Live Browser workspace'}).click();await page.locator('.live-manual-open').click();await wait(async()=>(await snapshot()).heading==='HTML hidden');
  const hashes=[];for(let i=0;i<5;i++){hashes.push(await application.evaluate(()=>global.liveFixture.nativePixels()));await sleep(200);}assert(new Set(hashes).size>=3,'Canvas continues in the real renderer after reload');
  await page.screenshot({path:join(output,'reopened-current.png')});await application.evaluate(()=>global.liveFixture.close());await page.waitForFunction(()=>document.querySelector('.live-footer').textContent.includes('Browser closed'));assert.deepEqual(errors,[]);
  const result={result:'PASS',html:true,cssPixels:true,javascript:true,hidden:true,chatSwitch:true,canvasFrames:new Set(hashes).size,errors,root};await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await application?.close();}
