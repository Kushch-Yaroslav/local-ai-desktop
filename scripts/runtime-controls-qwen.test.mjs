// Opt-in real local llama.cpp inference. Never adopts/stops an existing server.
import assert from 'node:assert/strict';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const binary = process.env.LOCAL_AI_TEST_LLAMA_SERVER, model = process.env.LOCAL_AI_TEST_QWEN_GGUF;
assert(binary && model && existsSync(binary) && existsSync(model), 'Set LOCAL_AI_TEST_LLAMA_SERVER and LOCAL_AI_TEST_QWEN_GGUF');
const mtp = process.env.LOCAL_AI_TEST_MTP === '1';
const root = await mkdtemp(join(tmpdir(), 'lad-runtime-qwen-')), project = join(root, 'project');
await mkdir(project); await writeFile(join(project, 'a.txt'), 'A: runtime checkpoint retained\n'); await writeFile(join(project, 'b.txt'), 'B: next unfinished read\n');
const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise(r => listener.close(r));
const fd = openSync(join(root, 'llama-server.log'), 'w');
const server = spawn(binary, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', '32768', '--parallel', '1', '--n-gpu-layers', '99', '--jinja', '--no-webui', '--spec-type', mtp ? 'draft-mtp' : 'none', ...(mtp ? ['--spec-draft-n-max', '2', '--metrics'] : [])], { stdio: ['ignore', fd, fd] });
const delay = ms => new Promise(r => setTimeout(r, ms));
let agent;
const events = [], measurements = [];
const wait = async (predicate, label, timeout = 180000) => { const start = performance.now(); while (!predicate()) { if (performance.now() - start > timeout) throw Error(`Timeout: ${label}; last events ${JSON.stringify(events.slice(-4).map(e=>({type:e.type,code:e.code,state:e.state})))}`); await delay(10); } };
const options = effort => ({ fast: { reasoning_effort: effort }, deep: { reasoning_effort: effort }, final: { reasoning_effort: effort } });
const send = request => agent.stdin.write(JSON.stringify(request) + '\n');
const start = (id, effort, mode) => {
  agent?.stdin.end();
  agent = spawn(resolve('rust-agent/target/debug/local-ai-agent-runtime'), [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root } });
  createInterface({ input: agent.stdout }).on('line', line => { try { events.push(JSON.parse(line)); } catch { /* not protocol */ } });
  send({ type: 'run', run_id: id, endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: 'qwen3.8:27b-q4_K_M', system: 'Use file tools to inspect the project. Do not modify files.', user: id === 'pause-real' ? 'Read-only task: inspect a.txt and b.txt separately with read_file, record a short plan first, then report their exact contents.' : 'Continue the read-only inspection. Read a.txt with read_file first; on a separate model step read b.txt with read_file. Record findings in task_memory before the final answer. Preserve the current plan.', project_root: project, evidence_dir: join(root, 'evidence'), context_limit: 32768, reasoning_mode: mode, supports_reasoning: true, reasoning_options: options(effort), web_mode: 'off', policy: 'auto', permissions: { mode: 'strict', trusted_roots: [] } });
};
const last = (id, type) => events.findLast(e => e.run_id === id && e.type === type);
const pause = async id => { const started = performance.now(); send({ type: 'steer', run_id: id, content: 'Pause', intent: 'pause' }); await wait(() => last(id, 'run_paused'), 'real Pause', 10000); measurements.push({ run: id, pauseMs: Math.round((performance.now() - started) * 10) / 10 }); assert(!last(id, 'agent_error')); await delay(100); };
try {
  const started = performance.now();
  while (true) {
    assert.equal(server.exitCode, null, 'owned llama-server exited before readiness');
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not listening yet */ }
    assert(performance.now() - started < 120000, 'model load timeout'); await delay(500);
  }
  start('pause-real', 'xhigh', 'deep');
  await wait(() => last('pause-real', 'thinking_delta'), 'Qwen reasoning starts'); await pause('pause-real');
  start('live-real', 'xhigh', 'deep');
  await wait(() => last('live-real', 'thinking_delta'), 'Resume real Qwen');
  send({ type: 'reasoning', run_id: 'live-real', id: 'medium', mode: 'fast', options: options('medium'), selection: { mode: 'agent', reasoningMode: 'fast', reasoningEffort: 'medium', thinkingEnabled: true } });
  await wait(() => last('live-real', 'reasoning_applied')?.configuration.reasoningEffort === 'medium', 'medium applies on following Qwen step');
  assert.equal(last('live-real', 'request_policy').reasoning_effort, 'medium');
  send({ type: 'reasoning', run_id: 'live-real', id: 'max', mode: 'deep', options: options('xhigh'), selection: { mode: 'agent', reasoningMode: 'deep', reasoningEffort: 'max', thinkingEnabled: true } });
  await wait(() => last('live-real', 'reasoning_applied')?.configuration.reasoningEffort === 'max', 'max applies on following Qwen step');
  assert.equal(last('live-real', 'request_policy').reasoning_effort, 'xhigh');
  await pause('live-real');
  start('stop-real', 'xhigh', 'deep');
  await wait(() => last('stop-real', 'thinking_delta'), 'real Qwen generation before Stop');
  const stopStarted = performance.now(); send({ type: 'cancel', run_id: 'stop-real' });
  await wait(() => last('stop-real', 'agent_stopped'), 'real Qwen Stop', 10000);
  measurements.push({ run: 'stop-real', stopMs: Math.round((performance.now() - stopStarted) * 10) / 10 });
  assert(!last('stop-real', 'run_paused'), 'Stop must retain its terminal semantics');
  assert((await fetch(`http://127.0.0.1:${port}/health`)).ok, 'Stop must leave the model available');
  assert.equal(await import('node:fs/promises').then(fs=>fs.readFile(join(project,'a.txt'),'utf8')), 'A: runtime checkpoint retained\n');
  process.env.LOCAL_AI_RUNTIME_ROOT = root;
  const require = createRequire(import.meta.url);
  const { RustAgentRuntime } = require('../dist/main/services/rust-agent-runtime.js');
  const { LiveBrowserHub } = require('../dist/main/web/live-browser.js');
  const { ensureAppDirectories } = require('../dist/main/services/paths.js'); ensureAppDirectories();
  const hub = new LiveBrowserHub(); let browserState; let frames = 0; let approvals = 0;
  class Owner extends EventEmitter {
    constructor() { super(); this.id = 901; }
    isDestroyed() { return false; }
    send(_channel, event) { if (event.type === 'state') browserState = event.state; else { frames++; hub.acknowledge(this, event.frame.sessionId, event.frame.sequence); } }
  }
  const owner = new Owner(); hub.watch(owner, 'qwen-chat', true);
  const runtime = new RustAgentRuntime(`http://127.0.0.1:${port}/v1/chat/completions`);
  await writeFile(join(project, 'index.html'), '<title>Qwen browser acceptance</title><input style="position:absolute;left:10px;top:10px"><canvas tabindex="0"></canvas><script>let n=0,c=document.querySelector("canvas").getContext("2d");function frame(){c.fillStyle="hsl("+(n++%360)+" 60% 50%)";c.fillRect(0,0,300,150);requestAnimationFrame(frame)}frame()</script>');
  const seen = [];
  const browserRun = async (id, prompt) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 150000);
    try {
      const history = [{ id: 'prompt', conversationId: 'qwen-chat', role: 'user', content: prompt, createdAt: new Date().toISOString() }];
      for await (const event of runtime.stream('qwen3.8:27b-q4_K_M', history, [{id:'qwen-project',slot:1,root:project,label:'test'}], controller.signal, 32768, 'fast', 'auto', id, undefined, 'qwen-chat', true, options('medium'), [], undefined, async () => { approvals++; return { approved:true, reason:'once' }; }, undefined, {mode:'strict',trusted_roots:[]}, 'qwen-browser-task', hub.observer(owner,'qwen-chat',id))) {
        seen.push(event); if (event.type === 'error') throw Error(JSON.stringify(event));
      }
      assert(!controller.signal.aborted, 'Qwen browser run timeout');
      assert.equal(browserState.ownership, 'user');
    } finally { clearTimeout(timer); }
  };
  try {
    await browserRun('browser-real-1', 'Small browser acceptance task. Call web_project with action open and path index.html, then web_project with action read, then finish with the page title. Do not edit files, do not use other browser or terminal tools.');
    const sessionId = browserState.sessionId; const initialFrames = frames;
    await hub.input(owner, sessionId, {kind:'pointer',phase:'down',x:30,y:20}); await hub.input(owner, sessionId, {kind:'pointer',phase:'up',x:30,y:20});
    await hub.input(owner, sessionId, {kind:'text',text:'User after Qwen'});
    await delay(300); assert(frames > initialFrames, 'Qwen completion left a live interactive stream');
    await browserRun('browser-real-2', 'Use web_project action read on the existing project browser. Confirm the page title and finish. Do not reopen or edit files.');
    assert.equal(browserState.sessionId, sessionId, 'repeat real agent run retains the same browser session');
    assert.equal(approvals, 2, 'each real run obtained its own explicit browser approval');
    const browserCalls = new Set(seen.filter(e => e.type === 'tool' && e.activity.toolName === 'web_project').map(e => e.activity.id));
    assert(seen.some(e => e.type === 'tool' && browserCalls.has(e.activity.id) && e.activity.state === 'completed'));
  } finally { if (browserState) await hub.close(owner, browserState.sessionId).catch(() => undefined); }
  let mtpDiagnostics;
  if (mtp) {
    const { parseMtpMetrics } = require('../dist/main/services/mtp-diagnostics.js');
    mtpDiagnostics = parseMtpMetrics(await (await fetch(`http://127.0.0.1:${port}/metrics`)).text());
    assert(mtpDiagnostics?.drafted > 0 && mtpDiagnostics?.accepted > 0, 'real MTP must draft and accept tokens');
  }
  console.log(JSON.stringify({ result: 'PASS', model, context: 32768, mtp, mtpDiagnostics, vision: false, realQwenBrowserRuns: 2, browserApprovals: approvals, browserFrames: frames, measurements, applied: events.filter(e => e.type === 'reasoning_applied').map(e=>e.configuration), root }, null, 2));
} finally {
  agent?.stdin.end(JSON.stringify({ type: 'shutdown' }) + '\n'); agent?.kill('SIGTERM');
  if (server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(r => server.once('exit', r)), delay(5000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
  closeSync(fd);
  if (process.env.LOCAL_AI_KEEP_TEST_ARTIFACTS !== '1') await rm(root, { recursive: true, force: true });
}
