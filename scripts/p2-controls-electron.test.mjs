// Real Electron renderer/preload/IPC. Launcher/hardware are the existing isolated fixture.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
const root=await mkdtemp('/tmp/lad-p2-controls-');let app;
const contrast=(a,b)=>{const luminance=color=>{const v=color.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});return .2126*v[0]+.7152*v[1]+.0722*v[2];};const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
try{
 app=await electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/live-browser/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(String(error)));page.setDefaultTimeout(15000);await page.locator('.conversation').waitFor();await page.locator('.chat-select').filter({hasText:'Live Browser workspace'}).click();if(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded')==='false')await page.locator('.panel-mode-toggle').click();
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));
 assert.equal(await page.locator('.control-group').count(),4);
 const help=page.getByRole('button',{name:'Model & context',exact:true});await help.focus();await page.getByRole('tooltip').waitFor();assert.match(await page.getByRole('tooltip').innerText(),/checkpoint/);await page.keyboard.press('Escape');assert.equal(await page.getByRole('tooltip').count(),0);
 const mtp=page.getByRole('combobox',{name:'Multi-Token Prediction (MTP)'});await mtp.focus();await mtp.selectOption('off');const dialog=page.getByRole('dialog',{name:'Apply MTP'});await dialog.waitFor();
 for(let i=0;i<9;i++){await page.keyboard.press('Tab');assert(await page.evaluate(()=>!!document.activeElement.closest('dialog')),'native modal traps keyboard focus');}
 await mkdir(resolve('artifacts/p2'),{recursive:true});await page.screenshot({path:resolve('artifacts/p2/reload-modal.png')});
 const primary=dialog.locator('.primary');const colors=await primary.evaluate(e=>{const s=getComputedStyle(e);return{s:s.color,b:s.backgroundColor};});assert(contrast(colors.s,colors.b)>=4.5,'primary text meets WCAG AA');
 await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert(await mtp.evaluate(e=>e===document.activeElement),'modal restores focus');
 const vision=page.getByRole('combobox',{name:'Browser Vision'});await vision.selectOption('auto');await page.waitForFunction(async()=>(await window.localAi.browserQa.status()).mode==='auto');assert.equal(await page.getByRole('dialog').count(),0,'Auto policy does not pretend to need a reload');
 await page.getByRole('switch',{name:'Autonomous Browser QA'}).click();await page.waitForFunction(async()=>(await window.localAi.browserQa.status()).autonomous);assert.equal(await page.getByRole('dialog').count(),0,'functional QA setting is independent of projector reload');
 await vision.selectOption('on');await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Apply and reload',exact:true}).click();await page.getByRole('alert').filter({hasText:/requires|projector|compatible/}).waitFor();await page.keyboard.press('Escape');assert.equal((await page.evaluate(()=>window.localAi.browserQa.status())).mode,'auto');
 const muted=await page.locator('.control-group-heading').first().evaluate(e=>({fg:getComputedStyle(e).color,bg:getComputedStyle(e.closest('.control-group')).backgroundColor}));assert(contrast(muted.fg,muted.bg)>=4.5,'group heading contrast');
 await mkdir(resolve('artifacts/p2'),{recursive:true});await page.screenshot({path:resolve('artifacts/p2/controls-after.png')});
 for(const language of ['ru','en']){
  await page.evaluate(language=>window.localAi.settings.setLanguage(language),language);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,850));await page.waitForTimeout(200);
  const layout=await page.locator('.control-panel').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth,body:document.documentElement.scrollWidth,viewport:innerWidth}));assert(layout.scroll<=layout.width+2&&layout.body<=layout.viewport,'narrow localized panel has no horizontal overflow');
  await page.screenshot({path:resolve(`artifacts/p2/controls-narrow-${language}.png`)});
 }
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.control-panel').evaluate(e=>getComputedStyle(e.querySelector('.runtime-state i')).animationName),'none');
 await page.reload();assert.deepEqual(await page.evaluate(async()=>{const s=await window.localAi.browserQa.status();return{mode:s.mode,autonomous:s.autonomous};}),{mode:'auto',autonomous:true});
 assert.deepEqual(errors,[],'no renderer exceptions');
 console.log(JSON.stringify({result:'PASS',root,primaryContrast:contrast(colors.s,colors.b),headingContrast:contrast(muted.fg,muted.bg),locales:['ru','en'],narrowWidth:760,rendererMetrics:await app.evaluate(({app})=>app.getAppMetrics().filter(p=>p.type==='Tab').map(p=>({pid:p.pid,cpu:p.cpu,memory:p.memory}))),focusTrap:true,policyPersistence:true}));
}finally{await app?.close();}
