// Production Rust executable + scripted SSE provider. This is NOT a Qwen test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'lad-controls-'));
const project = join(root, 'project'); await mkdir(project); await writeFile(join(project, 'a.txt'), 'original');
let script, requests = [], child;
const events = [], measurements = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
const wait = async (predicate, message, timeout = 8000) => { const start = performance.now(); for (;;) { const value = predicate(); if (value) return value; if (performance.now() - start > timeout) throw Error(`${message}: ${JSON.stringify(events.slice(-5))}`); await delay(5); } };
const frame = (delta, reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
const tools = (res, calls) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(frame({ tool_calls: calls.map(([name, args], index) => ({ index, id: `call-${requests.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); };
const text = res => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(frame({ content: 'Checkpoint results retained.' }) + frame({}, 'stop') + 'data: [DONE]\n\n'); };
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks)); requests.push(payload);
  try { await script(payload, res, requests.length); } catch (error) { console.error(error); res.destroy(error); }
});
const send = payload => child.stdin.write(JSON.stringify(payload) + '\n');
const event = (run, type) => events.findLast(e => e.run_id === run && e.type === type);
const options = effort => ({ fast: { reasoning_effort: effort }, deep: { reasoning_effort: effort }, final: { reasoning_effort: effort } });
const run = (id, user, evidence = id, extra = {}) => {
  child?.stdin.end();
  child = spawn(resolve('rust-agent/target/debug/local-ai-agent-runtime'), [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root } });
  const lines = createInterface({ input: child.stdout }); lines.on('line', line => { try { events.push(JSON.parse(line)); } catch { /* not protocol */ } });
  send({ type: 'run', run_id: id, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: 'scripted-fixture', system: 'Test runtime controls.', user, context_limit: 65536, reasoning_mode: 'deep', reasoning_options: options('xhigh'), supports_reasoning: true, web_mode: 'off', policy: 'auto', project_root: project, evidence_dir: join(root, evidence), permissions: { mode: 'autonomous', trusted_roots: [project] }, ...extra });
};
const pause = async id => {
  const start = performance.now(); send({ type: 'steer', run_id: id, content: 'Pause', intent: 'pause' });
  await wait(() => event(id, 'run_paused'), `Pause ${id}`);
  const elapsedMs = Math.round((performance.now() - start) * 10) / 10;
  assert(elapsedMs < 1200, `${id} took ${elapsedMs}ms`);
  assert(event(id, 'final')); assert(!event(id, 'agent_stopped')); assert(!event(id, 'agent_error'));
  measurements.push({ scenario: id, elapsedMs }); await delay(30);
};
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  for (const kind of ['ordinary', 'reasoning', 'silent', 'partial-chunk']) {
    requests = [];
    script = async (_payload, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
      if (kind === 'ordinary') res.write(frame({ content: 'Partial response' }));
      if (kind === 'reasoning') res.write(frame({ reasoning_content: 'Long reasoning in progress' }));
      if (kind === 'partial-chunk') res.socket.write('1000\r\nunfinished');
    };
    run(kind, 'Inspect the selected project'); await wait(() => requests.length, kind); await delay(80); await pause(kind);
    assert.equal(requests.length, 1, 'no checkpoint generation');
  }
  requests = [];
  script = async (payload, res, n) => {
    if (n === 1) tools(res, [['plan', { action: 'set', steps: ['Edit a.txt', 'Retain results across Resume'] }], ['read_file', { path: 'a.txt' }]]);
    else if (n === 2) tools(res, [['replace_text', { path: 'a.txt', old_text: 'original', new_text: 'changed' }]]);
    else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(frame({ reasoning_content: 'After the edit' })); }
  };
  run('after-edit', 'Edit a.txt and keep the checkpoint', 'lineage');
  await wait(() => requests.length >= 3, 'edit finished'); assert.equal(await readFile(join(project, 'a.txt'), 'utf8'), 'changed');
  await pause('after-edit');
  const checkpoint = event('after-edit', 'task_memory_update'); assert(checkpoint.memory.plan.steps.length >= 2);
  for (let i = 0; i < 3; i++) {
    requests = []; script = async (payload, res) => {
      const projected = JSON.stringify(payload.messages);
      assert(projected.includes('changed')); assert(projected.includes('Retain results across Resume'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(frame({ reasoning_content: 'Resuming from tool results' }));
    };
    run(`resume-${i}`, 'Continue from saved results', 'lineage'); await wait(() => requests.length, 'resume'); await pause(`resume-${i}`);
    assert.equal(await readFile(join(project, 'a.txt'), 'utf8'), 'changed');
    assert(!events.some(e => e.run_id === `resume-${i}` && e.type === 'tool_call_started' && e.name === 'replace_text'));
  }
  requests = [];
  script = async (_payload, res) => tools(res, [['web_project', { action: 'read' }], ['write_file', { path: 'a.txt', content: 'must not start after pause' }]]);
  run('during-tool', 'Inspect the browser before editing', 'tool-lineage', { web_mode: 'auto', web_tools: [{ type: 'function', function: { name: 'web_project', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } } }] });
  const host = await wait(() => event('during-tool', 'host_tool_call'), 'host operation');
  setTimeout(() => send({ type: 'host_tool_result', run_id: 'during-tool', id: host.id, result: { title: 'Successful in-flight result' } }), 220);
  await pause('during-tool');
  assert.equal(await readFile(join(project, 'a.txt'), 'utf8'), 'changed', 'next mutation did not start');
  assert(event('during-tool', 'tool_result').content.includes('Successful in-flight result'));
  assert(event('during-tool', 'tool_error').message.includes('Not executed'));
  // No forced stream restart for reasoning configuration changes.
  requests = []; let finish;
  script = async (_payload, res, n) => {
    if (n <= 2) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(frame({ reasoning_content: 'Current generation' })); finish = () => res.end(frame({ tool_calls: [{ index: 0, id: `view-${n}`, type: 'function', function: { name: 'plan', arguments: '{"action":"view"}' } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); }
    else text(res);
  };
  run('reasoning-live', 'Inspect plan without editing'); await wait(() => requests.length === 1 && finish, 'live initial');
  send({ type: 'reasoning', run_id: 'reasoning-live', id: 'medium', mode: 'fast', options: options('medium'), selection: { mode: 'agent', reasoningMode: 'fast', reasoningEffort: 'medium', thinkingEnabled: true } });
  await wait(() => event('reasoning-live', 'control_accepted')?.id === 'medium', 'requested config');
  assert(!event('reasoning-live', 'reasoning_applied')); assert.equal(requests.length, 1);
  finish(); await wait(() => requests.length === 2, 'medium applied'); assert.equal(requests[1].reasoning_effort, 'medium');
  assert.equal(event('reasoning-live', 'reasoning_applied').configuration.reasoningMode, 'fast');
  send({ type: 'reasoning', run_id: 'reasoning-live', id: 'max', mode: 'deep', options: options('xhigh'), selection: { mode: 'agent', reasoningMode: 'deep', reasoningEffort: 'max', thinkingEnabled: true } });
  await wait(() => event('reasoning-live', 'control_accepted')?.id === 'max', 'reverse config'); finish();
  await wait(() => event('reasoning-live', 'final'), 'live final'); assert.equal(requests[2].reasoning_effort, 'xhigh');
  requests = []; script = async (_payload, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); };
  run('stop', 'Inspect project'); await wait(() => requests.length, 'stop start'); send({ type: 'cancel', run_id: 'stop' }); await wait(() => event('stop', 'agent_stopped'), 'Stop'); assert(!event('stop', 'run_paused'));
  console.log(JSON.stringify({ result: 'PASS', provider: 'scripted SSE; real Rust executable; no Qwen inference', measurements, repeatedResume: 3, liveEffortBothDirections: true, stop: true }, null, 2));
} finally { child?.stdin.end(JSON.stringify({ type: 'shutdown' }) + '\n'); child?.kill('SIGTERM'); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); }
