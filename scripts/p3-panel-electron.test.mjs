// Real Electron/preload/SQLite + controlled launcher fixture. No real model claims.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-p3-panel-');let app;
const contrast=(a,b)=>{const l=c=>{const s=c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>(v/=255)<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*s[0]+.7152*s[1]+.0722*s[2];};return (Math.max(l(a),l(b))+.05)/(Math.min(l(a),l(b))+.05);};
const output=resolve(process.env.LOCAL_AI_TEST_RESULTS_DIR??'docs/test-results/p3');await mkdir(output,{recursive:true});
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/live-browser/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
 const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.locator('.conversation').waitFor();
 const select=async()=>{await page.locator('.chat-select').filter({hasText:'Live Browser workspace'}).click();if(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded')==='false')await page.locator('.panel-mode-toggle').click();await page.waitForTimeout(250);};await select();
 for(const state of ['unloaded','ready']){
  if(state==='ready'){await page.getByRole('button',{name:'Load selected configuration',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.runtime-state').textContent==='Ready');}
  const colors=await page.locator('.project-picker-control button,.project-folder-badge,.context-selector-trigger,.help-trigger,.control select').evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().width>0).map(e=>{let node=e;while(node&&['rgba(0, 0, 0, 0)','transparent'].includes(getComputedStyle(node).backgroundColor))node=node.parentElement;return{label:e.getAttribute('aria-label')??e.textContent,fg:getComputedStyle(e).color,bg:node?getComputedStyle(node).backgroundColor:'rgb(16,16,15)'};}));
  for(const c of colors)assert(contrast(c.fg,c.bg)>=4.5,`${state} ${c.label}: ${contrast(c.fg,c.bg)}`);
  await page.screenshot({path:resolve(output,`panel-${state}.png`)});
 }
 const launches=await app.evaluate(()=>global.liveFixture.launches());
 await page.locator('.control select').filter({has:page.locator('option[value="deep"]')}).selectOption('deep');
 await page.waitForFunction(async()=>(await window.localAi.conversations.list()).find(c=>c.title==='Live Browser workspace').reasoningMode==='deep');
 assert.equal(await app.evaluate(()=>global.liveFixture.launches()),launches);
 assert(!/Reload required/.test(await page.locator('.configuration-state').allTextContents().then(s=>s.join(' '))));
 const model=page.getByRole('combobox',{name:'Model',exact:true});const options=await model.locator('option:not(:disabled)').evaluateAll(e=>e.map(e=>({value:e.value,name:e.textContent})));const current=await model.inputValue(),target=options.find(o=>o.value!==current);await model.selectOption(target.value);
 await page.getByRole('button',{name:'Load selected configuration',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Model & context',exact:true});await dialog.waitFor();assert.match(await dialog.innerText(),/Active model/);assert.match(await dialog.innerText(),/Target model/);assert((await dialog.innerText()).includes(target.name));assert((await dialog.innerText()).includes('→'));await page.screenshot({path:resolve(output,'reload-model-switch.png')});await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await app.evaluate(()=>global.liveFixture.seedQa({status:'Not Verified',reason:'QA budget exhausted without fresh evidence for the final changes',checks:[],visual:{analyzed:false,status:'Not Verified'}}));
 await page.reload();await select();const panel=page.locator('.browser-qa-panel');await panel.waitFor();assert.match(await panel.innerText(),/No fresh check/);assert(!/·\s*ms/.test(await panel.innerText()));assert(!/budget exhausted/.test(await panel.innerText()),'legacy technical message belongs in diagnostics');
 await page.evaluate(()=>window.localAi.settings.setLanguage('ru'));await page.waitForFunction(()=>document.querySelector('.qa-reason').textContent.includes('Нет свежей'));assert.match(await panel.innerText(),/Нет свежей/);await panel.locator('summary').first().click();assert.match(await panel.innerText(),/Диагностика/);await page.screenshot({path:resolve(output,'qa-legacy-ru.png')});
 for(const status of ['Blocked','Failed','Verified']){await app.evaluate((_,status)=>global.liveFixture.seedQa({status,reasonCode:status==='Blocked'?'QA_NO_PROGRESS':undefined,reason:status==='Blocked'?'Guard diagnostic':'',checks:[],visual:{analyzed:false,status:'Not Verified'},elapsedMs:0}),status);await page.reload();await select();assert.match(await panel.innerText(),new RegExp(status==='Blocked'?'Заблокировано':status==='Failed'?'Не прошла':'Проверено'));}
 await page.evaluate(()=>window.localAi.settings.setLanguage('en'));await page.locator('.panel-mode-toggle').click();assert.equal(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded'),'false');
 console.log(JSON.stringify({result:'PASS',fixture:'real Electron/SQLite; controlled backend',contrast:['unloaded','ready'],legacyEvidence:true,locales:['ru','en'],modelIdentity:true,noReasoningReload:true,qaStatuses:true,root}));
}finally{await app?.close();}
