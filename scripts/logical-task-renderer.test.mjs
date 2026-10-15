// Production renderer with a disposable IPC fixture. SQLite/restart/ownership
// are exercised independently by logical-task.test and stop-history.test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve('dist/renderer');
const server = createServer(async (req, res) => {
  const file = resolve(root, `.${req.url === '/' ? '/index.html' : req.url}`);
  if (!file.startsWith(`${root}/`)) return res.writeHead(403).end();
  try { res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream'); res.end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
server.requestTimeout = 10000;
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
const deadline = setTimeout(() => { console.error('Task renderer test deadline exceeded'); process.exitCode = 1; void browser?.close(); server.closeAllConnections(); server.close(); }, 90000);
try {
  browser = await chromium.launch({ executablePath: process.env.LOCAL_AI_TEST_BROWSER ?? '/usr/bin/google-chrome', headless: true, timeout: 15000 });
  const page = await browser.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error('renderer fixture:', e.message); });
  await page.addInitScript(() => {
    const chat = { id: 'tasks', title: 'Tasks fixture', mode: 'agent', modelId: 'fixture', contextWindow: 32768, reasoningMode: 'fast', workingDirectory: null };
    const copy = value => structuredClone(value);
    let messages = [], runs = [], listener, languageListener, request, resolveSend, plan, sequence = 0;
    const emit = event => listener({ ...event, conversationId: chat.id, generationId: request.generationId });
    window.taskFixture = {
      language: () => languageListener('ru'),
      request: () => copy(request),
      memory: (text, planless = false) => {
        plan = { logicalTaskId: request.taskId, milestones: [], taskMemory: { entries: [], plan: { steps: planless ? [] : [{ id: 'p1', text, status: 'completed' }] }, deliverables: { items: planless ? [...Array.from({ length: 4 }, (_, index) => ({ id: 'd' + index, text: text + ' deliverable ' + index, status: 'verified' })), { id: 'withdrawn', text: 'Withdrawn item', status: 'dropped' }] : [{ id: 'd1', text: text + ' deliverable', status: 'verified' }] } } };
        emit({ type: 'task-memory', memory: copy(plan.taskMemory) });
      },
      finish: (stop = false) => {
        const current = runs.at(-1); current.status = stop ? 'cancelled' : 'completed'; current.taskPlan = copy(plan); current.completedAt = new Date().toISOString();
        let assistant;
        if (!stop) {
          assistant = { id: 'assistant-' + sequence, conversationId: chat.id, role: 'assistant', logicalTaskId: request.taskId, content: 'Finished task ' + sequence, taskPlan: copy(plan), createdAt: new Date().toISOString() };
          current.assistantMessageId = assistant.id; messages.push(assistant);
        }
        emit({ type: 'analysis-run', run: copy(current) }); emit(stop ? { type: 'cancelled' } : { type: 'done', assistant: copy(assistant) }); resolveSend();
      },
    };
    window.localAi = {
      conversations: { list: async () => [chat], update: async (_, patch) => Object.assign(chat, patch) },
      messages: { list: async () => copy(messages), regenerate: async id => {
        const index = messages.findIndex(message => message.id === id);
        const dropped = messages.slice(index + 1).map(message => message.id);
        for (const run of runs) if (dropped.includes(run.assistantMessageId) || run.triggeringMessageId === id) { run.archived = true; run.partialOutput = messages.find(message => message.id === run.assistantMessageId)?.content; }
        messages = messages.slice(0, index + 1); return copy(messages);
      } },
      agentTasks: { list: async () => [...new Set([...runs].reverse().map(run => run.logicalTaskId))].map(id => ({ logicalTaskId: id, title: messages.find(message => message.role === 'user' && message.logicalTaskId === id)?.content ?? 'Archived task', projects: [{ path: id === 'task-1' ? '/tmp/task-a-test' : '/tmp/task-b-test', id: id === 'task-1' ? 'project-a' : 'project-b' }], updatedAt: '' })) }, analysis: { list: async () => copy(runs) }, agentPlans: { get: async () => null, legacy: async () => null },
      models: { list: async () => [{ id: 'fixture', name: 'Fixture', shortName: 'Fixture', installed: true, maxContext: 262144, supportedContextPresets: [32768], reasoning: { thinkingToggle: true, efforts: [] } }] },
      settings: { get: async () => ({ llamaRuntime: { status: 'ready', modelId: 'fixture', contextWindow: 32768 } }), onLanguageChanged: fn => { languageListener = fn; return () => {}; } },
      hardware: { get: async () => null }, contextEstimate: async () => ({ unknownReasons: [] }), contextDiscoveryStatus: async () => ({ busy: false }),
      chat: { permissions: async () => ({ mode: 'absolute_autopilot', trusted_roots: [] }), grants: async () => [], onDiagramValidation: () => () => {}, onStream: fn => { listener = fn; return () => {}; }, stop: async () => window.taskFixture.finish(true), send: input => {
        sequence += 1; request = copy(input);
        const last = request.messages.at(-1);
        request.taskId = request.continueLogicalTaskId ?? (!request.persistUserMessage ? messages.find(message => message.id === last.id)?.logicalTaskId : undefined) ?? 'task-' + sequence;
        if (request.persistUserMessage) messages.push({ ...copy(last), logicalTaskId: request.taskId });
        runs.push({ id: 'run-' + sequence, generationId: request.generationId, logicalTaskId: request.taskId, triggeringMessageId: last.id, conversationId: chat.id, assistantMessageId: null, reasoningMode: 'fast', status: 'running', actions: [], actionCount: 0, createdAt: new Date().toISOString(), completedAt: null });
        return new Promise(done => { resolveSend = done; emit({ type: 'analysis-run', run: copy(runs.at(-1)) }); });
      } },
    };
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url); await page.waitForSelector('.composer textarea'); await page.evaluate(() => window.taskFixture.language());
  const send = async text => { await page.locator('.composer textarea').fill(text); await page.locator('.composer textarea').press('Enter'); await page.waitForFunction(text => window.taskFixture.request()?.messages.at(-1).content === text, text); };
  await send('Independent A'); await page.evaluate(() => window.taskFixture.memory('Plan A', true));
  await page.waitForSelector('.composer-wrap .agent-status-panel');
  await page.evaluate(() => window.taskFixture.finish());
  await page.waitForSelector('.task-history-card'); assert.match(await page.locator('.task-history-card > button').first().innerText(), /Проверено результатов: 4\/4/); assert.doesNotMatch(await page.locator('.task-history-card > button').first().innerText(), /0\/|Шаги плана/); assert.equal(await page.locator('.composer-wrap .agent-status-panel').count(), 0);
  await page.locator('.task-history-card > button').first().click(); assert.match(await page.locator('.task-history-card').innerText(), /Plan A deliverable/);
  await send('Independent B'); const second = await page.evaluate(() => window.taskFixture.request()); assert.equal(second.continueLogicalTaskId, undefined);
  assert.equal(await page.locator('.composer-wrap .agent-status-panel').count(), 0, 'new task must not show old plan during startup');
  await page.evaluate(() => window.taskFixture.memory('Plan B')); assert.match(await page.locator('.task-history-card').innerText(), /Plan A deliverable/);
  await page.evaluate(() => window.taskFixture.finish()); await page.waitForFunction(() => document.querySelectorAll('.task-history-card').length === 2);
  assert.match(await page.locator('.task-history-card').nth(1).locator('button').first().innerText(), /Шаги плана: 1\/1.*Проверено результатов: 1\/1/);
  await page.locator('.task-history-card').first().getByRole('button', { name: 'Продолжить эту задачу', exact: true }).click();
  await page.locator('.task-selector-project').getByText('/tmp/task-a-test', { exact: true }).waitFor();
  assert.match(await page.locator('.task-selector').innerText(), /Следующее сообщение: продолжение задачи/);
  const selector = page.getByRole('combobox', { name: 'Выбрать задачу', exact: true });
  assert.equal(await selector.inputValue(), 'task-1');
  await page.locator('.task-selector').getByRole('button', { name: 'Новая задача', exact: true }).click();
  assert.equal(await selector.inputValue(), '');
  assert.match(await page.locator('.task-selector').innerText(), /Следующее сообщение: новая задача/);
  await page.locator('.conversation').evaluate(node => { node.scrollTop = 0; });
  await selector.selectOption('task-1');
  assert.equal(await selector.inputValue(), 'task-1');
  assert.match(await page.locator('.task-selector-project').innerText(), /task-a-test/);
  await send('Continue A'); assert.equal((await page.evaluate(() => window.taskFixture.request())).continueLogicalTaskId, 'task-1');
  await page.evaluate(() => window.taskFixture.memory('Continued A')); await page.evaluate(() => window.taskFixture.finish(true));
  await page.waitForFunction(() => document.querySelectorAll('.task-history-card').length === 3); assert.equal(await page.locator('.composer-wrap .agent-status-panel').count(), 0);
  assert.match(await page.locator('.task-history-card').first().innerText(), /Plan A deliverable/, 'Stop/continuation did not rewrite previous history');
  assert.match(await page.locator('.task-history-card > button').first().innerText(), /Проверено результатов: 4\/4/, 'historical counters still describe the original frozen snapshot');
  await page.locator('.task-history-card').last().getByRole('button', { name: 'Продолжить эту задачу', exact: true }).click();
  await send('Resume A'); assert.equal((await page.evaluate(() => window.taskFixture.request())).continueLogicalTaskId, 'task-1');
  await page.evaluate(() => window.taskFixture.memory('Resumed A')); await page.evaluate(() => window.taskFixture.finish());
  await page.waitForFunction(() => document.querySelectorAll('.task-history-card').length === 4);
  await page.locator('.user-message-stack').last().getByRole('button', { name: 'Сгенерировать ответ заново', exact: true }).click();
  await page.waitForFunction(() => window.taskFixture.request()?.persistUserMessage === false);
  assert.equal((await page.evaluate(() => window.taskFixture.request())).taskId, 'task-1');
  assert.equal(await page.locator('.task-history-card').count(), 4, 'Regenerate keeps old snapshots rendered');
  assert.match(await page.locator('.task-history-card').last().innerText(), /Предыдущая попытка/);
  await page.evaluate(() => window.taskFixture.memory('Regenerated A')); await page.evaluate(() => window.taskFixture.finish());
  await page.waitForFunction(() => document.querySelectorAll('.task-history-card').length === 5);
  assert.equal(await page.locator('.composer-wrap .agent-status-panel').count(), 0);
  assert.deepEqual(errors, []);
  console.log('production renderer: active-only panel / immutable history cards / independent Send / explicit Continue / Stop-resume / archived Regenerate passed');
} finally { clearTimeout(deadline); await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
