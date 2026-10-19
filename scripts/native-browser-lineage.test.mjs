// Scripted provider, real Electron fixture/Rust. Tests the history sent by the Qwen harness.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rename, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';
const root = await mkdtemp('/tmp/lad-native-lineage-'), project = await mkdtemp('/tmp/lad-native-lineage-project-');
await writeFile(join(project, 'index.html'), '<title>Persisted native fixture</title>');
const out = resolve('artifacts/native-browser'); await mkdir(out, { recursive: true });
let phase = 'first', turn = 0, app, stopRequested = false;
const frame = (delta, reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
const server = createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (phase === 'stop') { stopRequested = true; res.write(frame({ reasoning_content: 'Waiting for explicit Stop.' }, null)); return; }
  const actions = phase === 'first'
    ? [['read_file', { path: 'index.html' }], ['task_memory', { action: 'record', finding: 'index.html has title Persisted native fixture.', evidence: 'obs-00000001', status: 'confirmed' }]]
    : [['read_file', { path: 'index.html' }], ['task_memory', { action: 'view' }]];
  const action = actions[turn++];
  res.end(action ? frame({ tool_calls: [{ index: 0, id: phase + turn, type: 'function', function: { name: action[0], arguments: JSON.stringify(action[1]) } }] }, 'tool_calls') + 'data: [DONE]\n\n' : frame({ content: 'The actual file was read and its confirmed finding was retained.' }, 'stop') + 'data: [DONE]\n\n');
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const summary = async () => JSON.parse(await readFile(join(root, 'agent-status.json'), 'utf8'));
const finish = async () => { for (let i = 0; i < 600; i++) { if ((await summary()).finished) return JSON.parse(await readFile(join(root, 'agent-result.json'), 'utf8')); await sleep(50); } throw Error('Fixture did not finish'); };
const memoryOf = state => state.events.findLast(e => e.type === 'task-memory')?.memory;
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  app = await _electron.launch({ executablePath: resolve('scripts/electron-unconfined-fixture.sh'), args: [resolve('test-fixtures/native-browser/workspace-main.cjs')], env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root, LOCAL_AI_TEST_PROJECT_ROOT: project } });
  const ui = await app.firstWindow(); await ui.locator('.conversation').waitFor();
  const start = (prompt, memory) => app.evaluate((_e, args) => global.nativeFixture.startRealAgent(args.endpoint, 'qwen3.8:27b-q4_K_M', args.prompt, 32768, args.memory), { endpoint, prompt, memory });
  await start('Read-only: read index.html, record the confirmed finding and finish.');
  const first = await finish(); assert(!first.error, JSON.stringify(first.error)); assert(first.events.some(e => e.type === 'done'));
  const memory = memoryOf(first); assert.equal(memory.entries[0].status, 'confirmed');
  phase = 'stop'; turn = 0;
  await start('Read-only: explain event handling at length without tools.', memory);
  for (let i = 0; !stopRequested && i < 200; i++) await sleep(50);
  assert(stopRequested, JSON.stringify(await summary()));
  await writeFile(join(root, 'native-command.tmp'), JSON.stringify({ id: 'stop-lineage', action: 'stop' }));
  await rename(join(root, 'native-command.tmp'), join(root, 'native-command.json'));
  const stopped = await finish(); assert(!stopped.error); assert(stopped.events.some(e => e.type === 'cancelled'));
  phase = 'afterStop'; turn = 0;
  await start('Continue read-only after Stop. Read the file and inspect Task Memory; finish.', memory);
  const continued = await finish(); assert(!continued.error, JSON.stringify(continued.error)); assert(continued.events.some(e => e.type === 'done'));
  const view = continued.events.find(e => e.type === 'tool' && e.activity.id === 'afterStop2' && e.activity.output);
  assert(view, 'The real Task Memory view must be returned');
  const viewed = JSON.parse(view.activity.output).task_memory;
  assert.deepEqual(viewed.entries, memory.entries, 'View does not emit an update event; inspect its actual result');
  console.log('PASS actual Electron/Rust fixture history: confirmed observation evidence survives completion → next run → Stop → continuation. No Vision/inference claim is made for this scripted provider.');
} finally { await app?.evaluate(async () => global.nativeFixture.close()).catch(() => {}); await app?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
