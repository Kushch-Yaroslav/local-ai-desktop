// Real Electron renderer and preload: all visible panel controls expose their own contextual help.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = await mkdtemp('/tmp/lad-control-tips-');
let app;
try {
  app = await electron.launch({
    executablePath: resolve('scripts/electron-unconfined-fixture.sh'),
    args: [resolve('test-fixtures/live-browser/electron-main.cjs')],
    env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.locator('.conversation').waitFor();
  await page.locator('.chat-select').filter({ hasText: 'Live Browser workspace' }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  if (await page.locator('.panel-mode-toggle').getAttribute('aria-expanded') === 'false') await page.locator('.panel-mode-toggle').click();
  await page.waitForFunction(() => document.querySelectorAll('.control-group').length === 4);

  const audit = () => page.locator('.control-panel').evaluate(rootElement => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !element.closest('[inert]');
    };
    const isHelpTrigger = element => element.matches('.help-trigger');
    const controls = [...rootElement.querySelectorAll('select, button, summary, [role="combobox"], [role="switch"]')]
      .filter(element => visible(element) && !isHelpTrigger(element));
    const hasNearbyHelp = element => {
      let node = element;
      while (node && node !== rootElement) {
        if ([...node.children].some(child => child.matches('.control-help'))) return true;
        if (node.matches('.context-selector, .mtp-control, .context-estimate-wrap, .browser-qa-panel-wrap') && node.querySelector('.help-trigger')) return true;
        if (node.querySelector(':scope > .control-help .help-trigger')) return true;
        node = node.parentElement;
      }
      return false;
    };
    return {
      controls: controls.map(element => ({ label: element.getAttribute('aria-label') || element.innerText || element.tagName, tag: element.tagName })),
      missing: controls.filter(element => !hasNearbyHelp(element)).map(element => element.getAttribute('aria-label') || element.innerText || element.tagName),
      helpCount: rootElement.querySelectorAll('.help-trigger').length,
    };
  });

  const english = await audit();
  assert.equal(english.missing.length, 0, `controls without a nearby help trigger: ${JSON.stringify(english.missing)}`);
  assert(english.helpCount >= 15, `expected help coverage across model, reasoning, browser, QA and project controls; got ${english.helpCount}`);
  for (const name of ['MTP', 'Browser Vision', 'Autonomous Browser QA', 'Model', 'Context', 'Thinking', 'Reasoning effort', 'Agent strategy', 'Web', 'Mode', 'Working project 1', 'Working project 2']) {
    assert(english.helpCount > 0 && await page.getByRole('button', { name: `Help for ${name}`, exact: true }).count() > 0, `missing translated help trigger: ${name}`);
  }

  const tip = page.getByRole('button', { name: 'Help for MTP', exact: true });
  await tip.focus();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  assert.equal(await tip.getAttribute('aria-describedby'), await tooltip.getAttribute('id'));
  assert.match(await tooltip.innerText(), /Multi-Token Prediction/);
  await page.keyboard.press('Escape');
  assert.equal(await tooltip.count(), 0);

  // Force an edge anchor and verify the custom tooltip stays in the Electron viewport.
  await tip.evaluate(element => { element.style.position = 'fixed'; element.style.right = '2px'; element.style.bottom = '2px'; element.style.left = 'auto'; });
  await page.locator('.control-panel select').first().focus();
  await tip.focus();
  await tooltip.waitFor();
  const bounds = await tooltip.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(bounds && viewport && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, 'tooltip remains inside window edges');
  await page.keyboard.press('Escape');

  for (const language of ['ru', 'en']) {
    await page.evaluate(language => window.localAi.settings.setLanguage(language), language);
    await page.waitForTimeout(100);
    const current = await audit();
    assert.equal(current.missing.length, 0, `${language} controls all retain help`);
    assert(current.helpCount >= 15);
    assert.equal(await page.getByRole('button', { name: language === 'ru' ? 'Справка: MTP' : 'Help for MTP', exact: true }).count(), 1, `${language} has a localized accessible help label`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const trigger = page.locator('.control-panel .help-trigger').first();
    await page.locator('.control-panel select').first().focus();
    await trigger.focus();
    await page.getByRole('tooltip').waitFor();
    assert.equal(await page.getByRole('tooltip').evaluate(element => getComputedStyle(element).animationName), 'none');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 850));
    await page.waitForTimeout(100);
    const narrow = await page.locator('.control-panel').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, viewport: document.documentElement.clientWidth, body: document.documentElement.scrollWidth }));
    assert(narrow.scroll <= narrow.width + 2 && narrow.body <= narrow.viewport + 2, `${language} narrow panel has no horizontal overflow`);
    await mkdir(resolve('artifacts/p2'), { recursive: true });
    await page.screenshot({ path: resolve(`artifacts/p2/control-tooltips-${language}.png`) });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  }

  const controlsBefore = await page.locator('.control-panel select').count();
  const toggle = page.locator('.panel-mode-toggle');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.control-panel select').count(), controlsBefore, 'collapsing does not unmount controls or reset the model state');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', root, controlsAudited: english.controls.length, tooltipTriggers: english.helpCount, locales: ['ru', 'en'], narrowWidth: 760, keyboard: true, edgePlacement: true, reducedMotion: true, compactKeepsControlsMounted: true }));
} finally {
  await app?.close();
}
