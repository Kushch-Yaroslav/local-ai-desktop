import { test, expect } from './fixtures';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { discoverLlamaServer } from './goose-seed';

/**
 * Live Browser E2E.
 *
 * Verifies the real Electron UI end to end:
 *  1. Browser icon toggles the right-side panel (split mode).
 *  2. The runtime canvas appears (runtime auto-started by Electron main).
 *  3. URL navigation loads a page and a live CDP screencast frame renders
 *     on the canvas (same Playwright Page the agent tools operate on).
 *  4. Region selection: draw a rectangle → grounded area appears with
 *     technical data (viewport/dpr/scroll/rect/anchors).
 *  5. Area rename + "→ agent" produces the pending selection context that
 *     is prepended to the next chat message.
 *  6. Agent round-trip: a message sent with a pending region reaches the
 *     local model (shared llama-server) and produces a reply.
 *
 * Isolation: the spec runs with LAD_E2E_ISOLATE=1 (see fixtures.ts), so the
 * test app instance gets a unique LOCAL_AI_DESKTOP_DEV_ROOT (unique userData
 * → no Electron single-instance lock collision with a running app) and a
 * fresh GOOSE_PATH_ROOT. The seeded goose config enables ONE provider that
 * points at the ALREADY-RUNNING local llama-server (discovered via /proc),
 * so the agent round-trip reuses the same inference endpoint without
 * loading a second model or touching the server's lifecycle. llama.cpp runs
 * with n_slots and a unified KV cache, so a second concurrent session is
 * memory-safe.
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

/** True when the screencast canvas has non-black pixels (a frame arrived). */
async function canvasHasContent(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector(
      '[data-testid="live-browser-canvas"]'
    ) as HTMLCanvasElement | null;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      const w = Math.max(1, Math.floor(canvas.width / 8));
      const h = Math.max(1, Math.floor(canvas.height / 8));
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 16 || data[i + 1] > 16 || data[i + 2] > 16) return true;
      }
      return false;
    } catch {
      return false;
    }
  });
}

async function openPageAndCreateRegion(page: import('@playwright/test').Page, url: string) {
  // Toggle the panel open (split mode).
  const toggle = page.locator('[data-testid="browser-toggle"]');
  await expect(toggle).toBeVisible({ timeout: 30000 });
  await toggle.click();

  const panel = page.locator('[data-testid="live-browser-panel"]');
  await expect(panel).toBeVisible({ timeout: 30000 });
  await expect(panel).toHaveAttribute('data-mode', 'split', { timeout: 30000 });

  // Runtime canvas appears (Electron main auto-starts the runtime bundle).
  const canvas = page.locator('[data-testid="live-browser-canvas"]');
  await expect(canvas).toBeVisible({ timeout: 90000 });

  // Navigate to the deterministic local page.
  const urlInput = page.locator('[data-testid="live-browser-url-input"]');
  await urlInput.fill(url);
  await page.locator('[data-testid="live-browser-open"]').click();

  // Wait for the live screencast: a frame with non-black content.
  await expect
    .poll(() => canvasHasContent(page), {
      timeout: 60000,
      intervals: [1000],
      message: 'screencast frame with page content',
    })
    .toBe(true);

  // Give the page a moment to fully paint (fonts/layout) before selection.
  await page.waitForTimeout(1500);

  // Enable selection mode and drag a rectangle over the canvas.
  await page.locator('[data-testid="live-browser-new-area"]').click();
  const box = (await canvas.boundingBox())!;
  const x0 = box.x + box.width * 0.2;
  const y0 = box.y + box.height * 0.15;
  const x1 = box.x + box.width * 0.75;
  const y1 = box.y + box.height * 0.75;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 });
  await page.mouse.move(x1, y1, { steps: 5 });
  await page.mouse.up();

  // The grounded area appears in the sidebar.
  const area = page.locator('[data-testid="live-browser-area"]').first();
  await expect(area).toBeVisible({ timeout: 30000 });
  return { panel, canvas, area };
}

test.describe('Live Browser E2E', () => {
  // Covers fixture setup (app launch) + test body. The agent round-trip test
  // needs minutes against the local 27B model.
  test.describe.configure({ timeout: 900_000 });
  test('panel, navigation, screencast, region selection and pending context', async ({
    goosePage,
  }) => {
    test.setTimeout(240_000);
    const server = await startTestServer();
    try {
      await goosePage.setViewportSize({width:1600,height:1000});
      await goosePage.waitForSelector('[data-testid="chat-input"]', { timeout: 60_000 });

      const { area } = await openPageAndCreateRegion(goosePage, server.url);

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
      const technical = area.locator('text=rect');
      await expect(technical).toBeVisible({ timeout: 10_000 });

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
      await goosePage.locator('[data-testid="live-browser-reload"]').click();
      await expect.poll(() => canvasHasContent(goosePage), { timeout: 30000 }).toBe(true);
      await goosePage.locator('[data-testid="live-browser-mode-close"]').click();
      await expect(panel).not.toBeVisible();
      await goosePage.locator('[data-testid="browser-toggle"]').click();
      await expect(panel).toBeVisible();
      await expect(area).toBeVisible();
      await expect.poll(() => canvasHasContent(goosePage), { timeout: 30000 }).toBe(true);
      await goosePage.screenshot({path:test.info().outputPath('live-browser-wide.png'), fullPage:true});
      await goosePage.setViewportSize({width:940,height:800});
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
