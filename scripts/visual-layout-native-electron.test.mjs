// Actual Electron WebContentsView, fixed CDP viewport and renderer. No simulated Vision.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-visual-native-');await mkdir(join(root,'project'));
await writeFile(join(root,'project/index.html'),`<!doctype html><style>body{margin:0;background:#111}canvas{display:block;width:100vw;height:calc(100vh - 80px)}input{position:fixed;top:10px}</style><canvas></canvas><input id="text"><script>window.identity=Math.random();const c=document.querySelector('canvas');function draw(){c.width=c.clientWidth*devicePixelRatio;c.height=c.clientHeight*devicePixelRatio;const ctx=c.getContext('2d');ctx.fillStyle='#9090ff';ctx.fillRect(0,0,c.width,c.height)}addEventListener('resize',draw);matchMedia('(resolution: 2dppx)').addEventListener('change',draw);draw()</script>`);
const scenario=(dpr=1)=>({id:'visual-native',goal:'Fullscreen Canvas coverage after resize',target:'/index.html',viewport:'desktop',preconditions:[],required_state:[],steps:[],assertion:{source:'visual_layout',path:'coverage',selector:'canvas',operator:'equals',expected:0},visual_layout:{dpr,resize:[{width:1440,height:700}],vision:'off'},timeout_ms:14000});
let app;
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/native-browser/workspace-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
 const page=await app.firstWindow();await page.locator('.conversation').waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(760,620));
 const opened=await app.evaluate(()=>global.nativeFixture.open());assert(!opened.error,JSON.stringify(opened));await page.locator('.mode-split').waitFor();await page.waitForTimeout(250);
 await app.evaluate(()=>global.nativeFixture.execute({action:'fill',selector:'#text',value:'preserved'}));await app.evaluate(()=>global.nativeFixture.finish());
 const before=await app.evaluate(()=>global.nativeFixture.info());assert(before.bounds.width<1440);
 let report;
 for(const dpr of [1,2]){
  const checked=await app.evaluate((_,scenario)=>global.nativeFixture.execute({action:'qa',scenarios:[scenario]}),scenario(dpr));assert(checked.qa,JSON.stringify(checked));const result=checked.qa.scenarios[0];assert.equal(result.status,'Failed',JSON.stringify(result));assert.equal(result.visualLayout.frames.length,4);
  for(const frame of result.visualLayout.frames){assert.equal(frame.viewport.width,1440);assert.equal(frame.dpr,dpr);assert(frame.findings.some(f=>f.kind==='coverage'&&Math.round(f.region.height)===80));assert(Math.abs(frame.backing.width-1440*dpr)<=2,JSON.stringify(frame));assert.deepEqual(frame.signature.slice(21,24),[144,144,255],'Rightmost captured region beyond the small owner view contains actual rendered Canvas pixels');assert.equal(frame.screenshot.width,1280,'Capture is bounded downsampling of true 1440px viewport, never an enlarged small native view');}
  report=checked.qa;
 }
 const after=await app.evaluate(()=>global.nativeFixture.info());for(const key of ['url','identity','input','scrollY','viewport'])assert.deepEqual(after.snapshot[key],before.snapshot[key]);assert.equal(after.nativeId,before.nativeId);assert.equal(after.views.length,before.views.length);
 for(const pause of [false,true]){const slow={...scenario(),steps:[{action:'wait',duration_ms:2000}]};await app.evaluate((_,{scenario,pause})=>global.nativeFixture.responsiveCancel({action:'qa',scenarios:[scenario]},pause),{scenario:slow,pause});const info=await app.evaluate(()=>global.nativeFixture.info());assert.equal(info.views.length,before.views.length);assert.equal(info.snapshot.input,'preserved');}
 await app.evaluate((_,report)=>global.nativeFixture.seedQa(report),report);await page.reload();await page.locator('.chat-select').filter({hasText:'Native browser fixture'}).click();if(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded')==='false')await page.locator('.panel-mode-toggle').click();const panel=page.locator('.browser-qa-panel');await panel.waitFor();await panel.locator('summary').first().click();assert.match(await panel.innerText(),/Visual Layout QA/);assert.match(await panel.innerText(),/Declared coverage failed/);assert.match(await panel.innerText(),/DPR 2/);
 await page.evaluate(()=>window.localAi.settings.setLanguage('ru'));await page.waitForFunction(()=>document.querySelector('.qa-visual-layout')?.textContent.includes('Нарушение заданного покрытия'));assert.match(await panel.innerText(),/пиксельные кандидаты/);
 console.log('PASS actual Native Electron: 760px owner window vs independent 1440px QA rendering, DPR1/2, bounded screenshots, resize band detection, preserved active page/input/ownership, Stop/Pause cleanup, RU/EN existing QA panel. No real Vision inference.');
}finally{await app?.close();}
