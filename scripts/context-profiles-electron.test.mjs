import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
const root = await mkdtemp(join(tmpdir(), 'lad-context-electron-'));
let application;
const launch = async (environment = {}) => {
  application = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('test-fixtures/context-profiles/electron-main.cjs')], env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root, ...environment } });
  const page = await application.firstWindow();
  await page.waitForFunction(() => ['f16','q8_0'].every(type=>/^\d+(?:\.\d+)?K$/.test(document.querySelector(`[data-kv-type=${type}] b`)?.textContent ?? '')));
  return page;
};
const selector = page => page.getByRole('combobox', { name: /^(Context|Контекст)$/ });
const choose = async (page,id) => { await selector(page).click(); await page.locator(`[role=option][data-context-id="${id}"]`).click(); };
const choices = async page => { await selector(page).click(); const text=await page.getByRole('listbox').innerText(); await page.keyboard.press('Escape'); return text; };
const state = async () => application.evaluate(() => global.contextFixture.state());
try {
  let page = await launch();
  assert.match(await selector(page).innerText(), /72K \(FP16\)/);
  assert.equal((await state()).status, 'idle');
  await selector(page).click();
  assert.equal(await page.locator('.context-selector-column').count(),2);
  assert(await page.getByRole('listbox').evaluate(node=>node.getBoundingClientRect().left >= document.querySelector('.sidebar').getBoundingClientRect().right),'dropdown stays inside application content');
  const alignment=await selector(page).evaluate(button=>{const dot=button.querySelector('.context-fit-dot').getBoundingClientRect(),value=button.querySelector('[id$=value]').getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();return {center:Math.abs((dot.top+dot.height/2)-(value.top+value.height/2)),gap:icon.left-value.right};});
  assert(alignment.center<1 && alignment.gap<=8,'closed dot and chevron are tightly aligned');
  assert.equal(await page.getByRole('group',{name:'FP16',exact:true}).getByRole('option').filter({hasText:'108K'}).count(),0,'Q8 maximum is not inserted into FP16 column');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  const activeId=await selector(page).getAttribute('aria-activedescendant');
  assert.equal(await page.locator(`[id="${activeId}"]`).getAttribute('data-context-id'),'16384:q8_0:gpu');
  await page.keyboard.press('Escape');
  await selector(page).focus(); await page.keyboard.press('ArrowDown');
  assert(await page.getByRole('listbox').getByRole('option').count() <= 16,'compact defaults plus exact discovered/preserved sizes');
  await page.keyboard.press('End');
  assert(await page.getByRole('listbox').evaluate(node => node.scrollTop > 0),'keyboard navigation scrolls the option into view');
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  assert.match(await selector(page).innerText(),/16K/);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
  assert.equal(await selector(page).getAttribute('aria-expanded'),'false');
  assert.equal(await application.evaluate(() => global.contextFixture.launches.length), 0, 'reading old chat cannot start the server');
  await choose(page,'110592:q8_0:gpu');
  assert.equal((await state()).status, 'idle', 'selection alone must not load');
  assert.match(await page.locator('.context-selected').innerText(), /Selected: 108K \(Q8\)/);
  const loadSelected=page.getByRole('button',{name:/Load selected configuration|Загрузить выбранную конфигурацию/});
  assert(await loadSelected.isEnabled());
  assert.match(await loadSelected.getAttribute('class'),/primary/);

  await application.evaluate(()=>global.contextFixture.set({loadDelayMs:700}));
  await page.getByRole('button', { name: /Load selected configuration|Загрузить выбранную конфигурацию/ }).click();
  await page.locator('.context-load[aria-busy=true]').waitFor();
  assert(await page.locator('.context-load').isDisabled());

  await page.waitForFunction(() => document.querySelector('.context-active')?.textContent.includes('108K (Q8)'));
  assert.equal((await state()).contextWindow, 110592); assert.equal((await state()).kvCacheType, 'q8_0');
  await page.waitForFunction(() => document.querySelector('.context-load')?.getAttribute('aria-busy') === 'false');
  assert(await page.locator('.context-load').isDisabled());
  await application.evaluate(()=>global.contextFixture.set({loadDelayMs:0}));
  assert.match(await page.locator('.context-active').innerText(),/Active: 108K \(Q8\)/);
  await choose(page,'73728:f16:gpu');
  assert.match(await page.locator('.context-selected').innerText(),/Selected: 72K \(FP16\)/);
  assert.match(await page.locator('.context-active').innerText(),/Active: 108K \(Q8\)/);
  assert(await loadSelected.isEnabled());
  const launches=await application.evaluate(()=>global.contextFixture.launches.length);
  await choose(page,'110592:q8_0:gpu');
  assert(await loadSelected.isDisabled(),'reselecting the effective tuple needs no reload');
  assert.equal(await application.evaluate(()=>global.contextFixture.launches.length),launches);

  await selector(page).click();
  await page.waitForFunction(() => document.querySelector('[data-context-id="110592:q8_0:gpu"]')?.getAttribute('data-fit-status') === 'maximum');
  assert.equal(await page.locator('[data-context-id="16384:f16:gpu"]').getAttribute('data-fit-status'),'fit');
  assert.equal(await page.locator('[data-context-id="131072:f16:gpu"]').getAttribute('data-fit-status'),'above');
  const classifications = () => page.getByRole('option').evaluateAll(rows => rows.map(row => [row.dataset.contextId, row.dataset.fitStatus, row.title]));
  const stableClassifications = await classifications();
  await page.keyboard.press('Escape');
  // Exercise the real mounted Toolbar/poller/preload/IPC, not a selector-only render.
  // Desktop readings cross the old 256 MiB tolerance without losing capacity.
  for (const [index, backgroundMiB] of [1290, 1270, 1290, 1270, 1290, 1270].entries()) {
    await application.evaluate((_electron, flags) => global.contextFixture.set(flags), { backgroundMiB, missingTelemetry: index === 3 });
    await application.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width,900), index % 2 ? 1280 : 980);
    await page.waitForTimeout(2200); // Include the production 2-second status subscription.
    await selector(page).click();
    assert.deepEqual(await classifications(), stableClassifications, 'resize/reopen/rerender/brief missing telemetry preserves both KV classifications');
    await page.keyboard.press('Escape');
  }
  await application.evaluate(() => global.contextFixture.set({ backgroundMiB: 1024, missingTelemetry: false }));
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,900));
  await page.waitForTimeout(2200);
  const popover=page.locator('.context-estimate-details');
  await page.locator('.context-estimate > summary').click();
  await page.waitForFunction(()=>document.querySelector('[data-vram=used] dd')?.textContent.includes('21.0'));
  assert.equal(await popover.locator('.context-vram-summary').count(),1,'shared telemetry appears once');
  assert.equal(await popover.locator('details').count(),0,'no internal diagnostics or per-KV budgets');
  assert.match(await popover.locator('[data-kv-type=f16]').innerText(),/72K/);
  assert.match(await popover.locator('[data-kv-type=q8_0]').innerText(),/108K/);
  assert.match(await popover.locator('.context-supported-limit').innerText(),/256K/);
  assert.match(await popover.locator('[data-vram=total] dd').innerText(),/24.0/);
  assert.match(await popover.locator('[data-vram=free] dd').innerText(),/3.0/);
  assert(!/\b(driver|reserves?|budget|RAM)\b|active context|runtime diagnostics/i.test(await popover.innerText()),'popover contains only compact summary');
  const assertFits=async()=>{
    await page.waitForFunction(()=>{const n=document.querySelector('.context-estimate-details'),r=n.getBoundingClientRect();return r.left>=11 && r.top>=11 && r.right<=innerWidth-11 && r.bottom<=innerHeight-11 && n.scrollWidth<=n.clientWidth;});
  };
  for (const [width,height,columns] of [[1280,900,2],[980,640,2],[640,480,1],[360,300,1]]) {
    await application.evaluate(({BrowserWindow},[width,height])=>BrowserWindow.getAllWindows()[0].setContentSize(width,height),[width,height]);
    await page.waitForFunction(([width,height])=>innerWidth===width && innerHeight===height,[width,height]);
    await assertFits();
    assert.equal(await popover.locator('.context-memory-results').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),columns);
  }
  assert(await popover.evaluate(n=>n.scrollHeight>n.clientHeight),'short windows scroll vertically inside popover');
  await popover.evaluate(n=>{n.scrollTop=n.scrollHeight;});
  assert(await popover.evaluate(n=>n.scrollTop>0));
  // Right/bottom-edge anchoring must clamp horizontally and choose space above.
  await page.locator('.context-estimate > summary').evaluate(n=>Object.assign(n.style,{position:'fixed',left:`${innerWidth-40}px`,top:`${innerHeight-35}px`}));
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
  await assertFits();
  assert(await popover.evaluate(n=>n.getBoundingClientRect().bottom<=document.querySelector('.context-estimate > summary').getBoundingClientRect().top-7));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.context-estimate').getAttribute('open'),null);
  await page.locator('.context-estimate > summary').evaluate(n=>n.removeAttribute('style'));
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,900));
  await page.waitForFunction(()=>innerWidth===1280);
  await application.close(); application = null;
  page = await launch();
  assert.match(await choices(page), /108K \(Q8\)/, 'restart preserves requested context/KV');
  assert.equal((await state()).status, 'idle');
  await page.getByRole('button', { name: /Load selected configuration|Загрузить выбранную конфигурацию/ }).click();
  await page.waitForFunction(() => document.querySelector('.context-active')?.textContent.includes('108K (Q8)'));
  await application.evaluate(() => global.contextFixture.set({ freshPair: true, nearBoundary: true, backgroundMiB: 1142 }));
  await page.getByRole('button', { name: /Find maximum context|Найти максимальный контекст/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.context-discover')].some(b => !b.disabled && /Find maximum context|Найти максимальный контекст/.test(b.textContent)));
  assert.match(await choices(page), /76K \(FP16\)/);
  assert.match(await choices(page), /112K \(Q8\)/);
  await selector(page).click();
  const nearBoundaryClassifications = await classifications();
  assert.equal(await page.locator('[data-context-id="77824:f16:gpu"]').getAttribute('data-fit-status'),'maximum');
  assert.equal(await page.locator('[data-context-id="114688:q8_0:gpu"]').getAttribute('data-fit-status'),'maximum');
  await page.keyboard.press('Escape');
  for (const backgroundMiB of [1187, 1177, 1197, 1177]) {
    await application.evaluate((_electron, backgroundMiB) => global.contextFixture.set({ backgroundMiB }), backgroundMiB);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(2200);
    await selector(page).click();
    assert.deepEqual(await classifications(), nearBoundaryClassifications, '39/49 MiB margin jitter cannot alternate FP16/Q8 dropdown warnings');
    await page.keyboard.press('Escape');
  }
  await application.evaluate(() => global.contextFixture.set({ backgroundMiB: 1142 }));
  await application.evaluate(() => global.contextFixture.set({ pressure: true }));
  await page.waitForTimeout(2300);
  assert.match(await choices(page), /108K \(Q8\)/);
  await application.evaluate(() => global.contextFixture.set({ pressure: false, startupFailure: true }));
  await choose(page,'77824:f16:gpu');
  await page.getByRole('button', { name: /Load selected configuration|Загрузить выбранную конфигурацию/ }).click();
  await page.waitForFunction(() => document.body.textContent.includes('fixture CUDA out of memory'));
  assert.match(await selector(page).innerText(), /76K \(FP16\)/); assert.equal((await state()).contextWindow, 110592);
  await page.locator('.context-load-diagnostic > summary').click();
  assert.match(await page.locator('.context-requested').innerText(), /76K \(FP16\)/, 'failed requested tuple must remain visible separately from selected rollback');
  assert.match(await page.locator('.context-active').innerText(), /108K \(Q8\)/, 'effective tuple must still describe the running fixture');
  await application.evaluate(() => global.contextFixture.set({ startupFailure: false, discoveryFailure: true }));
  await page.getByRole('button', { name: /Find maximum context|Найти максимальный контекст/ }).click();
  await page.waitForFunction(() => document.body.textContent.includes('fixture interrupted discovery'));
  assert.match(await choices(page), /108K \(Q8\)/);
  await application.evaluate(() => global.contextFixture.set({ discoveryFailure: false }));
  await choose(page,'77824:f16:gpu');
  await page.getByRole('button', { name: /Load selected configuration|Загрузить выбранную конфигурацию/ }).click();
  await page.waitForFunction(() => document.querySelector('.context-active')?.textContent.includes('76K (FP16)'));
  assert.equal((await state()).kvCacheType, 'f16');
  assert.equal(await application.evaluate(() => global.contextFixture.db.listMessages(global.contextFixture.chat.id).length), 2);
  // Chat context is not part of discovery identity; switching never rediscovers or reloads.
  await page.waitForTimeout(6500); // Let a prior, genuine pressure warning recover on stable samples.
  await selector(page).click();
  const beforeChatSwitch = await classifications();
  await page.keyboard.press('Escape');
  const launchesBeforeChatSwitch = await application.evaluate(() => global.contextFixture.launches.length);
  await page.locator('.new-chat').click();
  await page.waitForFunction(() => document.querySelectorAll('.chat-row').length === 2);
  await selector(page).click();
  assert.deepEqual(await classifications(), beforeChatSwitch, 'new chat preserves independent saved measurement statuses');
  await page.keyboard.press('Escape');
  await page.locator('.chat-row:not(.active) .chat-select').click();
  await selector(page).click();
  assert.deepEqual(await classifications(), beforeChatSwitch, 'returning to the original chat preserves saved measurements');
  await page.keyboard.press('Escape');
  assert.equal(await application.evaluate(() => global.contextFixture.launches.length), launchesBeforeChatSwitch);
  await application.close();application=null;
  page=await launch({LOCAL_AI_CONTEXT_FIXTURE_LIMIT:'131072'});
  await page.locator('.context-estimate > summary').click();
  assert.match(await page.locator('.context-supported-limit').innerText(),/128K/,'supported limit follows model/backend metadata, not a hardcoded 256K');
  assert.match(await page.locator('[data-vram=total] dd').innerText(),/unknown|неизвестно/i,'unavailable telemetry is not fabricated from historical discovery');
  console.log('Maximum Context popover: live shared telemetry, dynamic model limit, independent results, 2/1 columns, 1280/980/640/360 sizing, edge placement, vertical scrolling and no horizontal overflow passed.');

  console.log('Real Electron/preload/IPC/SQLite: 72K FP16 and 108K Q8 selectable, restart, unloaded catalog, explicit activation, discovery completion/failure, startup rollback and unchanged history passed. GPU/runtime/discovery mocked; no real llama-server launched.');
  console.log('GPU-fit stability: live dropdown polling, repeated resize/open/close, brief telemetry loss, per-KV 39/49 MiB margin jitter and chat switching passed.');
} finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }); }
