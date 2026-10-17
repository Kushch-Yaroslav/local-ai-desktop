// Actual renderer/preload/main IPC + Chromium. Inference is not involved.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
const root = await mkdtemp(join(tmpdir(), 'lad-controls-electron-'));
let app;
try {
  app = await electron.launch({ executablePath: resolve('scripts/electron-unconfined-fixture.sh'), args: [resolve('test-fixtures/live-browser/electron-main.cjs')], env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root } });
  const window = await app.firstWindow(); window.setDefaultTimeout(15000);
  const errors = []; window.on('pageerror', error => errors.push(String(error)));
  await window.locator('.conversation').waitFor();
  const chatId = await app.evaluate(() => global.liveFixture.chat);
  const chats = await window.evaluate(() => window.localAi.conversations.list());
  await window.locator('.chat-select').filter({ hasText: chats.find(c => c.id === chatId).title }).first().click();
  assert(!(await app.evaluate(() => global.liveFixture.open())).error);
  await window.locator('.mode-split').waitFor();
  await app.evaluate(() => global.liveFixture.interactiveSetup());
  const canvas = window.locator('.live-viewport canvas');
  await canvas.click(); await window.keyboard.press('w');
  assert.deepEqual((await app.evaluate(() => global.liveFixture.interactiveSnapshot())).keys, [], 'input while Agent Controlled is blocked');
  await app.evaluate(() => global.liveFixture.finish());
  await window.waitForFunction(() => /User Controlled|Управляете вы/.test(document.querySelector('.live-footer')?.textContent ?? ''));
  await window.waitForFunction(() => /[1-9]\d* fps/.test(document.querySelector('.live-footer')?.textContent ?? ''));
  const snapshot = () => app.evaluate(() => global.liveFixture.interactiveSnapshot());
  const identity = (await snapshot()).identity;
  const point = async (x, y) => {
    const box = await canvas.boundingBox(); await window.mouse.click(box.x + x * box.width / 1280, box.y + y * box.height / 900);
  };
  const target = async selector => { const positions = await app.evaluate(() => global.liveFixture.interactiveTargets()); await point(positions[selector].x, positions[selector].y); };
  // Preview canvas is rendered with scaled coordinates. The ORBIT page input is below its animation.
  await target('canvas'); await window.keyboard.press('w'); await window.keyboard.press('a'); await window.keyboard.press('s'); await window.keyboard.press('d');
  await window.waitForTimeout(150); assert.deepEqual((await snapshot()).keys, ['w', 'a', 's', 'd']);
  await target('#message'); await window.keyboard.type('Desktop input');
  await window.waitForTimeout(150); assert.equal((await snapshot()).input, 'Desktop input');
  await canvas.hover(); await window.mouse.wheel(0, 500); await window.waitForTimeout(250); assert((await snapshot()).scroll > 0);
  await window.mouse.wheel(0, -1200); await window.waitForTimeout(250);
  await target('#explore'); await window.waitForTimeout(250); assert.match((await snapshot()).url, /#explore$/);
  await window.getByRole('button', { name: 'Back', exact: true }).click(); await window.waitForTimeout(200); assert(!(await snapshot()).url.includes('#explore'));
  await window.getByRole('button', { name: 'Forward', exact: true }).click(); await window.waitForTimeout(200); assert.match((await snapshot()).url, /#explore$/);
  assert.equal((await snapshot()).identity, identity, 'same Chromium Page between run and interactive input');
  assert(!(await app.evaluate(() => global.liveFixture.begin())).error);
  await window.waitForFunction(() => /Agent Controlled/.test(document.querySelector('.live-footer')?.textContent ?? ''));
  await target('canvas'); await window.keyboard.press('w'); await window.waitForTimeout(100);
  assert.deepEqual((await snapshot()).keys, ['w', 'a', 's', 'd'], 'agent reacquires input ownership');
  await window.getByRole('button', { name: 'Close Browser', exact: true }).click();
  await window.locator('.mode-chat').waitFor();
  await window.waitForFunction(() => /Последний кадр|Last frame/.test(document.querySelector('.live-reopen')?.textContent ?? ''));
  assert.deepEqual(errors, []);
  console.log('PASS actual Electron + Chromium: scaled clicks, text, WASD, scroll, Back/Forward, continued stream, agent takeover and panel disposal through preload/IPC');
} finally { await app?.close(); }
