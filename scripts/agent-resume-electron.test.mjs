import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron as electron } from 'playwright-core';

// Real Electron/registerIpc/preload/renderer/SQLite/Rust, scripted provider and
// mocked GPU/controller only. Never uses the production DB or llama process.
const root = await mkdtemp(join(tmpdir(), 'agent-resume-electron-'));
let app, page, data, phase = 'pause', call = 0, restartedRequests = [], releaseGeneration, generationStarted;
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'fixture', meta: { n_ctx_train: 262144 } }], default_generation_settings: { n_ctx: 73728 } })); return; }
  const parsed = JSON.parse(body);
  let delta, finish = 'tool_calls';
  const tools = parsed.tools?.map(t => t.function.name) ?? [];
  const lastUser = parsed.messages.findLast(m => m.role === 'user')?.content ?? '';
  const paused = tools.includes('task_memory') && !tools.includes('run_terminal');
  const tool = (name, args) => ({ tool_calls: [{ index: 0, id: `resume-fixture-${call++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (phase === 'generation') {
    if (paused) { delta = { content: 'Paused during generation before starting another tool.' }; finish = 'stop'; }
    else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Fixture thinking before pause.' } }] })}\n\n`);
      generationStarted();
      await new Promise(done => { releaseGeneration = done; });
      delta = tool('run_terminal', { command: 'printf forbidden >> during-generation.txt' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`); return;
    }
  } else if (phase === 'pause') {
    if (paused && call === 2) delta = tool('task_memory', { action: 'record', id: 'checkpoint', finding: 'One authorized action ran; pending action cancelled.', status: 'inferred', next: 'Read action-count.txt without repeating the write.' });
    else if (paused && call === 3) delta = tool('plan', { action: 'set', steps: [{ id: 's1', text: 'Inspect the saved checkpoint', status: 'in_progress' }] });
    else if (paused) { delta = { content: 'Paused with a saved checkpoint.' }; finish = 'stop'; }
    else if (call === 0) delta = tool('run_terminal', { command: 'printf executed >> action-count.txt' });
    else delta = tool('run_terminal', { command: 'printf forbidden >> pending.txt' });
  } else {
    restartedRequests.push(parsed);
    const tail = parsed.messages.slice(parsed.messages.findLastIndex(m => m.role === 'user') + 1);
    if (tail.some(m => m.role === 'tool')) { delta = { content: 'Continued from the checkpoint without repeating the write.' }; finish = 'stop'; }
    else delta = tool('read_file', { path: 'action-count.txt' });
    assert.match(String(lastUser), /continue/i);
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const launch = async () => {
  app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('test-fixtures/agent-reliability/resume-electron-main.cjs')], env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: join(root, 'runtime'), LOCAL_AI_AGENT_FIXTURE_WORKSPACE: join(root, 'workspace'), LOCAL_AI_AGENT_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, LOCAL_AI_LLAMA_CPP_URL: `http://127.0.0.1:${server.address().port}` } });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000); await page.waitForSelector('.composer textarea');
  data = await app.evaluate(() => ({ id: global.resumeFixture.id, workspace: global.resumeFixture.workspace, model: global.resumeFixture.modelId }));
  // Activates the mocked controller, not a real llama-server.
  await page.evaluate(async d => { await window.localAi.conversations.update(d.id, { modelId: d.model }); }, data);
  await page.reload(); await page.waitForSelector('.composer textarea');
};
const runs = () => page.evaluate(id => window.localAi.analysis.list(id), data.id);
const waitFinished = async () => {
  await page.waitForFunction(async id => (await window.localAi.analysis.list(id)).every(r => r.status !== 'running'), data.id);
  await page.waitForFunction(() => !document.querySelector('.composer .pause-button'));
};
try {
  await launch();
  await page.locator('.composer textarea').fill('Execute the checkpoint fixture, then wait for a pause'); await page.locator('.composer textarea').press('Enter');
  await page.waitForSelector('.approval-panel');
  await page.locator('.permission-actions button').first().click();
  await page.waitForFunction(() => document.querySelector('.permission-command pre')?.textContent.includes('pending.txt'));
  const before = await runs(); const oldId = before.at(-1).id;
  await page.locator('.composer .pause-button').click();
  await waitFinished();
  const pausedRun = (await runs()).at(-1);
  assert.equal(pausedRun.status, 'completed'); assert(pausedRun.timeline.some(e => e.kind === 'paused'));
  assert.equal(await readFile(join(data.workspace, 'action-count.txt'), 'utf8'), 'executed');
  assert.equal(await access(join(data.workspace, 'pending.txt')).then(() => true, () => false), false);
  const savedPlan = pausedRun.taskPlan;
  assert(pausedRun.logicalTaskId && savedPlan, 'paused attempt owns an immutable task snapshot');
  assert.equal(await page.evaluate(id => window.localAi.agentPlans.get(id), data.id), null, 'finished attempt leaves no active composer panel');
  assert(savedPlan.taskMemory.entries.some(e => e.id === 'checkpoint'));
  assert.equal(savedPlan.taskMemory.plan.steps[0].text, 'Inspect the saved checkpoint');
  const messages = await page.evaluate(id => window.localAi.messages.list(id), data.id);
  await app.close(); app = undefined;

  phase = 'resume'; await launch();
  assert.deepEqual(await page.evaluate(id => window.localAi.messages.list(id), data.id), messages);
  assert.deepEqual((await runs()).at(-1).taskPlan, savedPlan);
  assert.equal(await page.locator('.approval-panel').count(), 0);
  assert.equal(restartedRequests.length, 0, 'opening a conversation must not execute work');
  assert.equal((await runs()).at(-1).actions.length, pausedRun.actions.length);
  await page.locator('.task-selector select').selectOption(pausedRun.logicalTaskId);
  await page.locator('.composer textarea').fill('Continue the saved checkpoint fixture'); await page.locator('.composer textarea').press('Enter');
  await page.waitForFunction(() => document.body.innerText.includes('Continued from') && document.body.innerText.includes('without repeating the write.'));
  await waitFinished();
  const resumed = (await runs()).at(-1); assert.notEqual(resumed.id, oldId); assert.equal(resumed.status, 'completed');
  assert.equal(resumed.logicalTaskId, pausedRun.logicalTaskId);
  assert.deepEqual((await runs()).find(run => run.id === oldId).taskPlan, savedPlan, 'continuation cannot rewrite the paused historical snapshot');
  assert.equal(await readFile(join(data.workspace, 'action-count.txt'), 'utf8'), 'executed');
  assert.equal(await access(join(data.workspace, 'pending.txt')).then(() => true, () => false), false);
  const restoredContext = restartedRequests[0].messages.map(m => m.content).join('\n');
  assert.match(restoredContext, /One authorized action ran/); assert.match(restoredContext, /Inspect the saved checkpoint/);
  phase = 'generation';
  const generating = new Promise(done => { generationStarted = done; });
  await page.locator('.composer textarea').fill('Pause during model generation fixture'); await page.locator('.composer textarea').press('Enter');
  await generating;
  await page.locator('.composer .pause-button').click();
  await page.waitForFunction(() => document.querySelector('.composer .pause-button')?.disabled);
  releaseGeneration(); await waitFinished();
  assert.equal((await runs()).at(-1).status, 'completed');
  assert.equal(await access(join(data.workspace, 'during-generation.txt')).then(() => true, () => false), false);
  assert.equal(await page.locator('.approval-panel').count(), 0);
  // Crash recovery marks unfinished work interrupted, never completed or rerun.
  await app.evaluate(() => { const f = global.resumeFixture; const run = f.db.createAnalysisRun(f.id, 'fast'); f.db.addAnalysisAction(run.id, { id: 'unfinished', label: 'execution', kind: 'terminal', state: 'running' }); });
  await app.close(); app = undefined; await launch();
  const interrupted = (await runs()).at(-1); assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.actions[0].state, 'error');
  assert.equal(await page.locator('.approval-panel').count(), 0);
  assert.equal(await readFile(join(data.workspace, 'action-count.txt'), 'utf8'), 'executed');
  console.log('Real Electron/preload/IPC/SQLite/Rust: graceful pause, pending approval cancellation, restart, history/plan/memory replay, fresh execution without duplicate action, interrupted-state recovery passed. Scripted provider; no real Qwen or llama startup.');
} catch (error) { console.error('Fixture phase', phase, 'call', call); if (app) console.error(JSON.stringify(await app.evaluate(() => ({ runs: global.resumeFixture.db.listAnalysisRuns(global.resumeFixture.id).map(r => ({status:r.status, actions:r.actions.map(a => ({kind:a.kind,state:a.state,output:a.output?.slice(-400)}))})), messages: global.resumeFixture.db.listMessages(global.resumeFixture.id).map(m => ({role:m.role, content:m.content.slice(-250)})) })), null, 2)); throw error; } finally { if (app) await app.close(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); }
