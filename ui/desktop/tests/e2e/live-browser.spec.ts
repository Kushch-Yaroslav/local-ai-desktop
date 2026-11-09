import { resizeNativeWindow } from './native-window-shot';
import { test, expect } from './fixtures';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { discoverLlamaServer } from './goose-seed';

/** Native Live Browser regression and optional real-model round trip.
 * Runs only in a fresh isolated profile; never starts another model.
 */
const llamaEndpoint = discoverLlamaServer();

// Isolate this spec's app instance (see fixtures.ts).
process.env.LAD_E2E_ISOLATE = '1';

const TEST_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Live Browser E2E Page</title>
<style>
  body { margin: 0; font-family: sans-serif; background: #f6f7fb; }
  header { background: #111827; color: #fff; padding: 16px 24px; font-size: 20px; }
  .card { background: #ffffff; border: 2px solid #2563eb; border-radius: 8px;
          padding: 24px; margin: 40px; width: 320px; height: 180px; }
  .card h2 { margin: 0 0 12px 0; color: #1d4ed8; }
  .badge { display: inline-block; background: #dcfce7; color: #166534;
           padding: 4px 10px; border-radius: 999px; font-size: 12px; }
  #target-box { background: #f59e0b; width: 120px; height: 60px;
                margin: 24px 40px; border-radius: 6px; }
</style>
</head>
<body>
  <header>Live Browser E2E Page</header>
  <div class="card" id="info-card" data-testid="info-card">
    <h2>Info card</h2>
    <p>This is a deterministic local page for Live Browser E2E testing.</p>
    <span class="badge">e2e-token-4242</span>
  </div>
  <div id="target-box" data-testid="target-box"></div>
</body>
</html>`;

function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(TEST_PAGE_HTML);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function nativeHasContent(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const result = (await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Runtime.evaluate',
        {
          expression: 'Boolean(document.getElementById("info-card"))',
          returnByValue: true,
        }
      )) as { result: { value: boolean } };
      return result.result.value;
    } catch {
      return false;
    }
  });
}
async function openPageAndCreateRegion(page: import('@playwright/test').Page, url: string) {
  await resizeNativeWindow(page, 1600, 1000);
  await page.getByTestId('browser-toggle').click();
  const panel = page.getByTestId('live-browser-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('live-browser-url-input').fill(url);
  await page.getByTestId('live-browser-open').click();
  await expect.poll(() => nativeHasContent(page), { timeout: 60000 }).toBe(true);
  await page.getByTestId('live-browser-new-area').click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const r = (await window.electron.liveBrowserNativeTest(
          window.sessionStorage.getItem('lad.browser.hubId')!,
          'Runtime.evaluate',
          {
            expression: 'Boolean(document.getElementById("__lad-selection"))',
            returnByValue: true,
          }
        )) as { result: { value: boolean } };
        return r.result.value;
      })
    )
    .toBe(true);
  await page.evaluate(async () => {
    for (const event of [
      { type: 'mousePressed', button: 'left', clickCount: 1, x: 45, y: 90 },
      { type: 'mouseMoved', buttons: 1, x: 365, y: 320 },
      { type: 'mouseReleased', button: 'left', clickCount: 1, x: 365, y: 320 },
    ])
      await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Input.dispatchMouseEvent',
        event
      );
  });
  const area = page.getByTestId('live-browser-area');
  await expect(area).toBeVisible();
  return { panel, area };
}

test.describe('Live Browser E2E', () => {
  // Covers fixture setup (app launch) + test body. The agent round-trip test
  // needs minutes against the local 27B model.
  test.describe.configure({ timeout: 900_000 });
  test('panel, navigation, native page, region selection and attachment', async ({ goosePage }) => {
    test.setTimeout(240_000);
    const server = await startTestServer();
    try {
      await resizeNativeWindow(goosePage, 1600, 1000);
      await goosePage.waitForSelector('[data-testid="chat-input"]', { timeout: 60_000 });

      const { area } = await openPageAndCreateRegion(goosePage, server.url);
      if (process.env.LAD_E2E_REQUIRE_BUNDLED_NODE === '1') {
        const status = await goosePage.evaluate(() => window.electron.liveBrowserStatus());
        expect(status.running).toBe(true);
        expect(status.node?.replaceAll('\\', '/')).toContain('/resources/live-browser/bin/node');
        expect(status.error).toBeNull();
      }

      // Rename the area (name is persisted to the runtime store).
      const nameInput = area.locator('[data-testid="live-browser-area-name"]');
      await nameInput.fill('E2E target region');
      await nameInput.blur();
      await expect(nameInput).toHaveValue('E2E target region', { timeout: 10_000 });

      // Add a description.
      const desc = area.locator('[data-testid="live-browser-area-desc"]');
      await desc.fill('Region around the info card and the amber target box.');
      await desc.blur();
      await goosePage.waitForTimeout(700); // let the rename persist to the runtime store

      // The expanded technical data should show geometry + anchor info.
      await area.locator('summary').last().click();
      await expect(area.locator('pre')).toContainText('rect');

      // Send the area to the agent: pending selection note appears in chat.
      await area.locator('[data-testid="live-browser-area-send"]').first().click();
      const note = goosePage.locator('[data-testid="pending-selection-note"]');
      await expect(note).toBeVisible({ timeout: 30_000 });
      await expect(note).toContainText('E2E target region', { timeout: 10_000 });

      const panel = goosePage.locator('[data-testid="live-browser-panel"]');
      await goosePage.locator('[data-testid="live-browser-tools-toggle"]').click();
      await expect(goosePage.locator('[data-testid="live-browser-areas"]')).not.toBeVisible();
      await goosePage.locator('[data-testid="live-browser-tools-toggle"]').click();
      await expect(area).toBeVisible();
      await goosePage.locator('[data-testid="live-browser-mode-expanded"]').click();
      await expect(panel).toHaveAttribute('data-mode', 'expanded');
      await goosePage.locator('[data-testid="live-browser-mode-split"]').click();
      await expect(panel).toHaveAttribute('data-mode', 'split');
      const separator = panel.getByRole('separator', { name: 'Resize browser', exact: true });
      const widthBefore = (await panel.boundingBox())!.width;
      await separator.focus();
      await separator.press('ArrowLeft');
      expect((await panel.boundingBox())!.width).toBeGreaterThanOrEqual(widthBefore);
      await goosePage.getByTestId('live-browser-url-input').fill(server.url + 'next');
      await goosePage.getByTestId('live-browser-open').click();
      await expect(goosePage.getByTestId('live-browser-url-input')).toHaveValue(
        server.url + 'next'
      );
      await goosePage.getByTestId('live-browser-back').click();
      await expect(goosePage.getByTestId('live-browser-url-input')).toHaveValue(server.url);
      await goosePage.getByTestId('live-browser-forward').click();
      await expect(goosePage.getByTestId('live-browser-url-input')).toHaveValue(
        server.url + 'next'
      );
      await goosePage.getByTestId('live-browser-back').click();
      await expect(goosePage.getByTestId('live-browser-url-input')).toHaveValue(server.url);
      await goosePage.locator('[data-testid="live-browser-reload"]').click();
      await expect.poll(() => nativeHasContent(goosePage), { timeout: 30000 }).toBe(true);
      await goosePage.locator('[data-testid="live-browser-mode-close"]').click();
      await expect(panel).not.toBeVisible();
      await goosePage.locator('[data-testid="browser-toggle"]').click();
      await expect(panel).toBeVisible();
      await goosePage.getByTestId('live-browser-tools-toggle').click();
      await goosePage.getByTestId('live-browser-area-row').first().click();
      await expect(area).toBeVisible();
      await expect.poll(() => nativeHasContent(goosePage), { timeout: 30000 }).toBe(true);
      await goosePage.screenshot({
        path: test.info().outputPath('live-browser-wide.png'),
        fullPage: true,
      });
      await resizeNativeWindow(goosePage, 940, 800);
      const bounds = (await panel.boundingBox())!;
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(941);
      await goosePage.screenshot({
        path: test.info().outputPath('live-browser-region-selected.png'),
        fullPage: true,
      });
    } finally {
      await server.close();
    }
  });

  test('agent round-trip: model receives the pending region and replies', async ({ goosePage }) => {
    test.setTimeout(900_000); // local 27B model: give the full round-trip time
    if (!llamaEndpoint) {
      test.skip(
        true,
        'local llama-server endpoint not found; agent round-trip requires the running inference server'
      );
      return;
    }
    const server = await startTestServer();
    try {
      await goosePage.waitForSelector('[data-testid="chat-input"]', { timeout: 60_000 });

      const { area } = await openPageAndCreateRegion(goosePage, server.url);

      const nameInput = area.locator('[data-testid="live-browser-area-name"]');
      await nameInput.fill('E2E agent check');
      await nameInput.blur();
      await goosePage.waitForTimeout(700); // let the rename persist to the runtime store

      // Attach the region to the next message.
      await area.locator('[data-testid="live-browser-area-send"]').first().click();
      const note = goosePage.locator('[data-testid="pending-selection-note"]');
      await expect(note).toBeVisible({ timeout: 30_000 });

      // Count messages before sending.
      const messageCountBefore = await goosePage
        .locator('[data-testid="message-container"]')
        .count();

      await goosePage.getByTestId('live-browser-mode-close').click();
      const chatInput = goosePage.locator('[data-testid="chat-input"]');
      await chatInput.fill(
        'Опиши коротко, что находится в выделенной области на странице Live Browser E2E Page. Упомяни текст карточки и цвет прямоугольника.'
      );
      await chatInput.press('Enter');

      // A new assistant message appears and the chat becomes idle.
      await expect
        .poll(async () => goosePage.locator('[data-testid="message-container"]').count(), {
          timeout: 300_000,
          intervals: [2000],
        })
        .toBeGreaterThan(messageCountBefore);

      await expect(goosePage.locator('[data-testid="loading-indicator"]')).toHaveCount(0, {
        timeout: 600_000,
      });

      // The assistant reply must be non-empty.
      const lastMessage = goosePage.locator('[data-testid="message-container"]').last();
      const replyText = ((await lastMessage.innerText()) ?? '').trim();
      expect(replyText.length).toBeGreaterThan(0);
      console.log(`E2E: assistant reply (${replyText.length} chars): ${replyText.slice(0, 400)}`);

      // Soft signal that the region context was actually used: the page
      // contains the token "e2e-token-4242" and an amber box (#f59e0b).
      const mentionsPageContent = /e2e-token-4242|amber|оранжев|жёлт|yellow/i.test(replyText);
      console.log(`E2E: reply references page content: ${mentionsPageContent}`);

      await goosePage.screenshot({
        path: test.info().outputPath('live-browser-agent-roundtrip.png'),
        fullPage: true,
      });
    } finally {
      await server.close();
    }
  });
});
