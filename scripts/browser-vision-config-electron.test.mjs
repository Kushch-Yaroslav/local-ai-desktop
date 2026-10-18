// Real Electron main/preload/renderer IPC with an intentionally unloaded local runtime.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
const root=await mkdtemp('/tmp/lad-vision-config-');let app;
const launch=async()=>{
 app=await electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[`--user-data-dir=${join(root,'electron-profile')}`,resolve('test-fixtures/live-browser/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);await page.locator('.conversation').waitFor();await page.locator('.chat-select').filter({hasText:'Live Browser workspace'}).first().click();if(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded')==='false')await page.locator('.panel-mode-toggle').click();return page;
};
try{
 let page=await launch(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const before=await page.evaluate(async()=>({vision:await window.localAi.browserQa.status(),runtime:await window.localAi.runtime.state(),settings:await window.localAi.settings.get()}));
 assert.equal(before.vision.mode,'off');assert.equal(before.runtime.status,'idle','test begins without a selected or loaded model');assert.equal(before.vision.available,false,'no local server advertises images');
 // Reproduce the old failing UI route: On opens its explicit dialog while no model is loaded.
 const vision=page.getByRole('combobox',{name:'Browser Vision'});await vision.selectOption('on');const dialog=page.getByRole('dialog',{name:'Browser Vision & QA'});await dialog.waitFor();
 await dialog.getByRole('button',{name:'Apply and reload'}).click();await page.waitForFunction(async()=>{const s=await window.localAi.browserQa.status();return s.mode==='on'&&s.pending;});
 assert.match(await page.locator('.vision-availability').innerText(),/next model load/);assert.equal((await page.evaluate(()=>window.localAi.runtime.state())).status,'idle');
 const saved=await page.evaluate(()=>window.localAi.settings.get());assert.equal(saved.setup.config.browserVision,'on');
 const mtpBefore=before.settings.setup.config.models.map(m=>[m.id,m.mtpMode,m.speculative]);assert.deepEqual(saved.setup.config.models.map(m=>[m.id,m.mtpMode,m.speculative]),mtpBefore,'preselecting Vision does not mutate MTP settings');
 // Exercise Off → Auto → On and Auto → On using the actual renderer and IPC handlers.
 await vision.selectOption('off');await page.waitForFunction(async()=>(await window.localAi.browserQa.status()).mode==='off');
 await vision.selectOption('auto');await page.waitForFunction(async()=>(await window.localAi.browserQa.status()).mode==='auto');
 await vision.selectOption('on');await dialog.waitFor();await dialog.getByRole('button',{name:'Apply and reload'}).click();await page.waitForFunction(async()=>{const s=await window.localAi.browserQa.status();return s.mode==='on'&&s.pending;});
 await vision.selectOption('auto');await page.waitForFunction(async()=>(await window.localAi.browserQa.status()).mode==='auto');
 await vision.selectOption('on');await dialog.waitFor();await dialog.getByRole('button',{name:'Apply and reload'}).click();await page.waitForFunction(async()=>(await window.localAi.browserQa.status()).pending);
 // A selected incompatible model is rejected before launcher IPC/DB mutation; the saved preference stays pending.
 const config=saved.setup.config, qwen='qwen3.8:27b-q4_K_M', target=config.models.find(m=>m.id===qwen);assert(target?.mmprojPath);
 const original=target.mmprojPath, settingsFile=join(root,'app-data/runtime-settings.json'),disk=JSON.parse(await readFile(settingsFile,'utf8'));disk.models.find(m=>m.id===qwen).mmprojPath='';await writeFile(settingsFile,JSON.stringify(disk));
 const chat=(await page.evaluate(()=>window.localAi.conversations.list())).find(c=>c.title==='Live Browser workspace');
 await assert.rejects(page.evaluate(({id,qwen})=>window.localAi.conversations.update(id,{modelId:qwen}),{id:chat.id,qwen}),/Browser Vision is enabled.*no compatible local projector/i);
 assert.equal((await page.evaluate(async id=>(await window.localAi.conversations.list()).find(c=>c.id===id).modelId,chat.id)),chat.modelId,'failed compatibility check keeps prior conversation selection');
 disk.models.find(m=>m.id===qwen).mmprojPath=original;await writeFile(settingsFile,JSON.stringify(disk));
 const errorsAfter=await page.locator('[role=alert]').allInnerTexts();assert(!errorsAfter.some(text=>text.includes('Error invoking remote method')),'no raw remote error in the UI');
 await app.close();app=null;page=await launch();const restored=await page.evaluate(()=>window.localAi.browserQa.status());assert.equal(restored.mode,'on');assert.equal(restored.pending,true,'On remains pending after full Electron restart');assert.equal(restored.available,false,'the UI does not claim Vision active before a backend confirmation');
 await page.evaluate(()=>window.localAi.browserQa.configure('off',false,true));await page.waitForFunction(async()=>(await window.localAi.browserQa.status()).mode==='off');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'PASS',route:'real Electron UI → preload → browser-qa:configure IPC → runtime-settings.json',unloaded:true,offAutoOn:true,incompatibleProjectorBlockedBeforeLoad:true,persistedAcrossRestart:true,mtpPreserved:true,visionNotClaimedActive:true,root}));
}finally{await app?.close();}
