import { createHash } from 'node:crypto';
import { test, expect } from './fixtures';
import { nativeWindowShot, resizeNativeWindow, nativePointer } from './native-window-shot';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, writeFileSync } from 'node:fs';
process.env.LAD_E2E_ISOLATE = '1';
const html = `<!doctype html><title>Browser 2 QA</title><style>body{margin:0;padding:32px;background:#f3f5f7;font:16px system-ui;min-height:1600px}main{display:block}#product{width:260px;padding:24px;border:2px solid #6a8aaf;border-radius:12px;background:white}.candidate{width:120px;overflow:hidden;white-space:nowrap;margin:12px 0;padding:8px;background:#fff;border:1px solid #b34b4b}input{margin:20px 0}canvas{background:#d9ac75}</style><main><h1>Products</h1><section id="product"><h2>Rinnova Pro</h2><p>Native browser evidence target</p><input id="name" aria-label="Product name"><button id="save" onclick="this.textContent='Saved'">Save</button></section><article><div id="overflow-a" class="candidate">Rinnova Pro extended technical details that do not fit in this card</div><div id="overflow-b" class="candidate">Another product has a title that overflows its narrow card</div><div id="overflow-c" class="candidate">A third catalog card has overflowing text for scan testing</div></article><canvas width="200" height="100"></canvas></main>`;
async function evaluateNative(page: import('@playwright/test').Page, expression: string) {
  return page.evaluate(async (expression) => {
    const result = (await window.electron.liveBrowserNativeTest(
      window.sessionStorage.getItem('lad.browser.hubId')!,
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
      }
    )) as { result: { value: unknown } };
    return result.result.value;
  }, expression);
}
async function nativeRegionState(page: import('@playwright/test').Page, hub: string) {
  return page.evaluate(async (conversationId) => {
    const status = await window.electron.liveBrowserStatus();
    if (!status.endpoint) throw new Error('Live Browser control endpoint is unavailable');
    const response = await fetch(
      `${status.endpoint.url}/control/state?conversation=${encodeURIComponent(conversationId)}`,
      { headers: { Authorization: `Bearer ${status.endpoint.token}` } }
    );
    if (!response.ok) throw new Error(`Live Browser state returned ${response.status}`);
    return response.json() as Promise<{
      areas: { id: string; origin?: string }[];
      regions: {
        id: string;
        areaId: string;
        url: string;
        anchors: {
          selector: string;
          tag: string;
          confidence: number;
          text?: string;
          identity?: { text: string; context?: string };
          rect?: { x: number; y: number; width: number; height: number };
          findings?: { candidate: boolean; category: string; state?: string }[];
        }[];
      }[];
    }>;
  }, hub);
}
test('native page, independent zoom, compact inspector and attachment draft', async ({
  goosePage: page,
}) => {
  test.setTimeout(240000);
  const hub = await page.evaluate(() => window.sessionStorage.getItem('lad.browser.hubId')!);
  await resizeNativeWindow(page, 1600, 1000);
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await page.getByTestId('browser-toggle').click();
    await expect(page.getByTestId('live-browser-panel')).toBeVisible();
    await nativeWindowShot(page, test.info().outputPath('native-empty.png'));
    await page.getByTestId('live-browser-url-input').fill(url);
    await page.getByTestId('live-browser-open').click();
    await expect
      .poll(() => evaluateNative(page, 'document.title'), { timeout: 30000 })
      .toBe('Browser 2 QA');
    await expect(page.getByTestId('live-browser-areas')).not.toBeVisible();
    // Two unsent chats in different windows must never share a scratch Page.
    const nextWindow = page.context().waitForEvent('page', { timeout: 15000 });
    await page.evaluate(() => window.electron.createChatWindow({}));
    const second = await nextWindow;
    await second.getByTestId('browser-toggle').waitFor({ state: 'visible' });
    const secondHub = await second.evaluate(() =>
      window.sessionStorage.getItem('lad.browser.hubId')!
    );
    expect(secondHub).not.toBe(hub);
    await second.getByTestId('browser-toggle').click();
    await second.getByTestId('live-browser-url-input').fill(url + '/?window=two');
    await second.getByTestId('live-browser-open').click();
    await expect(second.getByTestId('live-browser-url-input')).toHaveValue(url + '/?window=two');
    expect(await evaluateNative(page, 'window.location.search')).toBe('');
    await second.close();
    await resizeNativeWindow(page, 1600, 1000);

    // The native page remains visible while inline controls are expanded.
    await page.getByTestId('live-browser-display').click();
    await page.getByRole('button', { name: 'Page zoom', exact: true }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await evaluateNative(page, 'document.title')).toBe('Browser 2 QA');
    await nativeWindowShot(page, test.info().outputPath('native-menu-open.png'));
    await page.getByRole('menuitemradio', { name: '100%', exact: true }).click();

    await nativeWindowShot(page, test.info().outputPath('native-medium.png'));
    if (process.env.LAD_E2E_VISUAL === '1') {
      const panel = page.getByTestId('live-browser-panel'),
        before = (await panel.boundingBox())!;
      const divider = (await panel
        .getByRole('separator', { name: 'Resize browser', exact: true })
        .boundingBox())!;
      await nativePointer(
        page,
        Array.from({ length: 21 }, (_, i) => ({ x: divider.x + 2 - i * 6, y: divider.y + 200 }))
      );
      expect((await panel.boundingBox())!.width).toBeGreaterThan(before.width + 80);
    }

    // Real CDP input on the exact native Page; renderer's canvas is not an input proxy.
    await page.evaluate(async () => {
      const pos = (await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Runtime.evaluate',
        {
          expression:
            '(()=>{const r=document.querySelector("#name").getBoundingClientRect();return {x:r.x+8,y:r.y+8}})()',
          returnByValue: true,
        }
      )) as { result: { value: { x: number; y: number } } };
      await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Input.dispatchMouseEvent',
        {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          ...pos.result.value,
        }
      );
      await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          ...pos.result.value,
        }
      );
      await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Input.imeSetComposition',
        {
          text: 'Продукт 日本語',
          selectionStart: 11,
          selectionEnd: 11,
        }
      );
      await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Input.insertText',
        {
          text: 'Продукт 日本語',
        }
      );
    });
    expect(await evaluateNative(page, 'document.querySelector("#name").value')).toBe(
      'Продукт 日本語'
    );
    const endpoint = (await page.evaluate(() => window.electron.liveBrowserStatus())).endpoint!;
    const client = new Client({ name: 'isolated-browser-qa', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
      })
    );
    try {
      const clicked = await client.callTool({
        name: 'browser_click',
        arguments: { conversation_id: hub, selector: '#save' },
      });
      expect(clicked.isError, JSON.stringify(clicked.content)).not.toBe(true);
      expect(await evaluateNative(page, 'document.querySelector("#save").textContent')).toBe(
        'Saved'
      );
      const screenshot = await client.callTool({
        name: 'browser_screenshot',
        arguments: { conversation_id: hub },
      });
      expect(screenshot.content).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'image' })])
      );
      expect(JSON.stringify(screenshot.content)).toContain('Vision');
      const rect = await evaluateNative(
        page,
        '(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x+2,y:r.y+2,width:r.width-4,height:r.height-4}})()'
      );
      const grounded = (await fetch(
        endpoint.url + `/control/ground?conversation=${encodeURIComponent(hub)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ rect }),
        }
      ).then((r) => r.json())) as {
        region: { anchors: unknown[]; diagnostics: string[] };
        area: { id: string };
      };
      expect(grounded.region.anchors).toEqual([]);
      expect(grounded.region.diagnostics.join(' ')).toContain('Screenshot-only Canvas/SVG');
      const status = await client.callTool({
        name: 'browser_set_area_status',
        arguments: { conversation_id: hub, area_id: grounded.area.id, status: 'Verified' },
      });
      expect(status.isError).toBe(true);
      await fetch(endpoint.url + `/control/area/remove?conversation=${encodeURIComponent(hub)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ areaId: grounded.area.id }),
      });

      await evaluateNative(
        page,
        "document.cookie='qa_scope=hub; Path=/';localStorage.setItem('qa_scope','hub')"
      );
      await page.evaluate(() => window.electron.liveBrowserRegister('isolated-other-chat'));
      await client.callTool({
        name: 'browser_open',
        arguments: { conversation_id: 'isolated-other-chat', url: url + '/?other' },
      });
      expect(await evaluateNative(page, 'window.location.search')).toBe('');
      const other = (await page.evaluate(() =>
        window.electron.liveBrowserNativeTest('isolated-other-chat', 'Runtime.evaluate', {
          expression: '({cookie:document.cookie,storage:localStorage.getItem("qa_scope")})',
          returnByValue: true,
        })
      )) as { result: { value: { cookie: string; storage: string | null } } };
      expect(other.result.value.cookie).not.toContain('qa_scope');
      expect(other.result.value.storage).toBeNull();

      await client.callTool({
        name: 'browser_release_input',
        arguments: { conversation_id: hub },
      });
    } finally {
      await client.close();
    }

    await nativeWindowShot(page, test.info().outputPath('native-display.png'));
    await page.getByLabel('Viewport width', { exact: true }).fill('1280');
    await page.getByLabel('Viewport height', { exact: true }).fill('800');
    await page.getByRole('button', { name: 'Apply viewport', exact: true }).click();
    const before = (await evaluateNative(
      page,
      '({w:window.innerWidth,dpr:window.devicePixelRatio})'
    )) as {
      w: number;
      dpr: number;
    };
    await page.getByRole('button', { name: 'Page zoom', exact: true }).press('ArrowDown');
    await expect(page.getByRole('menu')).toBeVisible();
    for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowDown');
    const zoom125 = page.getByRole('menuitemradio', { name: '125%', exact: true });
    await expect(zoom125).toBeFocused();
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await evaluateNative(page, 'window.innerWidth')) as number)
      .toBeLessThan(before.w);
    if (process.env.LAD_E2E_VISUAL === '1') {
      await page.getByRole('button', { name: 'Preview scale', exact: true }).click();
      await page.getByRole('menuitemradio', { name: '200%', exact: true }).click();
      await page.getByRole('button', { name: /Pan preview/ }).click();
      await expect
        .poll(
          async () =>
            (
              (await page.evaluate(() =>
                window.electron.liveBrowserWorkspaceRead(
                  window.sessionStorage.getItem('lad.browser.hubId')!
                )
              )) as unknown as { mode: string }
            ).mode
        )
        .toBe('pan');
      const stage = (await page.getByTestId('live-browser-surface').boundingBox())!;
      const scroll = await evaluateNative(page, 'window.scrollY');
      await nativePointer(page, [{ x: stage.x + 100, y: stage.y + 100 }], 5);
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(() =>
                window.electron.liveBrowserWorkspaceRead(
                  window.sessionStorage.getItem('lad.browser.hubId')!
                )
              )
            )?.pan?.y ?? 0
        )
        .toBeGreaterThan(0);
      expect(await evaluateNative(page, 'window.scrollY')).toBe(scroll);
      const panBefore =
        (
          await page.evaluate(() =>
            window.electron.liveBrowserWorkspaceRead(
              window.sessionStorage.getItem('lad.browser.hubId')!
            )
          )
        )?.pan?.y ?? 0;
      await nativePointer(
        page,
        Array.from({ length: 11 }, (_, i) => ({ x: stage.x + 100, y: stage.y + 150 - i * 6 }))
      );
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(() =>
                window.electron.liveBrowserWorkspaceRead(
                  window.sessionStorage.getItem('lad.browser.hubId')!
                )
              )
            )?.pan?.y ?? 0
        )
        .toBeGreaterThan(panBefore + 10);

      await page.getByRole('button', { name: 'Interact with page', exact: true }).click();
      await nativePointer(page, [{ x: stage.x + 100, y: stage.y + 100 }], 5);
      await expect
        .poll(async () => (await evaluateNative(page, 'window.scrollY')) as number)
        .toBeGreaterThan(Number(scroll));
      const middleBefore =
        (
          await page.evaluate(() =>
            window.electron.liveBrowserWorkspaceRead(
              window.sessionStorage.getItem('lad.browser.hubId')!
            )
          )
        )?.pan?.y ?? 0;
      await nativePointer(
        page,
        Array.from({ length: 11 }, (_, i) => ({ x: stage.x + 100, y: stage.y + 150 - i * 6 })),
        2
      );
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(() =>
                window.electron.liveBrowserWorkspaceRead(
                  window.sessionStorage.getItem('lad.browser.hubId')!
                )
              )
            )?.pan?.y ?? 0
        )
        .toBeGreaterThan(middleBefore + 10);
      await page.getByRole('button', { name: 'Reset preview', exact: true }).click();
      await evaluateNative(page, 'window.scrollTo(0,0)');
    }
    await page.getByTestId('live-browser-display').click();
    await page.getByTestId('live-browser-new-area').click();
    await expect
      .poll(() => evaluateNative(page, 'Boolean(document.getElementById("__lad-selection"))'))
      .toBe(true);
    await page.evaluate(async () => {
      await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Input.dispatchMouseEvent',
        {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          x: 35,
          y: 100,
        }
      );
      await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Input.dispatchMouseEvent',
        {
          type: 'mouseMoved',
          buttons: 1,
          x: 260,
          y: 270,
        }
      );
      await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          x: 260,
          y: 270,
        }
      );
    });
    await expect(page.getByTestId('live-browser-area-row')).toHaveCount(1);
    await expect
      .poll(() =>
        evaluateNative(page, 'document.getElementById("__lad-live-regions")?.dataset.visibleRegionCount')
      )
      .toBe('1');
    await nativeWindowShot(page, test.info().outputPath('native-manual-region.png'));
    await resizeNativeWindow(page, 2560, 1300);
    await nativeWindowShot(page, test.info().outputPath('native-wide.png'));
    await page.getByTestId('live-browser-mode-expanded').click();
    await nativeWindowShot(page, test.info().outputPath('native-expanded.png'));
    await page.getByTestId('live-browser-mode-split').click();
    await resizeNativeWindow(page, 940, 800);
    await expect(page.getByTestId('live-browser-panel')).toBeVisible();
    const narrowBounds = (await page.getByTestId('live-browser-panel').boundingBox())!;
    expect(narrowBounds.x + narrowBounds.width).toBeLessThanOrEqual(941);
    await nativeWindowShot(page, test.info().outputPath('native-narrow.png'));
    await resizeNativeWindow(page, 1600, 1000);
    await page.getByRole('button', { name: 'Find layout candidates', exact: true }).click();
    const candidates = page.getByTestId('live-browser-finding');
    // Each numbered row represents an element. Multiple measured facts about
    // one element are grouped together instead of looking like duplicate hits.
    await expect(candidates).toHaveCount(3, { timeout: 30000 });
    const detectedState = await nativeRegionState(page, hub);
    const detectedAreaIds = new Set(
      detectedState.areas.filter((area) => area.origin === 'detected').map((area) => area.id)
    );
    const detectedRegions = detectedState.regions.filter((region) =>
      detectedAreaIds.has(region.areaId)
    );
    expect(detectedRegions).toHaveLength(3);
    await expect(page.getByTestId('live-browser-all-findings')).toBeVisible();
    const areaRows = page.getByTestId('live-browser-area-row');
    const areaCountBeforeRepeat = await areaRows.count();
    await areaRows.first().hover();
    await expect
      .poll(() => evaluateNative(page, 'document.getElementById("__lad-live-regions")?.dataset.hoveredAreaId'))
      .not.toBe('');
    await areaRows.first().click();
    await expect
      .poll(() => evaluateNative(page, 'document.getElementById("__lad-live-regions")?.dataset.selectedAreaId'))
      .not.toBe('');
    await page.getByRole('button', { name: 'Find layout candidates', exact: true }).click();
    await expect(areaRows).toHaveCount(areaCountBeforeRepeat);
    await expect
      .poll(() =>
        evaluateNative(page, 'document.getElementById("__lad-live-regions")?.dataset.visibleRegionCount')
      )
      .toBe('4');
    await candidates.first().click();
    await nativeWindowShot(page, test.info().outputPath('native-findings-marked.png'));
    const currentFindingRegion = () =>
      nativeRegionState(page, hub).then((state) =>
        state.regions.find(
          (region) =>
            state.areas.some((area) => area.id === region.areaId && area.origin === 'detected') &&
            region.anchors.some((anchor) =>
              (anchor.findings ?? []).some(
                (finding) => finding.candidate && finding.state === 'current'
              )
            )
        )
      );
    await expect.poll(currentFindingRegion, { timeout: 10000 }).toBeTruthy();
    const detected = (await currentFindingRegion())!;
    const staleSelector = detected!.anchors.find((anchor) =>
      (anchor.findings ?? []).some((finding) => finding.candidate)
    )!.selector;
    await evaluateNative(
      page,
      `document.querySelector(${JSON.stringify(staleSelector)})?.remove()`
    );
    await expect
      .poll(
        async () => {
          const state = await nativeRegionState(page, hub);
          return state.regions
            .find((region) => region.id === detected.id)
            ?.anchors.flatMap((anchor) => anchor.findings ?? [])
            .some((finding) => finding.candidate && finding.state === 'stale');
        },
        { timeout: 10000 }
      )
      .toBe(true);
    await expect(page.getByTestId('live-browser-all-findings')).toContainText('No longer detected');
    await nativeWindowShot(page, test.info().outputPath('native-findings-stale.png'));
    await page.getByTestId('live-browser-delete-all').click();
    await expect(page.getByRole('alertdialog')).toContainText('this chat only');
    await page.getByTestId('live-browser-delete-all-confirm').click();
    await expect(page.getByTestId('live-browser-area-row')).toHaveCount(0);
    await expect(page.getByTestId('live-browser-all-findings')).toHaveCount(0);
    await expect
      .poll(() =>
        evaluateNative(page, 'document.getElementById("__lad-live-regions")?.dataset.regionCount')
      )
      .toBeUndefined();
    await page.getByTestId('live-browser-empty-select').click();
    await expect
      .poll(() => evaluateNative(page, 'Boolean(document.getElementById("__lad-selection"))'))
      .toBe(true);
    await page.evaluate(async () => {
      const hub = window.sessionStorage.getItem('lad.browser.hubId')!;
      await window.electron.liveBrowserNativeTest(hub, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        x: 35,
        y: 100,
      });
      await window.electron.liveBrowserNativeTest(hub, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        buttons: 1,
        x: 260,
        y: 270,
      });
      await window.electron.liveBrowserNativeTest(hub, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        x: 260,
        y: 270,
      });
    });
    await expect(page.getByTestId('live-browser-area-row')).toHaveCount(1);
    await expect
      .poll(() =>
        evaluateNative(page, 'document.getElementById("__lad-live-regions")?.dataset.visibleRegionCount')
      )
      .toBe('1');
    await page.getByRole('button', { name: 'Interact with page', exact: true }).click();

    const area = page.getByTestId('live-browser-area');
    await expect(area).toBeVisible({ timeout: 30000 });
    await nativeWindowShot(page, test.info().outputPath('native-selected.png'));
    await area.getByTestId('live-browser-area-send').click();
    await expect(page.getByTestId('pending-selection-note')).toContainText('Area');
    await expect(page.getByTestId('chat-input')).not.toContainText('conversation_id');
    await page.getByTestId('live-browser-tools-toggle').click();
    await expect(area).not.toBeVisible();
    // The actual runtime child belongs to this isolated profile; Chromium stays in Electron.
    const status = await page.evaluate(() => window.electron.liveBrowserStatus());
    const survivor = new Client({ name: 'surviving-mcp-connection', version: '1' });
    await survivor.connect(
      new StreamableHTTPClientTransport(new URL(status.endpoint!.url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${status.endpoint!.token}` } },
      })
    );

    const environment = readFileSync(`/proc/${status.pid}/environ`, 'utf8');
    expect(
      environment.split('\0').some((v) => v.startsWith('LOCAL_AI_DESKTOP_DEV_ROOT=/tmp/lad-e2e-'))
    ).toBe(true);
    process.kill(status.pid!, 'SIGKILL');
    await expect
      .poll(
        async () => {
          const current = await page.evaluate(() => window.electron.liveBrowserStatus());
          return current.running && current.pid !== status.pid;
        },
        { timeout: 30000 }
      )
      .toBe(true);
    await expect
      .poll(() => evaluateNative(page, 'document.querySelector("#name").value'))
      .toBe('Продукт 日本語');
    try {
      const reply = await survivor.callTool({
        name: 'browser_read',
        arguments: { conversation_id: hub },
      });
      expect(reply.isError).not.toBe(true);
      expect(JSON.stringify(reply.content)).toContain('Products');
    } finally {
      await survivor.close();
    }
    expect((await page.evaluate(() => window.electron.liveBrowserStatus())).endpoint?.url).toBe(
      status.endpoint!.url
    );

    await page.getByTestId('live-browser-mode-close').click();
    const hiddenEndpoint = (await page.evaluate(() => window.electron.liveBrowserStatus()))
      .endpoint!;
    const hiddenClient = new Client({ name: 'hidden-workspace-qa', version: '1' });
    await hiddenClient.connect(
      new StreamableHTTPClientTransport(new URL(hiddenEndpoint.url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${hiddenEndpoint.token}` } },
      })
    );
    try {
      const change = await hiddenClient.callTool({
        name: 'browser_set_viewport',
        arguments: { conversation_id: hub, width: 960, height: 700, zoom: 1 },
      });
      expect(change.isError).not.toBe(true);
      await expect.poll(() => evaluateNative(page, 'window.innerWidth')).toBe(960);
      const state = await hiddenClient.callTool({
        name: 'browser_state',
        arguments: { conversation_id: hub },
      });
      expect(state.isError).not.toBe(true);
      expect(JSON.stringify(state.content)).toContain('visible: false');
      await fetch(
        hiddenEndpoint.url + `/control/workspace?conversation=${encodeURIComponent(hub)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hiddenEndpoint.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ workspace: { vision: 'on' } }),
        }
      );
      const shot = await hiddenClient.callTool({
        name: 'browser_screenshot',
        arguments: { conversation_id: hub },
      });
      const image = (shot.content as { type: string; mimeType?: string; data?: string }[]).find(
        (c) => c.type === 'image'
      );
      expect(image?.mimeType).toBe('image/jpeg');
      expect((image?.data?.length ?? 0) > 100).toBe(true);
      await evaluateNative(page, "document.body.style.background='#fce8d5'");
      const changed = await hiddenClient.callTool({
        name: 'browser_screenshot',
        arguments: { conversation_id: hub },
      });
      const next = (changed.content as { type: string; data?: string }[]).find(
        (c) => c.type === 'image'
      );
      expect((next?.data?.length ?? 0) > 100).toBe(true);
      expect(
        createHash('sha256')
          .update(next?.data ?? '')
          .digest('hex')
      ).not.toBe(
        createHash('sha256')
          .update(image?.data ?? '')
          .digest('hex')
      );
      await fetch(
        hiddenEndpoint.url + `/control/workspace?conversation=${encodeURIComponent(hub)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hiddenEndpoint.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ workspace: { vision: 'off' } }),
        }
      );
      await hiddenClient.callTool({
        name: 'browser_release_input',
        arguments: { conversation_id: hub },
      });
    } finally {
      await hiddenClient.close();
    }
    await page.getByTestId('browser-toggle').click();
    await expect(page.getByTestId('live-browser-display')).toContainText('960 × 700');

    await expect.poll(() => evaluateNative(page, 'document.title')).toBe('Browser 2 QA');
    await expect(page.locator('.lb2-footer')).toContainText('Native Chromium');
    await expect(page.getByTestId('live-browser-url-input')).toHaveValue(url + '/');
    // Selection must bind to the replacement Playwright client as well.
    await page.getByTestId('live-browser-new-area').click();
    await expect
      .poll(() => evaluateNative(page, 'Boolean(document.getElementById("__lad-selection"))'))
      .toBe(true);
    await page.evaluate(async () => {
      for (const event of [
        { type: 'mousePressed', button: 'left', clickCount: 1, x: 40, y: 105 },
        { type: 'mouseMoved', buttons: 1, x: 200, y: 200 },
        { type: 'mouseReleased', button: 'left', clickCount: 1, x: 200, y: 200 },
      ])
        await window.electron.liveBrowserNativeTest(
          window.sessionStorage.getItem('lad.browser.hubId')!,
          'Input.dispatchMouseEvent',
          event
        );
    });
    await expect(page.getByTestId('live-browser-area-row')).toHaveCount(2);
    await page.getByTestId('live-browser-tools-toggle').click();

    const soakSeconds = Math.min(180, Number(process.env.LAD_E2E_SOAK_SECONDS) || 0);
    if (soakSeconds > 0) {
      const endpoint = (await page.evaluate(() => window.electron.liveBrowserStatus())).endpoint!;
      const samples: unknown[] = [];
      const stats = () =>
        page.evaluate((hub) => window.electron.liveBrowserNativeTest(hub, 'LAD.stats', {}), hub);
      const initial = (await stats()) as { pages: number; pending: number; shields: number };
      const deadline = Date.now() + soakSeconds * 1000;
      let cycles = 0;
      while (Date.now() < deadline) {
        const id = `soak-${cycles}`;
        await page.evaluate((id) => window.electron.liveBrowserRegister(id), id);
        const response = await fetch(`${endpoint.url}/control/navigate?conversation=${id}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ action: 'open', url }),
        });
        expect(response.ok).toBe(true);
        const closed = await fetch(`${endpoint.url}/control/session/close?conversation=${id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${endpoint.token}` },
        });
        expect(closed.ok).toBe(true);
        const sample = (await stats()) as typeof initial;
        expect(sample.pages).toBe(initial.pages);
        expect(sample.pending).toBe(0);
        expect(sample.shields).toBe(initial.shields);
        samples.push(sample);
        cycles++;
        await page.waitForTimeout(1000);
      }
      console.log(
        `SOAK: ${cycles} open/close cycles over ${soakSeconds}s; native page/shield counts stable`
      );
      writeFileSync(
        test.info().outputPath('resource-soak.json'),
        JSON.stringify({ seconds: soakSeconds, cycles, initial, samples })
      );
      await test.info().attach('resource-soak', {
        body: JSON.stringify({ seconds: soakSeconds, cycles, initial, samples }),
        contentType: 'application/json',
      });
    }

    // Crash only the native page renderer of this isolated test application.
    await page.evaluate(
      (hub) =>
        Promise.race([
          window.electron.liveBrowserNativeTest(hub, 'Page.crash', {}).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]),
      hub
    );
    await expect
      .poll(() => evaluateNative(page, 'document.title').catch(() => ''), { timeout: 30000 })
      .toBe('Browser 2 QA');
    expect(await evaluateNative(page, 'document.cookie')).toContain('qa_scope=hub');
    expect(await evaluateNative(page, 'localStorage.getItem("qa_scope")')).toBe('hub');
    await expect(page.getByTestId('live-browser-url-input')).toHaveValue(url + '/');

    // A successful operation after Chromium recovery should clear its transient
    // connection error before continuing with normal browser actions.
    await page.getByTestId('live-browser-reload').click();
    await expect(page.getByRole('alert')).not.toBeVisible();
    await expect
      .poll(() =>
        evaluateNative(
          page,
          '(()=>{const h=document.getElementById("__lad-live-regions");return {regions:h?.dataset.regionCount,visible:h?.dataset.visibleRegionCount,stale:h?.dataset.staleRegionCount}})()'
        )
      )
      .toEqual({ regions: '2', visible: '1', stale: '1' });
    await page.getByTestId('live-browser-url-input').fill('file:///not-allowed');
    await page.getByTestId('live-browser-open').click();
    await expect(page.getByRole('alert')).toContainText('protocol-not-allowed');
    await nativeWindowShot(page, test.info().outputPath('native-error.png'));
    await page.getByTestId('live-browser-url-input').fill(url);
    await page.getByTestId('live-browser-open').click();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
