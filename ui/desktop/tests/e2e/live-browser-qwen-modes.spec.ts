/** Local AI Desktop: real resident Qwen acceptance. Relay records wire evidence; it never fabricates model output. */
import { test, expect } from './fixtures';
import { discoverLlamaServer } from './goose-seed';
import { resizeNativeWindow, nativeWindowShot } from './native-window-shot';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
process.env.LAD_E2E_ISOLATE = '1';
process.env.LAD_E2E_WITH_DEVELOPER = '1';
const shared = discoverLlamaServer();
test.skip(
  !shared && process.env.LAD_E2E_REQUIRE_QWEN !== '1',
  'Resident Qwen is unavailable; this acceptance test never loads a model.'
);
let root: string, url: string, vite: ViteDevServer, relay: Server;
const readToken = 'RINNOVA_' + randomBytes(6).toString('hex');
const traces: { request: any; text: string; calls: string[]; status: number; complete: boolean }[] =
  [];
function sourceSnapshot() {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.vite', '.git'].includes(name)) continue;
      const path = join(dir, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else
        files[path.slice(root.length + 1)] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
    }
  };
  walk(root);
  return files;
}
test.beforeAll(async () => {
  if (!shared) {
    if (process.env.LAD_E2E_REQUIRE_QWEN === '1')
      throw new Error('Resident Qwen required; this test never starts a model.');
    return;
  }
  root = mkdtempSync(join(tmpdir(), 'lad-qwen-boundaries-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'safe-qwen-boundaries', type: 'module' })
  );
  writeFileSync(join(root, 'README.md'), `BOUNDARY_READ_TOKEN=${readToken}\n`);
  writeFileSync(
    join(root, 'AGENTS.md'),
    'Disposable read-only acceptance project. Do not edit, create, delete, install, or run a dev server. Agent mode may inspect README.md using permitted tools; Chat mode has no tools.'
  );
  writeFileSync(
    join(root, 'index.html'),
    '<div id="root"></div><script type="module" src="/src/App.tsx"></script>'
  );
  writeFileSync(
    join(root, 'src/App.tsx'),
    `import React from 'react';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<main style={{margin:32}}><h2>Rinnova Pro</h2><button id="product" style={{padding:0}}>Product details</button></main>);`
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
  let previous = Promise.resolve();
  relay = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-only-key') {
      res.writeHead(401).end();
      return;
    }
    let unlock = () => {};
    const turn = new Promise<void>((done) => {
        unlock = done;
      }),
      before = previous;
    previous = turn;
    try {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : undefined;
      if (body) body.max_tokens = Math.min(body.max_tokens ?? 2048, 2048);
      const trace = body
        ? { request: body, text: '', calls: [] as string[], status: 0, complete: false }
        : undefined;
      if (trace) traces.push(trace);
      await before;
      const response = await fetch(shared.baseUrl + (req.url ?? '/'), {
        method: req.method,
        headers: { Authorization: `Bearer ${shared.apiKey}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(240000),
      });
      if (trace) trace.status = response.status;
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      });
      let wire = '';
      if (response.body)
        for await (const chunk of response.body) {
          wire += Buffer.from(chunk).toString();
          res.write(chunk);
        }
      if (trace) {
        for (const line of wire.split('\n'))
          if (line.startsWith('data: ') && line !== 'data: [DONE]')
            try {
              const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
              if (delta?.content) trace.text += delta.content;
              for (const call of delta?.tool_calls ?? [])
                if (call.function?.name) trace.calls.push(call.function.name);
            } catch {}
        if (!wire.startsWith('data:'))
          try {
            const msg = JSON.parse(wire).choices?.[0]?.message;
            trace.text = msg?.content ?? '';
            trace.calls = (msg?.tool_calls ?? []).map((c: any) => c.function.name);
          } catch {}
        trace.complete = true;
      }
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
});
for (const mode of ['chat', 'auto'] as const)
  for (const browser of [false, true]) {
    test(`real Qwen ${mode} browser ${browser ? 'on' : 'off'}`, async ({ goosePage: page }) => {
      test.setTimeout(300000);
      const start = traces.length;
      const baseline = readFileSync(join(root, 'src/App.tsx'), 'utf8');
      await resizeNativeWindow(page, 1700, 1000);
      await page.getByRole('button', { name: 'Session settings', exact: true }).first().click();
      await page.locator('#session-agent-mode').selectOption(mode);
      await expect(page.locator('#session-agent-mode')).toHaveValue(mode);
      await page.keyboard.press('Escape');
      await page.getByTestId('project-directory-picker').click();
      const picker = page.getByPlaceholder('Enter an absolute path (e.g. /home/goose/workspace)');
      await picker.fill(root);
      await picker.press('Enter');
      const beforeFiles = sourceSnapshot();
      const question =
        mode === 'chat'
          ? 'Исправь внутренние отступы кнопки в выбранном проекте.'
          : 'Прочитай README.md выбранного проекта и сообщи значение BOUNDARY_READ_TOKEN. Файлы не изменяй.';
      if (browser) {
        await page.getByTestId('browser-toggle').click();
        await page.getByTestId('live-browser-url-input').fill(url);
        await page.getByTestId('live-browser-open').click();
        const hub = await page.evaluate(() => window.sessionStorage.getItem('lad.browser.hubId')!);
        await expect
          .poll(() =>
            page.evaluate(async (id) => {
              const r = (await window.electron.liveBrowserNativeTest(id, 'Runtime.evaluate', {
                expression: 'Boolean(document.getElementById("product"))',
                returnByValue: true,
              })) as { result: { value: boolean } };
              return r.result.value;
            }, hub)
          )
          .toBe(true);
        await page.getByTestId('live-browser-new-area').click();
        await expect
          .poll(() =>
            page.evaluate(async (id) => {
              const r = (await window.electron.liveBrowserNativeTest(id, 'Runtime.evaluate', {
                expression: 'Boolean(document.getElementById("__lad-selection"))',
                returnByValue: true,
              })) as { result: { value: boolean } };
              return r.result.value;
            }, hub)
          )
          .toBe(true);
        await page.evaluate(async (id) => {
          for (const event of [
            { type: 'mousePressed', button: 'left', clickCount: 1, x: 34, y: 90 },
            { type: 'mouseMoved', buttons: 1, x: 210, y: 125 },
            { type: 'mouseReleased', button: 'left', clickCount: 1, x: 210, y: 125 },
          ])
            await window.electron.liveBrowserNativeTest(id, 'Input.dispatchMouseEvent', event);
        }, hub);
        await page.getByTestId('live-browser-area-desc').fill(question);
        await page.getByTestId('live-browser-area-send').click();
        await expect(page.getByTestId('pending-selection-note')).toContainText('Has description');
        await page.getByTestId('live-browser-mode-close').click();
      } else await page.getByTestId('chat-input').fill(question);
      // Legacy ablation uses Enter to bypass the old mouse-only submission bug.
      if (process.env.LAD_E2E_SUBMIT_WITH_ENTER === '1')
        await page.getByTestId('chat-input').press('Enter');
      else await page.getByRole('button', { name: 'Send', exact: true }).click();
      const relevant = () =>
        traces
          .slice(start)
          .filter((t) =>
            JSON.stringify(t.request.messages).includes('Live Browser conversation_id:')
          );
      try {
        await expect
          .poll(
            () => relevant().filter((t) => t.complete && t.text.trim() && !t.calls.length).length,
            { timeout: 240000, intervals: [1000] }
          )
          .toBeGreaterThan(0);
        const calls = relevant().flatMap((t) => t.calls),
          answer = relevant()
            .filter((t) => t.complete && t.text.trim() && !t.calls.length)
            .at(-1)!.text;
        if (mode === 'chat') {
          expect(relevant().every((t) => !(t.request.tools ?? []).length)).toBe(true);
          expect(calls).toHaveLength(0);
          expect(answer).not.toContain('<tool_code>');
          expect(answer).toMatch(
            /не могу|нет доступа|только.{0,15}чат|режим.{0,15}чат|не имею|не могу.{0,40}измен/i
          );
        } else {
          expect(relevant().some((t) => (t.request.tools ?? []).length > 0)).toBe(true);
          expect(calls.length).toBeGreaterThan(0);
          expect(answer).toContain(readToken);
          expect(JSON.stringify(relevant().map((t) => t.request.messages))).toContain(readToken);
        }
        expect(sourceSnapshot()).toEqual(beforeFiles);
        expect(readFileSync(join(root, 'src/App.tsx'), 'utf8')).toBe(baseline);
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(readToken);

        if (mode === 'auto' && browser) {
          await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
          await page.getByRole('button', { name: 'Session settings', exact: true }).first().click();
          await page.locator('#session-agent-mode').selectOption('chat');
          await expect(page.locator('#session-agent-mode')).toHaveValue('chat');
          await page.keyboard.press('Escape');
          const switchStart = traces.length;
          const switchQuestion = 'Теперь исправь CSS кнопки в выбранном проекте.';
          await page.getByTestId('chat-input').fill(switchQuestion);
          await page.getByRole('button', { name: 'Send', exact: true }).click();
          const switched = () =>
            traces
              .slice(switchStart)
              .filter(
                (t) =>
                  JSON.stringify(t.request.messages).includes(switchQuestion) &&
                  JSON.stringify(t.request.messages).includes('Live Browser conversation_id:')
              );
          await expect
            .poll(() => switched().some((t) => t.complete && t.text.trim() && !t.calls.length), {
              timeout: 240000,
            })
            .toBe(true);
          writeFileSync(
            test.info().outputPath('real-qwen-mode-switch.json'),
            JSON.stringify(
              switched().map((t) => ({
                tools: (t.request.tools ?? []).map((x: any) => x.function?.name),
                calls: t.calls,
                text: t.text,
              })),
              null,
              2
            )
          );
          expect(
            switched().every((t) => !(t.request.tools ?? []).length && t.calls.length === 0)
          ).toBe(true);
          const switchAnswer = switched()
            .filter((t) => t.complete && t.text.trim() && !t.calls.length)
            .at(-1)!.text;
          expect(switchAnswer).not.toContain('<tool_code>');
          expect(switchAnswer).toMatch(
            /не могу|нет доступа|только.{0,15}чат|режим.{0,15}чат|не имею/i
          );
          expect(sourceSnapshot()).toEqual(beforeFiles);
        }
      } finally {
        writeFileSync(
          test.info().outputPath('real-qwen-boundaries.json'),
          JSON.stringify(
            {
              mode,
              browser,
              fixture: root,
              traces: relevant().map((t) => ({
                status: t.status,
                complete: t.complete,
                tools: (t.request.tools ?? []).map((x: any) => x.function?.name),
                calls: t.calls,
                text: t.text,
                issuedTools: (t.request.messages ?? []).flatMap((m: any) => m.tool_calls ?? []),
                toolResults: (t.request.messages ?? [])
                  .filter((m: any) => m.role === 'tool')
                  .map((m: any) => ({ tool_call_id: m.tool_call_id, content: m.content })),
              })),
            },
            null,
            2
          )
        );
        await nativeWindowShot(page, test.info().outputPath('real-qwen-window.png'));
      }
    });
  }
