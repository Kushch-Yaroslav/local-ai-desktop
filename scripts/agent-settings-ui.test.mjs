// Electron/Chromium UI regression for compact settings, help placement and the Computer Vision placeholder.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright-core';

const runtime = await mkdtemp(join(tmpdir(), 'lad-agent-settings-ui-'));
let app;
try {
  app = await electron.launch({
    executablePath: resolve('scripts/electron-unconfined-fixture.sh'),
    args: [resolve('test-fixtures/live-browser/electron-main.cjs')],
    env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: runtime },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator('.conversation').waitFor();
  await page.locator('.chat-select').filter({ hasText: 'Live Browser workspace' }).click();
  const toggle = page.locator('.panel-mode-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.waitForFunction(() => document.querySelectorAll('.toolbar-controls > .control-group').length === 4);

  const visionSwitch = page.getByRole('switch', { name: /Computer Vision|Компьютерное зрение/ });
  assert.equal(await page.locator('.browser-group .computer-vision-field').count(), 1, 'Computer Vision belongs to Browser & QA, beside the QA control');
  assert(await visionSwitch.isDisabled(), 'Computer Vision stays unavailable until the feature is implemented');
  assert.equal(await visionSwitch.getAttribute('aria-checked'), 'false');
  assert.match(await page.locator('.feature-coming-soon').innerText(), /Coming soon|Скоро/);
  assert.match(await page.locator('.computer-vision-toggle').innerText(), /Feature not implemented|Функция ещё не реализована/);

  const qaSwitch = page.getByRole('switch', { name: /Autonomous Browser QA|Автоматическая проверка браузера/ });
  const initialQaValue = await qaSwitch.getAttribute('aria-checked');
  await qaSwitch.click();
  await page.waitForFunction(initial => document.querySelector('.browser-qa-control [role="switch"]')?.getAttribute('aria-checked') !== initial, initialQaValue);
  assert.notEqual(await qaSwitch.getAttribute('aria-checked'), initialQaValue, 'Browser QA preference remains interactive');
  await qaSwitch.click();
  await page.waitForFunction((initial) => document.querySelector('.browser-qa-control [role="switch"]')?.getAttribute('aria-checked') === initial, initialQaValue);

  const bounds = async () => page.locator('.toolbar-controls').evaluate(root => {
    const rootBox = root.getBoundingClientRect();
    const groups = [...root.querySelectorAll(':scope > .control-group')].map(group => {
      const box = group.getBoundingClientRect();
      const fields = [...group.querySelectorAll('select, [role="switch"], .context-selector-trigger')].map(control => {
        const rect = control.getBoundingClientRect();
        const field = control.closest('.control-field, .context-selector');
        const label = field?.querySelector('.control-label-row');
        return {
          right: rect.right,
          left: rect.left,
          top: rect.top,
          labelBottom: label?.getBoundingClientRect().bottom ?? null,
          width: rect.width,
        };
      });
      return {
        name: group.getAttribute('aria-label'),
        alignSelf: getComputedStyle(group).alignSelf,
        right: box.right,
        left: box.left,
        height: box.height,
        fields,
      };
    });
    const labelRows = [...root.querySelectorAll('.control-label-row')].map(row => {
      const label = row.querySelector('.control-field-label, .context-selector-label');
      const help = row.querySelector('.help-trigger');
      const labelBox = label?.getBoundingClientRect();
      const helpBox = help?.getBoundingClientRect();
      return labelBox && helpBox ? { text: label.innerText, gap: helpBox.left - labelBox.right } : null;
    }).filter(Boolean);
    return { width: root.clientWidth, scrollWidth: root.scrollWidth, right: rootBox.right, groups, labelRows };
  });

  for (const [width, height] of [[1480, 960], [1120, 900], [820, 850], [660, 780]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height]);
    await page.waitForTimeout(120);
    const layout = await bounds();
    assert(layout.scrollWidth <= layout.width + 1, `${width}px panel has no horizontal overflow`);
    assert(layout.groups.every(group => group.alignSelf === 'start'), 'each card sizes to its own content, independent of its grid-row neighbor');
    assert(layout.groups.every(group => group.left >= 0 && group.right <= layout.right + 1), `${width}px cards stay inside their panel`);
    for (const group of layout.groups) {
      for (const field of group.fields) {
        assert(field.right <= layout.right + 1, `${group.name} control does not overflow at ${width}px`);
        if (field.labelBottom !== null) assert(field.top >= field.labelBottom - 1, `${group.name} label/help does not overlap its control at ${width}px`);
      }
    }
    for (const row of layout.labelRows) assert(row.gap >= -1 && row.gap <= 8, `help is immediately beside “${row.text}” at ${width}px (gap ${row.gap}px)`);
    if (process.env.LOCAL_AI_CAPTURE_SETTINGS === '1' && width === 1480) await page.screenshot({ path: '/tmp/lad-agent-settings-ui-wide.png' });
    if (process.env.LOCAL_AI_CAPTURE_SETTINGS === '1' && width === 660) await page.screenshot({ path: '/tmp/lad-agent-settings-ui-narrow.png' });
  }

  const controls = await page.locator('.reasoning-group .control-label-row').allInnerTexts();
  const webAndMode = controls.filter(text => /Web|Веб|Mode|Режим/.test(text));
  assert(webAndMode.length >= 2);
  assert(webAndMode.every(text => !text.includes('◴')), 'Web and Mode labels have no decorative clock symbols');

  const qaHelp = page.locator('.browser-qa-control .help-trigger');
  const tooltip = page.getByRole('tooltip');
  for (const language of ['en', 'ru']) {
    await page.evaluate(language => window.localAi.settings.setLanguage(language), language);
    await page.waitForTimeout(100);
    await qaHelp.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await qaHelp.hover();
    await tooltip.waitFor();
    const helpText = await tooltip.innerText();
    assert.match(helpText, language === 'ru' ? /Если включено/ : /When enabled/);
    assert.match(helpText, language === 'ru' ? /области проекта/ : /project scope/);
    assert.match(helpText, /DOM/);
    await qaHelp.focus();
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(160);
    const rows = await page.locator('.browser-group .control-label-row').evaluateAll(elements => elements.map(row => {
      const label = row.querySelector('.control-field-label, .context-selector-label');
      const help = row.querySelector('.help-trigger');
      return label && help ? help.getBoundingClientRect().left - label.getBoundingClientRect().right : null;
    }).filter(value => value !== null));
    assert(rows.every(gap => gap >= -1 && gap <= 8), `${language} Browser & QA labels keep their help adjacent`);
  }

  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'compact mode remains available');
  await toggle.click();
  assert.deepEqual(await page.locator('.toolbar-controls > .control-group').evaluateAll(groups => groups.map(group => getComputedStyle(group).alignSelf)), ['start', 'start', 'start', 'start']);
  console.log('PASS Electron UI: compact/expanded modes, content-sized cards, adjacent field help, Browser QA guidance and disabled Computer Vision placeholder across 4 window sizes.');
} finally {
  await app?.close();
  await rm(runtime, { recursive: true, force: true });
}
