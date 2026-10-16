import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
const soakSeconds=Number(process.env.LOCAL_AI_LIVE_SOAK_SECONDS??60);assert(Number.isInteger(soakSeconds)&&soakSeconds>=5&&soakSeconds<=600);
const root=await mkdtemp(join(tmpdir(),'lad-live-electron-'));
const output=resolve('artifacts/live-browser');await mkdir(output,{recursive:true});
let application;
try {
  application=await electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/live-browser/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
  const page=await application.firstWindow();page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(20000);const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.locator('.conversation').waitFor();
  const info=await application.evaluate(()=>({chat:global.liveFixture.chat,second:global.liveFixture.second}));
  // Select the first chat through the real renderer store/IPC path.
  await page.getByRole('button',{name:'History must survive context selection',exact:true}).click().catch(()=>undefined);
  // Fixture's initial chat may not be first in list; choose by title from API.
  const chats=await page.evaluate(()=>window.localAi.conversations.list());
  const selected=chats.find(c=>c.id===info.chat);await page.locator('.chat-select').filter({hasText:selected.title}).first().click();
  assert(!(await application.evaluate(()=>global.liveFixture.open())).error);
  await page.locator('.live-workspace.mode-split').waitFor();
  await page.waitForFunction(()=>document.querySelector('.live-footer')?.textContent.match(/[1-9]\d* fps/));
  assert.match(await page.locator('.live-address').innerText(),/project-preview.invalid/);
  const soak=[];
  for(let sample=0;sample<Math.ceil(soakSeconds/5);sample++){
    await page.waitForTimeout(5000);
    const stats=await application.evaluate(({app})=>app.getAppMetrics().filter(m=>m.type==='Browser'||m.type==='Tab').map(m=>({type:m.type,cpu:m.cpu.percentCPUUsage,rssKiB:m.memory.workingSetSize})));
    const label=await page.locator('.live-footer').innerText();assert(/[4-9] fps|1[0-2] fps/.test(label),'animation continues during one-minute soak');soak.push({seconds:(sample+1)*5,label,stats});
  }
  await writeFile(join(output,soakSeconds===60?'electron-soak.json':'electron-layout-soak.json'),JSON.stringify(soak,null,2));
  const hashes=[];
  for(let n=0;n<5;n++){hashes.push(await page.locator('.live-viewport canvas').evaluate(c=>c.toDataURL().slice(-300)));await page.waitForTimeout(150);}
  assert(new Set(hashes).size>=3,'real Canvas stream changes in UI');
  const chat=page.locator('.live-chat'),divider=page.locator('.live-divider');const before=await chat.boundingBox();const handle=await divider.boundingBox();
  await page.mouse.move(handle.x+3,handle.y+100);await page.mouse.down();await page.mouse.move(handle.x-90,handle.y+100,{steps:10});await page.mouse.up();assert((await chat.boundingBox()).width<before.width-40,'drag resizes chat');
  await application.evaluate(()=>global.liveFixture.action({action:'click',selector:'#explore'}));await page.waitForFunction(()=>document.querySelector('.live-address')?.textContent.includes('#explore'));
  await page.screenshot({path:join(output,'split-dark.png')});
  await page.getByRole('button',{name:'Browser Expanded',exact:true}).click();await page.locator('.mode-expanded').waitFor();assert(!(await chat.isVisible()));
  await page.screenshot({path:join(output,'expanded.png')});
  await page.getByRole('button',{name:'Chat Only',exact:true}).click();await page.locator('.mode-chat').waitFor();assert(await chat.isVisible());
  const hiddenHash=await page.locator('.live-viewport canvas').evaluate(c=>c.toDataURL().slice(-300));await page.waitForTimeout(500);assert.equal(await page.locator('.live-viewport canvas').evaluate(c=>c.toDataURL().slice(-300)),hiddenHash);
  await application.evaluate(()=>global.liveFixture.action({action:'fill',selector:'#message',value:'Works while hidden'}));assert(await page.locator('.mode-chat').count(),'does not reopen after tool action');
  await page.locator('.live-reopen').click();await page.locator('.mode-split').waitFor();
  await page.reload();await page.locator('.chat-select').filter({hasText:selected.title}).first().click();await page.locator('.mode-split').waitFor();await page.waitForFunction(()=>document.querySelector('.live-footer')?.textContent.match(/[1-9]\d* fps/));
  const other=chats.find(c=>c.id===info.second);await page.locator('.chat-select').filter({hasText:other.title}).first().click();await page.locator('.mode-chat').waitFor();assert.equal(await page.locator('.live-reopen').count(),0,'no other-chat browser');
  await page.locator('.chat-select').filter({hasText:selected.title}).first().click();await page.locator('.mode-split').waitFor();
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(980,760));await page.waitForTimeout(400);
  assert(await page.locator('.live-workspace').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'small window does not overflow');
  // The app currently ships a dark palette. Exercise light token overrides without adding theme settings.
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';const tokens={'--bg':'#f6f7f9','--surface':'#ffffff','--surface-raised':'#eff1f4','--surface-hover':'#e3e6ec','--surface-muted':'#edf0f5','--border':'#c8ced8','--border-strong':'#aeb7c4','--text':'#182332','--text-muted':'#46576b','--text-subtle':'#5b6c80','--danger':'#a12626'};for(const [name,value]of Object.entries(tokens))document.documentElement.style.setProperty(name,value);});
  assert.equal(await page.locator('.live-browser').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(237, 240, 245)');await page.screenshot({path:join(output,'split-light-small.png')});
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(860,900));await page.locator('.live-workspace.is-narrow').waitFor();assert(await page.locator('.live-workspace').evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.screenshot({path:join(output,'narrow-stacked.png')});
  await application.evaluate(()=>global.liveFixture.edit());await page.waitForFunction(()=>document.querySelector('.live-address')?.textContent.includes('edited.html'));
  await page.waitForTimeout(400);await page.screenshot({path:join(output,'edited.png')});
  const scroll=page.locator('.conversation');await scroll.evaluate(e=>e.scrollTop=0);await page.waitForTimeout(150);assert.equal(await scroll.evaluate(e=>e.scrollTop),0,'chat scroll remains user controlled');
  await application.evaluate(()=>global.liveFixture.close());await page.waitForFunction(()=>/Last frame|Последний кадр/.test(document.querySelector('.live-footer')?.textContent??''));
  assert.deepEqual(errors,[]);await writeFile(join(output,'electron-result.json'),JSON.stringify({result:'PASS',split:true,resize:true,expanded:true,chatOnly:true,hideKeepsAgent:true,chatIsolation:true,animationUniqueFrames:new Set(hashes).size,smallWidth:true,narrowStacked:true,lightTokens:true,rendererReconnect:true,chatScroll:true,edited:true,errors,root},null,2));
  console.log('PASS actual Electron: same-page live Canvas, split/drag/expanded/chat-only, hidden tools, chat isolation, small window/light theme, edit, chat scroll, closed last frame');
} finally {await application?.close();}
