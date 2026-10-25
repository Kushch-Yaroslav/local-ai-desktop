import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-context-state-');let app;
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/context-profiles/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();if(await ui.locator('.panel-mode-toggle').getAttribute('aria-expanded')==='false')await ui.locator('.panel-mode-toggle').click();
 const select=ui.getByRole('combobox',{name:/^(Context|Контекст)$/});
 const choose=async id=>{await select.click();await ui.locator(`[role=option][data-context-id="${id}"]`).click();};
 const load=async()=>{await ui.getByRole('button',{name:/Load selected configuration|Загрузить выбранную конфигурацию/}).click();const dialog=ui.getByRole('dialog');if(await dialog.count())await dialog.getByRole('button',{name:/Apply and reload|Применить и перезагрузить/}).click();};
 const state=()=>app.evaluate(()=>global.contextFixture.state());const launches=()=>app.evaluate(()=>global.contextFixture.launches.length);
 await choose('32768:f16:gpu');await load();await ui.locator('.context-active').filter({hasText:'32K (FP16)'}).waitFor();assert.equal((await state()).contextWindow,32768);assert.equal((await state()).kvCacheType,'f16');
 let count=await launches();await choose('65536:q8_0:gpu');assert.equal(await launches(),count);assert.match(await ui.locator('.compact-context').innerText(),/32K \(FP16\)/);assert.match(await ui.locator('.context-selected').innerText(),/On next model load: 64K \(Q8\)/);
 await load();await ui.locator('.context-active').filter({hasText:'64K (Q8)'}).waitFor();assert.equal((await state()).contextWindow,65536);assert.equal((await state()).kvCacheType,'q8_0');
 count=await launches();await choose('32768:f16:gpu');assert.match(await ui.locator('.context-active').innerText(),/Active now: 64K \(Q8\)/);assert.match(await ui.locator('.context-selected').innerText(),/On next model load: 32K \(FP16\)/);assert.match(await ui.locator('.compact-context').innerText(),/64K \(Q8\)/);assert.equal(await launches(),count);assert.equal(await ui.locator('.configuration-state[data-state=reload]').count(),1);
 await ui.reload();await ui.locator('.context-active').filter({hasText:'64K (Q8)'}).waitFor();assert.equal(await launches(),count,'Renderer reload must not restart weights');
 await app.evaluate(()=>{const f=global.contextFixture;f.db.updateConversation(f.chat.id,{contextWindow:32768,llamaKvCacheType:'f16',llamaKvOffload:true});});await ui.reload();await ui.locator('.context-active').filter({hasText:'64K (Q8)'}).waitFor();assert.match(await ui.locator('.context-selected').innerText(),/On next model load: 32K \(FP16\)/);assert.equal(await ui.locator('.configuration-state[data-state=reload]').count(),1,'Saved chat/runtime mismatch must be visible even without a UI draft');assert.equal(await launches(),count);
 const result={result:'PASS',root,controller:'fixture launcher state, not a real GGUF load',active:await state(),checks:['32K FP16 applied','64K Q8 selection alone leaves 32K active','Explicit reload applies 64K Q8','32K pending clearly differs from 64K active','Renderer reload preserves actual runtime and does not launch','Saved 32K FP16 vs active 64K Q8 mismatch is visible without a new draft']};await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({result:'PASS',root}));
}finally{await app?.close();}
