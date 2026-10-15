// Disposable production-renderer fixture. No model, user database or downloads.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';
const root = resolve('dist/renderer');
const server = createServer(async (req, res) => {
  const path = resolve(root, `.${req.url === '/' ? '/index.html' : req.url}`);
  if (!path.startsWith(`${root}/`)) return res.writeHead(403).end();
  try { res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] ?? 'application/octet-stream'); res.end(await readFile(path)); } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.LOCAL_AI_TEST_BROWSER ?? '/usr/bin/google-chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const chat = { id: 'history', title: 'Long history fixture', mode: 'agent', modelId: 'fixture', contextWindow: 110592 };
    const timeline = [], actions = [];
    for (let i = 0; i < 800; i++) {
      if (i % 2 === 0) timeline.push({ id: `thought-${i}`, kind: 'reasoning', position: i, content: [`Historical thought ${i}`, ('Evidence and analysis of project code. ').repeat(18), '```ts', `const item${i} = { verified: false };`, '```'].join('\n\n') });
      else { actions.push({ id: `action-${i}`, kind: i % 5 === 0 ? 'terminal' : 'file_read', label: 'Read file', detail: `src/file-${i}.ts`, state: 'completed', output: JSON.stringify({ content: ('project source line\n').repeat(300) }) }); timeline.push({ id: `event-${i}`, kind: 'activity', position: i, activityId: `action-${i}` }); }
    }
    const messages = [{ id: 'user', conversationId: chat.id, role: 'user', content: 'Inspect project' }, { id: 'assistant-history', conversationId: chat.id, role: 'assistant', content: 'History retained.', thinkingTimeline: timeline }];
    const run = { id: 'history-run', conversationId: chat.id, assistantMessageId: 'assistant-history', status: 'completed', actionCount: actions.length, actions, timeline };
    window.localAi = {
      conversations: { list: async () => [chat], update: async () => chat }, messages: { list: async () => messages }, analysis: { list: async () => [run] }, agentPlans: { get: async () => null },
      settings: { get: async () => ({ llamaRuntime: { status: 'ready', modelId: 'fixture', contextWindow: 110592 } }), onLanguageChanged: () => () => {} }, hardware: { get: async () => null },
      models: { list: async () => [{ id: 'fixture', name: 'Fixture', installed: true }] }, contextEstimate: async () => ({ unknownReasons: [] }), contextDiscoveryStatus: async () => ({ busy: false }),
      chat: { permissions: async () => ({ mode: 'trusted', trusted_roots: [] }), grants: async () => [], onStream: () => () => {}, onDiagramValidation: () => () => {} },
    };
  });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const start = Date.now(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('.agent-timeline-action'); await page.waitForTimeout(700);
  const renderMs = Date.now() - start;
  const frames = await page.evaluate(async () => {
    const node = document.querySelector('.conversation'); node.scrollTop = 0;
    const times = []; let last = performance.now();
    for (let i = 0; i < 160; i++) { await new Promise(requestAnimationFrame); const now = performance.now(); times.push(now - last); last = now; node.scrollTop = (node.scrollHeight - node.clientHeight) * i / 159; }
    return times.sort((a, b) => a - b);
  });
  // All history remains searchable/selectable in DOM; technical output expands on demand.
  assert.equal(await page.locator('.agent-timeline-action').count(), 400);
  assert(await page.locator('.agent-timeline').textContent().then(t => t.includes('Historical thought 0') && t.includes('Historical thought 798')));
  await page.locator('.agent-timeline-action-head').last().click();
  assert(await page.locator('.agent-timeline-action-body').last().innerText().then(t => t.includes('project source line')));
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const result = { events: 800, cpuThrottle: 4, renderMs, frameP95Ms: +frames[Math.floor(frames.length * .95)].toFixed(1), framesOver50ms: frames.filter(v => v > 50).length, domNodes: metrics.Nodes, heapMiB: +(metrics.JSHeapUsedSize / 1024 ** 2).toFixed(1), taskSeconds: +metrics.TaskDuration.toFixed(2) };
  console.log(JSON.stringify(result));
  if (process.env.LOCAL_AI_PERF_OUTPUT) await writeFile(process.env.LOCAL_AI_PERF_OUTPUT, JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
