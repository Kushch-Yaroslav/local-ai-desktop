// Actual Native WebContentsView/CDP/Chromium and renderer UI. No LLM provider.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-responsive-native-');await mkdir(join(root,'project'));
await writeFile(join(root,'project/index.html'),`<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;color:white;background:#123}main{padding:10px}input{max-width:100%}@media(max-width:360px){main{min-width:430px}}</style><main><h1>Responsive native fixture</h1><input id="text"><a href="#kept" id="route">Keep route</a><div style="height:1600px"></div></main><script>window.identity=Math.random()</script>`);
let app;
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/native-browser/workspace-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);await page.locator('.conversation').waitFor();
 const opened=await app.evaluate(()=>global.nativeFixture.open());assert(!opened.error,JSON.stringify(opened));await page.locator('.mode-split').waitFor();await page.waitForTimeout(250);
 await app.evaluate(()=>global.nativeFixture.execute({action:'fill',selector:'#text',value:'user state'}));await app.evaluate(()=>global.nativeFixture.execute({action:'click',selector:'#route'}));await app.evaluate(()=>global.nativeFixture.finish());
 const before=await app.evaluate(()=>global.nativeFixture.info()),windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length);
 const args={action:'qa',responsive:{reason:'Check a responsive layout checkpoint',viewports:[{width:360,height:800},'desktop'],vision:'off'}};
 const result=await app.evaluate((_,args)=>global.nativeFixture.execute(args),args);assert(result.qa,JSON.stringify(result));assert.equal(result.qa.scenarios[0].status,'Failed');assert.equal(result.qa.scenarios[1].status,'Verified');
 const after=await app.evaluate(()=>global.nativeFixture.info());assert.equal(after.nativeId,before.nativeId);assert.equal(after.pageCount,1);assert.equal(after.views.length,before.views.length);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),windows,'No new Electron window');
 for(const key of ['url','identity','input','scrollY','viewport'])assert.deepEqual(after.snapshot[key],before.snapshot[key],`Active native ${key} is preserved`);
 assert.equal(after.approvals,before.approvals,'Isolated QA reuses the authorized origin, without extra permission or wider scope');
 const reused=await app.evaluate((_,args)=>global.nativeFixture.execute(args),args);assert.equal(reused.reused_evidence,true);
 const slow={action:'qa',scenarios:[{id:'pause-probe',goal:'Cancellation preserves native page',target:'/index.html',viewport:'mobile',preconditions:[],required_state:[],steps:[{action:'wait',duration_ms:2000}],assertion:{source:'visible',selector:'#text',operator:'equals',expected:true},timeout_ms:5000}]};
 for(const pause of [false,true]){await app.evaluate((_,{args,pause})=>global.nativeFixture.responsiveCancel(args,pause),{args:slow,pause});const info=await app.evaluate(()=>global.nativeFixture.info());assert.equal(info.nativeId,before.nativeId);assert.equal(info.views.length,before.views.length);assert.equal(info.snapshot.input,'user state');}
 await app.evaluate((_,report)=>global.nativeFixture.seedQa(report),result.qa);await page.reload();await page.locator('.chat-select').filter({hasText:'Native browser fixture'}).click();if(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded')==='false')await page.locator('.panel-mode-toggle').click();const panel=page.locator('.browser-qa-panel');await panel.waitFor();assert.match(await panel.locator('.qa-responsive-status').innerText(),/2 viewports checked/);await panel.locator('summary').first().click();assert.match(await panel.innerText(),/360 × 800/);assert.match(await panel.innerText(),/Horizontal overflow/);assert.match(await panel.innerText(),/Desktop Chromium/);
 await page.evaluate(()=>window.localAi.settings.setLanguage('ru'));await page.waitForFunction(()=>document.querySelector('.qa-responsive-status')?.textContent.includes('проверено'));assert.match(await panel.innerText(),/Горизонтальное переполнение/);assert.match(await panel.innerText(),/физическое мобильное устройство не проверялось/);
 console.log('PASS real Native Electron/CDP: isolated responsive viewports, unchanged active identity/navigation/input/size, no extra windows, cache, Stop/Pause cleanup, RU/EN QA panel. No real Vision/LLM inference.');
}finally{await app?.close();}
