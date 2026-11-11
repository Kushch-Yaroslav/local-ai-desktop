/** Real-model acceptance. No scripted responses; no model/server is launched here. */
import { test, expect } from './fixtures';
import { discoverLlamaServer, inferenceDiscoveryDiagnostics } from './goose-seed';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { resizeNativeWindow, nativeWindowShot } from './native-window-shot';
process.env.LAD_E2E_ISOLATE = '1';
const shared = discoverLlamaServer();
test.skip(
  !shared && process.env.LAD_E2E_REQUIRE_QWEN !== '1',
  `Real Qwen unavailable: ${inferenceDiscoveryDiagnostics.join('; ')}. Start the usual selected Qwen profile; this test will not load a model.`
);
let root: string, url: string, vite: ViteDevServer, relay: Server;
const requests: unknown[] = [];
const baseline = `import React from 'react';import{createRoot}from'react-dom/client';import './product.css';function Product(){return <main><h1>Catalog</h1><div className="product-card"><h2 id="product-title">A complete product title should always be readable</h2><p>Price: 125</p></div></main>}createRoot(document.getElementById('root')).render(<Product/>);`;
const broken =
  'body{margin:32px;font:16px system-ui}.product-card{padding:20px;border:1px solid #aaa;width:300px}#product-title{font-size:20px;white-space:nowrap;width:110px;overflow:hidden;height:25px;margin:0}';
test.beforeAll(async () => {
  if (!shared) {
    if (process.env.LAD_E2E_REQUIRE_QWEN === '1')
      throw new Error(
        `Resident Qwen unavailable: ${inferenceDiscoveryDiagnostics.join('; ')}. Load the usual selected profile; no model was started by this test.`
      );
    return;
  }
  process.env.LAD_E2E_AGENT_MODE = 'auto';
  // Short sequential authorization/readiness probe against the existing resident model.
  const probe = await fetch(shared.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${shared.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: shared.modelAlias,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      max_tokens: 16,
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(60000),
  });
  expect(probe.ok, `Resident Qwen probe HTTP ${probe.status}`).toBe(true);
  await probe.json();
  root = mkdtempSync(join(tmpdir(), 'lad-qwen-fix-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'safe-visual-acceptance', type: 'module' })
  );
  writeFileSync(
    join(root, 'index.html'),
    '<div id="root"></div><script type="module" src="/src/main.tsx"></script>'
  );
  writeFileSync(join(root, 'src/main.tsx'), baseline);
  writeFileSync(join(root, 'src/product.css'), broken);
  writeFileSync(
    join(root, 'AGENTS.md'),
    'This is a disposable visual acceptance project. The product title must be fully readable. Preserve other content. Only edit files in this selected project. Use the browser to inspect the result.'
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
  // Authenticated local pass-through for wire evidence. Model output is never fabricated.
  let previous = Promise.resolve();
  relay = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-only-key') {
      res.writeHead(401).end();
      return;
    }
    let unlock: () => void = () => {};
    const turn = new Promise<void>((done) => (unlock = done)),
      before = previous;
    previous = turn;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      if (req.method === 'POST') requests.push(JSON.parse(data.toString()));
      await before;
      const upstream = await fetch(shared.baseUrl + (req.url ?? '/'), {
        method: req.method,
        headers: { Authorization: `Bearer ${shared.apiKey}`, 'content-type': 'application/json' },
        body: req.method === 'POST' ? data : undefined,
        signal: AbortSignal.timeout(240000),
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    } finally {
      unlock();
    }
  });
  await new Promise<void>((done) => relay.listen(0, '127.0.0.1', done));
  process.env.LAD_E2E_PROVIDER_URL = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  process.env.LAD_E2E_PROVIDER_MODEL = shared.modelAlias;
  if (shared.contextLimit) process.env.LAD_E2E_PROVIDER_CONTEXT = String(shared.contextLimit);
});
test.afterAll(async () => {
  await vite?.close();
  relay?.closeAllConnections();
  relay?.close();
  delete process.env.LAD_E2E_PROVIDER_URL;
  delete process.env.LAD_E2E_PROVIDER_MODEL;
  delete process.env.LAD_E2E_PROVIDER_CONTEXT;
  delete process.env.LAD_E2E_AGENT_MODE;
});
test('real Qwen fixes selected project without receiving the component path', async ({
  goosePage: page,
}) => {
  test.setTimeout(600000);
  try {
    await resizeNativeWindow(page, 1800, 1000);
    await page.getByTestId('project-directory-picker').click();
    const picker = page.getByPlaceholder('Enter an absolute path (e.g. /home/goose/workspace)');
    await picker.fill(root);
    await picker.press('Enter');
    await page.getByTestId('browser-toggle').click();
    await page.getByTestId('live-browser-url-input').fill(url);
    await page.getByTestId('live-browser-open').click();
    const hub = await page.evaluate(() => window.sessionStorage.getItem('lad.browser.hubId')!);
    await expect
      .poll(() =>
        page.evaluate(async (hub) => {
          const r = (await window.electron.liveBrowserNativeTest(hub, 'Runtime.evaluate', {
            expression: 'Boolean(document.querySelector("#product-title"))',
            returnByValue: true,
          })) as { result: { value: boolean } };
          return r.result.value;
        }, hub)
      )
      .toBe(true);
    await page.getByTestId('live-browser-new-area').click();
    await expect
      .poll(() =>
        page.evaluate(async (hub) => {
          const r = (await window.electron.liveBrowserNativeTest(hub, 'Runtime.evaluate', {
            expression: 'Boolean(document.querySelector("#__lad-selection"))',
            returnByValue: true,
          })) as { result: { value: boolean } };
          return r.result.value;
        }, hub)
      )
      .toBe(true);
    await page.evaluate(async (hub) => {
      const r = (await window.electron.liveBrowserNativeTest(hub, 'Runtime.evaluate', {
        expression:
          '(()=>{const r=document.querySelector("#product-title").getBoundingClientRect();return {x:r.x+1,y:r.y+1,w:r.width-2,h:r.height-2}})()',
        returnByValue: true,
      })) as { result: { value: { x: number; y: number; w: number; h: number } } };
      const b = r.result.value;
      for (const event of [
        { type: 'mousePressed', button: 'left', clickCount: 1, x: b.x, y: b.y },
        { type: 'mouseMoved', buttons: 1, x: b.x + b.w, y: b.y + b.h },
        { type: 'mouseReleased', button: 'left', clickCount: 1, x: b.x + b.w, y: b.y + b.h },
      ])
        await window.electron.liveBrowserNativeTest(hub, 'Input.dispatchMouseEvent', event);
    }, hub);
    await page.getByTestId('live-browser-area-send').click();
    await expect(page.getByTestId('pending-selection-note')).toBeVisible();
    await nativeWindowShot(page, test.info().outputPath('qwen-before.png'));
    await page.getByTestId('live-browser-mode-close').click();
    await page.getByTestId('chat-input').fill('Исправь это');
    await page.getByTestId('chat-input').press('Enter');
    await expect.poll(() => JSON.stringify(requests), { timeout: 90000 }).toContain(root);
    expect(JSON.stringify(requests)).toContain('product-title');
    expect(JSON.stringify(requests)).toContain('Region');
    // Actual edits, not a final assistant claim, are the acceptance signal.
    await expect
      .poll(
        () =>
          readFileSync(join(root, 'src/main.tsx'), 'utf8') !== baseline ||
          readFileSync(join(root, 'src/product.css'), 'utf8') !== broken,
        { timeout: 420000, intervals: [1000, 2000, 5000] }
      )
      .toBe(true);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).not.toBeVisible({
      timeout: 180000,
    });
    const id = /Live Browser conversation_id: ([^. ]+)\./.exec(JSON.stringify(requests))![1];
    const endpoint = (await page.evaluate(() => window.electron.liveBrowserStatus())).endpoint!;
    const state = await fetch(`${endpoint.url}/control/state?conversation=${id}`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
    }).then((r) => r.json());
    const check = await fetch(`${endpoint.url}/control/act?conversation=${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'recheck', value: state.areas[0].id }),
    }).then((r) => r.json());
    expect(check.record?.outcome, JSON.stringify(check)).toBe('Verified');
    await expect(page.locator('.user-message-bubble').first()).toHaveText('Исправь это');
    await page.getByTestId('browser-toggle').click();
    await nativeWindowShot(page, test.info().outputPath('qwen-after.png'));
  } finally {
    writeFileSync(
      test.info().outputPath('real-qwen-evidence.json'),
      JSON.stringify(
        {
          requests,
          history: await page
            .locator('body')
            .innerText()
            .catch(() => ''),
          root,
        },
        null,
        2
      )
    );
    await test.info().attach('real-qwen-wire-and-history', {
      body: JSON.stringify(
        {
          requests,
          history: await page
            .locator('body')
            .innerText()
            .catch(() => ''),
          root,
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
  }
});
