import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resizeNativeWindow } from './native-window-shot';
/** Protocol E2E with an explicit fixture provider. This is NOT a Qwen test. */
import { test, expect } from './fixtures';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
process.env.LAD_E2E_ISOLATE = '1';
let provider: Server, vite: ViteDevServer, root: string, url: string;
const requests: unknown[] = [];
test.beforeAll(async () => {
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
  await page.getByTestId('live-browser-area-send').click();
  await expect(page.getByTestId('pending-selection-note')).toBeVisible();
  // Narrow layouts intentionally prioritize the browser; hide it to compose.
  await page.getByTestId('live-browser-mode-close').click();
  await page.getByTestId('chat-input').fill('Исправь это');
  await page.getByTestId('chat-input').press('Enter');
  await expect.poll(() => JSON.stringify(requests), { timeout: 60000 }).toContain('DOM');
  const sent = JSON.stringify(requests);
  expect(sent).toContain(root);
  expect(sent).toContain('explicit-directory-selection');
  expect(sent).toContain('Region');
  expect(sent).toContain('product');
  await expect(page.getByText('Context accepted by fixture provider.').first()).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByTestId('browser-message-attachments').filter({ hasText: 'Area' }).first()
  ).toBeVisible();
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
  expect(JSON.stringify(modelUser)).not.toContain('lad-browser-attachment:v1:');
  expect(JSON.stringify(modelUser)).not.toContain('image_url');
  // Editing/resending truncates the conversation, then resolves the durable attachment ID.
  const count = requests.length;
  await page.getByRole('button', { name: 'Edit message: Исправь это', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Edit message content' })
    .fill('Исправь это, сохранив остальную страницу');
  await page.getByRole('button', { name: 'Edit message in place', exact: true }).click();
  await expect.poll(() => requests.length, { timeout: 60000 }).toBeGreaterThan(count);
  const retry = JSON.stringify(requests.slice(count));
  expect(retry).toContain(root);
  expect(retry).toContain('product');
  expect(retry).not.toContain('lad-browser-attachment:v1:');
  await expect(page.locator('.user-message-bubble').last()).toHaveText(
    'Исправь это, сохранив остальную страницу'
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
