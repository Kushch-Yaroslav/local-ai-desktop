// Real Electron/preload/Chromium; inference settings use the existing isolated fixture.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
const root=await mkdtemp('/tmp/lad-panel-modes-');let app;
const launch=async()=>{
 app=await electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[`--user-data-dir=${join(root,'electron-profile')}`,resolve('test-fixtures/live-browser/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);await page.locator('.conversation').waitFor();await page.locator('.chat-select').filter({hasText:'Live Browser workspace'}).first().click();return page;
};
const mode=async(page,value)=>{const toggle=page.locator('.panel-mode-toggle');if(await toggle.getAttribute('aria-expanded')!==String(value))await toggle.click();await page.waitForTimeout(240);};
try{
 let page=await launch();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 assert.equal(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded'),'false','fresh profile defaults to Compact');
 assert(await page.locator('.panel-model').isVisible());assert(await page.locator('.compact-context').isVisible());assert.match(await page.locator('.compact-indicators').innerText(),/MTP:.*Vision:.*QA:/s);
 const compactHeight=await page.locator('.control-panel').evaluate(e=>e.getBoundingClientRect().height);assert(compactHeight<110,'compact header uses minimal vertical space');
 const snapshot=()=>page.evaluate(async()=>({chats:await window.localAi.conversations.list(),vision:await window.localAi.browserQa.status()}));
 const before=await snapshot();
 await page.locator('.panel-mode-toggle').focus();await page.keyboard.press('Enter');await page.getByRole('combobox',{name:'Browser Vision'}).waitFor();await page.waitForTimeout(240);
 const expandedHeight=await page.locator('.control-panel').evaluate(e=>e.getBoundingClientRect().height);assert(expandedHeight>compactHeight);
 await page.evaluate(()=>{window.originalControls=[...document.querySelectorAll('.toolbar-controls select')];});
 await page.locator('.context-estimate > summary').click();await page.locator('.context-estimate-details').waitFor();
 await page.locator('.panel-mode-toggle').evaluate(e=>e.click());assert(!(await page.locator('.context-estimate-details').isVisible()),'fixed popover is hidden together with collapsed settings');
 await mode(page,true);await page.keyboard.press('Escape');
 const mtp=page.getByRole('combobox',{name:'MTP'});await mtp.focus();await mtp.selectOption('off');await page.getByRole('dialog',{name:'Apply MTP'}).waitFor();
 // Native modal blocks pointer interaction outside it; exercise a programmatic display update too.
 await page.locator('.panel-mode-toggle').evaluate(e=>e.click());assert(await page.getByRole('dialog').isVisible());
 await page.keyboard.press('Tab');assert(await page.evaluate(()=>!!document.activeElement.closest('dialog')));
 await page.keyboard.press('Escape');assert(await page.locator('.panel-mode-toggle').evaluate(e=>document.activeElement===e),'hidden modal trigger falls back to visible expand button');
 await mode(page,true);assert.equal(await mtp.inputValue(),'auto','cancel keeps actual selection');
 const help=page.getByRole('button',{name:'Help for Model & context',exact:true});await help.focus();await page.getByRole('tooltip').waitFor();await page.keyboard.press('Escape');await page.locator('.panel-mode-toggle').focus();await page.keyboard.press('Space');
 assert(await page.evaluate(()=>window.originalControls.every((e,i)=>e===document.querySelectorAll('.toolbar-controls select')[i])),'controls keep DOM identity without remount');
 await page.keyboard.press('Tab');assert(await page.evaluate(()=>!document.activeElement.closest('.panel-expansion')),'collapsed controls are excluded from keyboard focus');
 assert.deepEqual(await snapshot(),before,'display-only toggles do not modify settings or conversations');
 assert(!(await app.evaluate(()=>global.liveFixture.open())).error);await page.locator('.live-workspace.mode-split').waitFor();
 await page.waitForFunction(()=>document.querySelector('.live-footer')?.textContent.includes('Chromium'));
 for(const expanded of [true,false]){
  await mode(page,expanded);
  const bounds=await page.evaluate(()=>{const panel=document.querySelector('.control-panel').getBoundingClientRect(),work=document.querySelector('.live-workspace').getBoundingClientRect();return{panelBottom:panel.bottom,workTop:work.top,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert(bounds.panelBottom<=bounds.workTop+1&&!bounds.overflow,'panel takes layout space without overlapping Live Browser');
 }
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(640,750));
 for(const expanded of [true,false]){await mode(page,expanded);assert(await page.locator('.control-panel').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'narrow panel has no horizontal overflow');}
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.panel-expansion').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
 await mkdir(resolve('artifacts/p2'),{recursive:true});await page.screenshot({path:resolve('artifacts/p2/controls-compact.png')});
 await mode(page,true);await app.close();app=null;page=await launch();assert.equal(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded'),'true','Expanded survives full Electron restart');
 await mode(page,false);await app.close();app=null;page=await launch();assert.equal(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded'),'false','Compact survives full Electron restart');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'PASS',compactHeight,expandedHeight,realElectronRestart:true,liveBrowser:true,modalFocus:true,noRemount:true,root}));
}finally{await app?.close();}
