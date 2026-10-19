// Real Electron renderer/preload/SQLite; seeded reports, no model inference claim.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-scenario-ui-'),output=resolve('docs/test-results/scenario-qa');await mkdir(output,{recursive:true});let app;
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/live-browser/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
 const page=await app.firstWindow();await page.locator('.conversation').waitFor();
 const select=async()=>{await page.locator('.chat-select').filter({hasText:'Live Browser workspace'}).click();};await select();
 const report={id:'report',status:'Blocked',functionalStatus:'Blocked',reasonCode:'PRECONDITION_FAILED',url:'https://project-preview.invalid/index.html#info',checks:[],errors:[],captures:[],visual:{analyzed:false,status:'Not Verified'},scenarios:[{id:'control',goal:'Holding forward moves the camera',target:'/index.html#play',deliverableId:'camera',criterionId:'forward',status:'Blocked',reasonCode:'PRECONDITION_FAILED',reason:'Required mode was not established',evidenceKind:'interaction',assertion:{source:'diagnostic',path:'camera.x',operator:'increased'},observations:[{atMs:0,value:0}],preconditions:[{expected:'Play mode',actual:'Info mode',status:'Blocked'}],checks:[],elapsedMs:100}]};
 await app.evaluate((_,report)=>global.liveFixture.seedQa(report),report);await page.reload();await select();const panel=page.locator('.browser-qa-panel');await panel.waitFor();await panel.locator('summary').first().click();
 assert.match(await panel.innerText(),/Holding forward moves the camera/);assert.match(await panel.innerText(),/index.html#play/);assert.match(await panel.innerText(),/preconditions were not met/);assert(!/undefined|null|·\s*ms/.test(await panel.innerText()));
 await panel.locator('.qa-scenario summary').click();assert.match(await panel.innerText(),/camera.x/);assert.match(await panel.innerText(),/control/);await page.screenshot({path:join(output,'scenarios-en.png')});
 await page.evaluate(()=>window.localAi.settings.setLanguage('ru'));await page.waitForFunction(()=>document.querySelector('.qa-reason').textContent.includes('условия'));assert.match(await panel.innerText(),/Не выполнены условия/);assert.match(await panel.innerText(),/Ожидание, наблюдения/);await page.screenshot({path:join(output,'scenarios-ru.png')});
 const toggle=page.locator('.panel-mode-toggle');for(let i=0;i<2;i++){await toggle.click();assert.match(await panel.innerText(),/Holding forward moves the camera/);}
 await writeFile(join(output,'electron-scenarios.json'),JSON.stringify({result:'PASS',root,scope:'Real Electron UI and SQLite; seeded scenario report, no model',locales:['en','ru'],modes:['Compact','Expanded']},null,2));console.log('PASS Electron scenario report RU/EN, Compact/Expanded, cause, route and technical evidence');
}finally{await app?.close();}
