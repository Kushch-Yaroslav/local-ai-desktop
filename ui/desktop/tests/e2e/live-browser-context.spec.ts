import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resizeNativeWindow, nativeWindowShot } from './native-window-shot';
/** Protocol E2E with an explicit fixture provider. This is NOT a Qwen test. */
import { test, expect } from './fixtures';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
process.env.LAD_E2E_ISOLATE = '1';
let provider: Server, vite: ViteDevServer, root: string, url: string;
const requests: unknown[] = [];
test.beforeAll(async () => {
  // The scripted transport accepts image parts; this tests wire projection, not recognition.
  process.env.LAD_E2E_PROVIDER_VISION = '1';
  root = mkdtempSync(join(tmpdir(), 'lad-react-project-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'visual-fixture', type: 'module' })
  );
  writeFileSync(
    join(root, 'index.html'),
    '<div id="root"></div><script type="module" src="/src/App.tsx"></script>'
  );
  writeFileSync(
    join(root, 'src/App.tsx'),
    `import React from 'react';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<section id="product" style={{margin:32,padding:24,width:160,height:24,overflow:'hidden',background:'#dce9f4'}}>A product name clipped by a reproducible layout defect</section>);`
  );
  symlinkSync(resolve(__dirname, '../../../node_modules'), join(root, 'node_modules'), 'dir');
  vite = await createViteServer({
    root,
    configFile: false,
    cacheDir: join(root, '.vite'),
    server: { host: '127.0.0.1', port: 0 },
    esbuild: { jsx: 'automatic' },
  });
  await vite.listen();
  url = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
  provider = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += String(chunk);
    if (req.url?.includes('/models')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }] }));
      return;
    }
    const body = text ? JSON.parse(text) : {};
    requests.push(body);
    const message = 'Context accepted by fixture provider.';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            choices: [
              { index: 0, delta: { role: 'assistant', content: message }, finish_reason: null },
            ],
          }) +
          '\n\n'
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }) +
          '\n\n'
      );
      res.end('data: [DONE]\n\n');
    } else
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: message }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })
      );
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  process.env.LAD_E2E_PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await vite?.close();
  provider?.closeAllConnections();
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  delete process.env.LAD_E2E_PROVIDER_URL;
  delete process.env.LAD_E2E_PROVIDER_VISION;
});
test('chosen React project and region reach model while history contains a compact attachment', async ({
  goosePage: page,
}) => {
  test.setTimeout(240000);
  await resizeNativeWindow(page, 1700, 1000);
  await page.getByTestId('project-directory-picker').click();
  const path = page.getByPlaceholder('Enter an absolute path (e.g. /home/goose/workspace)');
  await path.fill(root);
  await path.press('Enter');
  await page.getByTestId('browser-toggle').click();
  await page.getByTestId('live-browser-url-input').fill(url);
  await page.getByTestId('live-browser-open').click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const r = (await window.electron.liveBrowserNativeTest(
            window.sessionStorage.getItem('lad.browser.hubId')!,
            'Runtime.evaluate',
            {
              expression: 'Boolean(document.getElementById("product"))',
              returnByValue: true,
            }
          )) as { result: { value: boolean } };
          return r.result.value;
        }),
      { timeout: 30000 }
    )
    .toBe(true);
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
      { type: 'mousePressed', button: 'left', clickCount: 1, x: 34, y: 34 },
      { type: 'mouseMoved', buttons: 1, x: 210, y: 75 },
      { type: 'mouseReleased', button: 'left', clickCount: 1, x: 210, y: 75 },
    ])
      await window.electron.liveBrowserNativeTest(
        window.sessionStorage.getItem('lad.browser.hubId')!,
        'Input.dispatchMouseEvent',
        event
      );
  });
  await page.getByTestId('live-browser-area-desc').fill('The product button needs more padding.');
  await page.getByTestId('live-browser-area-send').click();
  await expect(page.getByTestId('pending-selection-note')).toBeVisible();
  await expect(page.getByTestId('pending-selection-note')).toContainText('Has description');
  // Narrow layouts intentionally prioritize the browser; hide it to compose.
  await page.getByTestId('live-browser-mode-close').click();
  await expect(page.getByTestId('chat-input')).toHaveValue('');
  await page.getByTestId('chat-input').press('Enter');
  await expect.poll(() => JSON.stringify(requests), { timeout: 60000 }).toContain('DOM');
  const sent = JSON.stringify(requests);
  expect(sent).toContain(root);
  expect(sent).toContain('explicit-directory-selection');
  expect(sent).toContain('Region');
  expect(sent).toContain('product');
  expect(sent).toContain('The product button needs more padding.');
  const shapes = (
    requests as { messages?: unknown; tools?: { function?: { name: string } }[] }[]
  ).map((r) => ({
    messageChars: JSON.stringify(r.messages ?? []).length,
    toolChars: JSON.stringify(r.tools ?? []).length,
    tools: (r.tools ?? []).map((t) => t.function?.name),
  }));
  writeFileSync(
    test.info().outputPath('provider-request-shape.json'),
    JSON.stringify(shapes, null, 2)
  );
  if (process.env.LAD_E2E_ASSERT_BROWSER_TOOLS === '1') {
    const tools = shapes.flatMap((r) => r.tools).filter((name): name is string => Boolean(name));
    expect(
      tools.some((name) => name.endsWith('browser_read')),
      JSON.stringify(tools)
    ).toBe(true);
    expect(
      tools.some((name) => name.endsWith('browser_recheck_area')),
      JSON.stringify(tools)
    ).toBe(true);
  }

  await expect(page.getByText('Context accepted by fixture provider.').first()).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByTestId('browser-message-attachments').filter({ hasText: 'Area' }).first()
  ).toBeVisible();
  await expect(page.getByTestId('browser-message-attachments')).toContainText('Has description');
  const history = (await page.locator('[data-testid="message-list"]').count())
    ? page.locator('[data-testid="message-list"]')
    : page.locator('body');
  await expect(history).not.toContainText('[Live Browser conversation_id:');
  await expect(history).not.toContainText('[Local AI Desktop — Live Browser selection]');
  // Provider projection receives model-only evidence, never the visible card encoding.
  const modelUser = (requests as { messages?: { role: string; content: unknown }[] }[])
    .flatMap((r) => r.messages ?? [])
    .filter((m) => m.role === 'user');
  expect(JSON.stringify(modelUser)).toContain(root);
  expect(JSON.stringify(modelUser)).toContain('product');
  expect(JSON.stringify(modelUser)).toContain('The product button needs more padding.');
  expect(JSON.stringify(modelUser)).not.toContain('lad-browser-attachment:v1:');
  expect(JSON.stringify(modelUser)).not.toContain('image_url');
  const firstUserPayload = JSON.stringify(
    (requests[0] as { messages: { role: string; content: unknown }[] }).messages.filter(
      (m) => m.role === 'user'
    )
  );
  expect(firstUserPayload.split('The product button needs more padding.').length - 1).toBe(1);
  // Editing/resending truncates the conversation, then resolves the durable attachment ID.
  const count = requests.length;
  await page
    .getByRole('button', {
      name: 'Edit message: The product button needs more padding.',
      exact: true,
    })
    .click();
  await page
    .getByRole('textbox', { name: 'Edit message content' })
    .fill('Исправь это, сохранив остальную страницу');
  await page.getByRole('button', { name: 'Edit message in place', exact: true }).click();
  await expect.poll(() => requests.length, { timeout: 60000 }).toBeGreaterThan(count);
  await expect
    .poll(() => JSON.stringify(requests.slice(count)), { timeout: 60000 })
    .toContain(root);
  const retry = JSON.stringify(requests.slice(count));
  expect(retry).toContain(root);
  expect(retry).toContain('product');
  expect(retry).toContain('The product button needs more padding.');
  expect(retry).not.toContain('lad-browser-attachment:v1:');
  await expect(page.locator('.user-message-bubble').last()).toHaveText(
    'Исправь это, сохранив остальную страницу'
  );
  // This is a manual fixture edit for ledger testing, never a claim of Qwen repair.
  const id = /Live Browser conversation_id: ([^. ]+)\./.exec(JSON.stringify(requests))![1];
  const endpoint = (await page.evaluate(() => window.electron.liveBrowserStatus())).endpoint!;
  const control = async (path: string, body?: unknown) => {
    const response = await fetch(
      `${endpoint.url}/control/${path}${path.includes('?') ? '&' : '?'}conversation=${encodeURIComponent(id)}`,
      {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      }
    );
    const value = await response.json();
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const currentProductHeight = () =>
    page.evaluate(async (conversationId) => {
      const result = (await window.electron.liveBrowserNativeTest(
        conversationId,
        'Runtime.evaluate',
        {
          expression: 'getComputedStyle(document.querySelector("#product")).height',
          returnByValue: true,
        }
      )) as { result: { value: string } };
      return result.result.value;
    }, id);
  const initial = await control('state'),
    area = initial.areas[0],
    region = initial.regions[0];
  expect(region.projectRoot).toBe(root);
  expect(region.history[0].cropId).toBeTruthy();
  const originalCrop = await control(`evidence?id=${region.history[0].cropId}`);
  expect(originalCrop.evidence.data.length).toBeGreaterThan(200);
  const failed = await control('act', { action: 'recheck', value: area.id });
  expect(failed.record.outcome, JSON.stringify(failed.record)).toBe('Failed');
  expect(failed.record.regions[0].observed).toBeGreaterThan(0);
  const source = readFileSync(join(root, 'src/App.tsx'), 'utf8');
  try {
    writeFileSync(join(root, 'src/App.tsx'), source.replace('height:24', 'height:120'));
    // Wait for Vite's HMR navigation to settle before the verification reload.
    // Navigating during HMR produces ERR_ABORTED even though the page is healthy.
    await expect.poll(currentProductHeight, { timeout: 15000 }).toBe('120px');
    const passed = await control('act', { action: 'recheck', value: area.id });
    expect(passed.record.outcome, JSON.stringify(passed.record)).toBe('Verified');
    expect(passed.record.servedSources).toContain('src/App.tsx');
    const current = await control('state');
    expect(current.areas[0].status).toBe('Verified');
    expect(current.regions[0].id).toBe(region.id);
    expect(current.regions[0].history.length).toBeGreaterThan(2);
    await control('act', { action: 'workflow', value: `${area.id}:completed` });
    expect((await control('state')).areas[0].workflow.state).toBe('completed');
    writeFileSync(join(root, 'src/App.tsx'), source.replace('height:24', 'height:121'));
    await expect.poll(currentProductHeight, { timeout: 15000 }).toBe('121px');
    const stale = await control('state');
    expect(stale.areas[0].status).toBe('Fixed');
    expect(stale.areas[0].verification.reason).toContain('changed');
    writeFileSync(
      test.info().outputPath('verification-ledger.json'),
      JSON.stringify(
        {
          failed: failed.record,
          passed: passed.record,
          stale: stale.areas[0].verification,
          root,
          regionId: region.id,
        },
        null,
        2
      )
    );
  } finally {
    writeFileSync(join(root, 'src/App.tsx'), source);
    await expect.poll(currentProductHeight, { timeout: 15000 }).toBe('24px');
  }
  await page.getByTestId('browser-toggle').click();
  await expect(page.getByTestId('live-browser-panel')).not.toContainText('No project');
  if (!(await page.getByTestId('live-browser-area-row').first().isVisible()))
    await page.getByTestId('live-browser-tools-toggle').click();
  await page.getByTestId('live-browser-area-row').first().click();
  await page.getByText('Evidence & history', { exact: true }).click();
  await page.getByRole('button', { name: 'Reselect', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const r = (await window.electron.liveBrowserNativeTest(id, 'Runtime.evaluate', {
          expression: 'Boolean(document.querySelector("#__lad-selection"))',
          returnByValue: true,
        })) as { result: { value: boolean } };
        return r.result.value;
      }, id)
    )
    .toBe(true);
  await page.evaluate(async (id) => {
    for (const event of [
      { type: 'mousePressed', button: 'left', clickCount: 1, x: 35, y: 35 },
      { type: 'mouseMoved', buttons: 1, x: 190, y: 74 },
      { type: 'mouseReleased', button: 'left', clickCount: 1, x: 190, y: 74 },
    ])
      await window.electron.liveBrowserNativeTest(id, 'Input.dispatchMouseEvent', event);
  }, id);
  await expect
    .poll(async () => {
      const state = await control('state');
      return state.regions[0].history.at(-1).kind;
    })
    .toBe('reselection');
  const reselected = await control('state');
  expect(reselected.regions[0].id).toBe(region.id);
  expect(reselected.regions[0].snapshot).not.toBe(region.snapshot);
  expect(reselected.regions[0].history[0].kind).toBe('selection');
  const historical = page.locator('.lb2-history-capture').first();
  await historical.locator('summary').click();
  await historical.getByRole('button', { name: 'View saved crop', exact: true }).click();
  await expect(historical.locator('img')).toBeVisible();
  await historical.locator('img').scrollIntoViewIfNeeded();
  await nativeWindowShot(page, test.info().outputPath('native-evidence-history.png'));

  writeFileSync(
    test.info().outputPath('reselected-region.json'),
    JSON.stringify(reselected.regions[0], null, 2)
  );
});

test('the first message adopts the existing Page even without an area', async ({
  goosePage: page,
}) => {
  test.setTimeout(120000);
  requests.length = 0;
  await page.getByTestId('browser-toggle').click();
  await page.getByTestId('live-browser-url-input').fill(url);
  await page.getByTestId('live-browser-open').click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const result = (await window.electron.liveBrowserNativeTest(
          window.sessionStorage.getItem('lad.browser.hubId')!,
          'Runtime.evaluate',
          { expression: 'Boolean(document.getElementById("product"))', returnByValue: true }
        )) as { result: { value: boolean } };
        return result.result.value;
      })
    )
    .toBe(true);
  await page.evaluate(() =>
    window.electron.liveBrowserNativeTest(
      window.sessionStorage.getItem('lad.browser.hubId')!,
      'Runtime.evaluate',
      { expression: 'document.getElementById("product").dataset.retained="same-page"' }
    )
  );
  await page.getByTestId('live-browser-mode-close').click();
  await page.getByTestId('chat-input').fill('Что открыто на странице?');
  await page.getByTestId('chat-input').press('Enter');
  await expect.poll(() => JSON.stringify(requests)).toContain('Live Browser conversation_id:');
  const id = /Live Browser conversation_id: ([^. ]+)\./.exec(JSON.stringify(requests))![1];
  const marker = await page.evaluate(async (id) => {
    const result = (await window.electron.liveBrowserNativeTest(id, 'Runtime.evaluate', {
      expression: 'document.getElementById("product")?.dataset.retained',
      returnByValue: true,
    })) as { result: { value: string } };
    return result.result.value;
  }, id);
  expect(marker).toBe('same-page');
  await expect(page.getByTestId('live-browser-panel')).not.toBeVisible();
  const endpoint = (await page.evaluate(() => window.electron.liveBrowserStatus())).endpoint!;
  const client = new Client({ name: 'adopted-page-qa', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
    })
  );
  try {
    const result = await client.callTool({
      name: 'browser_read',
      arguments: { conversation_id: id },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('A product name clipped');
  } finally {
    await client.close();
  }
});

test('Vision Off suppresses historical browser crops on follow-up and retry without deleting cards', async ({
  goosePage: page,
}) => {
  test.setTimeout(180000);
  requests.length = 0;
  await resizeNativeWindow(page, 1700, 1000);
  await page.getByTestId('browser-toggle').click();
  await page.getByTestId('live-browser-url-input').fill(url);
  await page.getByTestId('live-browser-open').click();
  const hub = await page.evaluate(() => window.sessionStorage.getItem('lad.browser.hubId')!);
  await expect
    .poll(() =>
      page.evaluate(async (hub) => {
        const r = (await window.electron.liveBrowserNativeTest(hub, 'Runtime.evaluate', {
          expression: 'Boolean(document.querySelector("#product"))',
          returnByValue: true,
        })) as { result: { value: boolean } };
        return r.result.value;
      }, hub)
    )
    .toBe(true);
  const endpoint = (await page.evaluate(() => window.electron.liveBrowserStatus())).endpoint!;
  const headers = { Authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' };
  await fetch(`${endpoint.url}/control/ground?conversation=${hub}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ rect: { x: 34, y: 34, width: 170, height: 45 } }),
  });
  await page.getByTestId('live-browser-tools-toggle').click();
  await page.getByTestId('live-browser-area-row').first().click();
  await page.getByRole('checkbox', { name: /Vision/ }).click();
  await expect(page.getByRole('checkbox', { name: /Vision/ })).toBeChecked();
  await page.getByTestId('live-browser-area-send').click();
  await expect(page.getByTestId('pending-selection-note')).toContainText('Area');
  await page.getByTestId('live-browser-mode-close').click();
  await page.getByTestId('chat-input').fill('Опиши область');
  await page.getByTestId('chat-input').press('Enter');
  await expect.poll(() => JSON.stringify(requests), { timeout: 60000 }).toContain('image_url');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).not.toBeVisible();
  const id = /Live Browser conversation_id: ([^. ]+)\./.exec(JSON.stringify(requests))![1];
  await fetch(`${endpoint.url}/control/workspace?conversation=${id}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ workspace: { vision: 'off' } }),
  });
  const before = requests.length;
  await page.getByTestId('chat-input').fill('Продолжи без изображения');
  await page.getByTestId('chat-input').press('Enter');
  await expect
    .poll(() => JSON.stringify(requests.slice(before)), { timeout: 60000 })
    .toContain('Продолжи без изображения');
  expect(JSON.stringify(requests.slice(before))).not.toContain('image_url');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).not.toBeVisible();
  await expect(page.getByTestId('browser-message-attachments').first()).toBeVisible();
  const retryFrom = requests.length;
  await page.getByRole('button', { name: 'Edit message: Опиши область', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit message content' }).fill('Опиши область повторно');
  await page.getByRole('button', { name: 'Edit message in place', exact: true }).click();
  await expect
    .poll(() => JSON.stringify(requests.slice(retryFrom)), { timeout: 60000 })
    .toContain('Опиши область повторно');
  expect(JSON.stringify(requests.slice(retryFrom))).not.toContain('image_url');
  await expect(page.getByTestId('browser-message-attachments').first()).toBeVisible();
});
