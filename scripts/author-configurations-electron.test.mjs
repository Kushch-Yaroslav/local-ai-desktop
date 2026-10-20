// Real Electron renderer/preload UI with a controlled GPT-OSS profile fixture.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron } from 'playwright-core';

const root = await mkdtemp('/tmp/lad-author-config-ui-');
const id = 'custom:123e4567-e89b-42d3-a456-426614174121';
let app;
try {
  app = await _electron.launch({
    executablePath: resolve('scripts/electron-unconfined-fixture.sh'),
    args: [resolve('test-fixtures/live-browser/electron-main.cjs')],
    env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root, LOCAL_AI_TEST_PROFILES_V2: '1', LOCAL_AI_TEST_MODEL: id },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('.conversation').waitFor();
  await page.locator('.runtime-setup-action').click();
  await page.locator('.runtime-model-select').filter({ hasText: 'GPT-OSS fixture' }).click();
  const editor = page.locator('.runtime-model-editor');
  const draft = editor.getByLabel('MTP Draft GGUF', { exact: true });
  assert(await draft.isVisible(), 'Draft GGUF is available in Simple mode');
  await draft.fill('/tmp/author-ui-draft.gguf');
  await editor.getByRole('button', { name: 'Advanced', exact: true }).click();
  assert.equal(await draft.inputValue(), '/tmp/author-ui-draft.gguf', 'Advanced mode preserves the draft path');
  await editor.getByRole('button', { name: 'Simple', exact: true }).click();
  assert.equal(await draft.inputValue(), '/tmp/author-ui-draft.gguf', 'Simple mode preserves the draft path');
  await draft.fill('');
  await editor.getByRole('button', { name: 'Advanced', exact: true }).click();
  await editor.getByText('Author-tested configurations', { exact: true }).click();

  const before = await page.evaluate(async () => (await window.localAi.settings.get()).setup.config.models.find(model => model.id === 'custom:123e4567-e89b-42d3-a456-426614174121'));
  const row = editor.locator('tr').filter({ hasText: 'GPT-OSS-120B Q4_K_M' });
  const button = row.getByRole('button', { name: 'Use as a starting point', exact: true });
  assert(await button.isEnabled(), 'Compatible observation is actionable');
  await button.click();
  await editor.getByRole('status').filter({ hasText: 'Values applied to the draft' }).waitFor();
  await editor.getByText('Memory and acceleration', { exact: true }).click();
  assert.equal(await editor.getByLabel('Profile context', { exact: true }).inputValue(), '32768', 'Preset values immediately update the editable form');
  const after = await page.evaluate(async () => (await window.localAi.settings.get()).setup.config.models.find(model => model.id === 'custom:123e4567-e89b-42d3-a456-426614174121'));
  assert.deepEqual(after, before, 'Applying a preset does not save the profile');
  console.log('PASS Electron author preset updates the visible draft only; MTP draft path remains available across Simple/Advanced mode changes.');
} finally {
  await app?.close();
}
