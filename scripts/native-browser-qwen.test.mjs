// Opt-in real Qwen + MTP + CPU projector + native Page + Rust file/browser tools.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, open, copyFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { _electron } from 'playwright-core';

const root = await mkdtemp('/tmp/lad-native-qwen-');
const project = await mkdtemp('/tmp/lad-native-project-');
const out = resolve('artifacts/native-browser');
await mkdir(out, { recursive: true });
const binary = process.env.LOCAL_AI_TEST_LLAMA_SERVER ?? resolve('../llama.cpp/build-cuda/bin/llama-server');
const model = process.env.LOCAL_AI_TEST_QWEN_GGUF ?? resolve('../llama-models/qwen3.8-27b-q4_K_M.gguf');
const projector = process.env.LOCAL_AI_TEST_PROJECTOR ?? resolve('../llama-models/qwen3.8-27b-mmproj.gguf');
const modelId = 'qwen3.8:27b-q4_K_M';
const free = Number(execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim());
assert(free > 21000, 'Do not interfere with an existing GPU model; need 21000 MiB free');
const listener = createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const fd = await open(join(root, 'server.log'), 'w');
const server = spawn(binary, ['-m', model, '--mmproj', projector, '--no-mmproj-offload', '--host', '127.0.0.1', '--port', String(port), '--ctx-size', '32768', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--n-gpu-layers', '999', '--parallel', '1', '--jinja', '--no-warmup', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '2', '--metrics'], { stdio: ['ignore', fd.fd, fd.fd] });
const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const summary = async () => JSON.parse(await readFile(join(root, 'agent-status.json'), 'utf8'));
const snapshot = async () => JSON.parse(await readFile(join(root, 'agent-result.json'), 'utf8'));
const memoryOf = run => run.events.findLast(e => e.type === 'task-memory')?.memory;
const textOf = run => run.events.filter(e => e.type === 'token').map(e => e.content).join('');
const writesOf = run => run.events.filter(e => e.type === 'tool' && ['write_file', 'replace_text', 'apply_patch', 'create_file'].includes(e.activity.toolName));
const source = () => readFile(join(project, 'index.html'), 'utf8');
const command = async action => {
  const id = Date.now() + '-' + action;
  await writeFile(join(root, 'native-command.tmp'), JSON.stringify({ id, action }));
  await rename(join(root, 'native-command.tmp'), join(root, 'native-command.json'));
  for (let i = 0; i < 100; i++) {
    let ack; try { ack = JSON.parse(await readFile(join(root, 'native-command-ack.json'), 'utf8')); } catch { /* waiting for fixture */ }
    if (ack?.id === id) { assert(!ack.error, ack.error); return; }
    await sleep(50);
  }
  throw new Error('Fixture command acknowledgement timeout: ' + action);
};
const result = { root, project, model, projector, context: 32768, mtp: true };
let app;
const start = async (prompt, memory) => app.evaluate((_e, args) => global.nativeFixture.startRealAgent(args.endpoint, args.modelId, args.prompt, 32768, args.memory), { endpoint, modelId, prompt, memory });
const finish = async (timeoutMs = 240000) => {
  const began = performance.now();
  while (performance.now() - began < timeoutMs) {
    if ((await summary()).finished) return snapshot();
    await sleep(100);
  }
  throw new Error(`Owned test run did not finish within ${timeoutMs} ms: ${JSON.stringify(await summary())}`);
};
try {
  for (let i = 0; ; i++) {
    assert.equal(server.exitCode, null, 'Owned server failed');
    try { if ((await fetch(new URL('/health', endpoint))).ok) break; } catch { /* starting */ }
    assert(i < 240, 'Owned model server startup timeout');
    await sleep(500);
  }
  await writeFile(join(project, 'index.html'), '<canvas width="600" height="300"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="white";c.fillRect(0,0,600,300);c.fillStyle="blue";c.fillRect(30,40,100,100);c.fillStyle="red";c.beginPath();c.moveTo(210,140);c.lineTo(265,40);c.lineTo(320,140);c.fill();c.fillStyle="yellow";c.beginPath();c.arc(420,90,50,0,Math.PI*2);c.fill()</script>');
  app = await _electron.launch({ executablePath: resolve('scripts/electron-unconfined-fixture.sh'), args: [resolve('test-fixtures/native-browser/workspace-main.cjs')], env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root, LOCAL_AI_TEST_PROJECT_ROOT: project } });
  app.process().stderr.on('data', data => { void writeFile(join(root, 'electron-stderr.log'), data, { flag: 'a' }); });
  const ui = await app.firstWindow();
  await ui.locator('.conversation').waitFor();
  assert(!(await app.evaluate(() => global.nativeFixture.open())).error);
  await ui.locator('.mode-split').waitFor();
  await sleep(300);
  const png = await app.evaluate(() => global.nativeFixture.screenshot());
  const imageStarted = performance.now();
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'List the colored shapes from left to right in this image.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] }], max_tokens: 128, temperature: 0, chat_template_kwargs: { enable_thinking: false } }) });
  const value = await response.json();
  assert(response.ok, JSON.stringify(value));
  const answer = value.choices[0].message.content;
  assert.match(answer, /blue.*square[\s\S]*red.*triangle[\s\S]*yellow.*circle/i);
  result.imageOnly = { answer, latencyMs: performance.now() - imageStarted, usage: value.usage };
  await app.evaluate(() => global.nativeFixture.close());

  const broken = `<!doctype html><title>Camera fixture</title><style>body{margin:0}canvas{display:block}</style><canvas width="600" height="280" tabindex="0"></canvas><output id="camera">0</output><script>let active=true,n=0;window.__qaDiagnostics={camera:0};const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');function frame(){if(!active)return;ctx.fillStyle='hsl('+(n++%360)+' 50% 40%)';ctx.fillRect(0,0,600,280);requestAnimationFrame(frame)}frame();function moveCamera(){window.__qaDiagnostics.camera++;document.querySelector('#camera').textContent=String(window.__qaDiagnostics.camera)}canvas.onpointermove=()=>{moveCamera();active=false;throw new Error('camera rotation defect')};window.onkeydown=e=>{if(e.code==='KeyW')moveCamera()};</script>`;
  await writeFile(join(project, 'index.html'), broken);
  const checks = JSON.stringify([{ action: 'hold', key: 'w', duration_ms: 300, expect: { selector: '#camera', changed: true } }, { action: 'click', selector: 'canvas', expect: { selector: '#camera', changed: true } }]);
  await start(`Fix the camera rotation defect in index.html. Use plan to record a short reproduction/repair/verification plan. First reproduce using web_project action qa BEFORE editing. Read the file, record the observed finding in task_memory, fix minimally, then call qa with checks ${checks}. Preserve the pointer/keyboard handlers and animated Canvas. Never add hidden inputs, remove handlers or fill body. Use built-in file/browser tools only; no terminal, installs, other browsers or external network. Report actual verification scope honestly.`);
  let pauseStarted, initialNativeId;
  for (let i = 0; i < 2400; i++) {
    const state = await summary();
    initialNativeId ??= state.nativeViewId;
    if (state.reports > 0 && state.qaPhase === 'analyzing' && await source() !== broken) {
      result.repairedSource = await source();
      pauseStarted = performance.now();
      await command('pause');
      break;
    }
    assert(!state.finished, `Agent finished before the post-edit Vision pause: ${JSON.stringify(state)}`);
    if (i % 100 === 0) console.log(JSON.stringify({ phase: 'repair/pause', seconds: i / 10, ...state }));
    await sleep(100);
  }
  assert(pauseStarted, 'Need an actual Pause during post-edit Vision');
  const paused = await finish(10000);
  result.pauseMs = performance.now() - pauseStarted;
  result.paused = paused;
  assert(paused.events.some(e => e.type === 'paused'));
  assert.equal(paused.ownership, 'paused');
  assert.equal(paused.nativeViewId, initialNativeId);
  assert(result.pauseMs < 3000, `Pause took ${result.pauseMs} ms`);
  assert.equal(paused.reports[0].status, 'Failed');
  assert(paused.reports[0].errors.some(error => error.includes('camera rotation defect')));
  assert(paused.reports[0].checks.some(check => check.action === 'canvas animation' && check.status === 'Failed'), 'The fixture stopped RAF after interaction');
  assert(writesOf(paused).length, 'The real model repaired the source with an authorized file tool');
  assert(!/<(?:input|textarea)\b/i.test(result.repairedSource), 'No input substitutes in a Canvas fixture');
  assert.match(result.repairedSource, /onpointermove/);
  assert.match(result.repairedSource, /onkeydown/);
  const checkpoint = memoryOf(paused);
  assert(checkpoint?.verification?.records?.length, 'Runtime verification ledger saved');
  assert(checkpoint.plan?.steps?.length, 'Model plan saved');
  assert(checkpoint.entries?.length, 'Model finding saved');
  assert(paused.reports.some(report => report.status === 'Blocked'), 'In-flight Vision must not become falsely Verified when paused');

  await start(`Resume the paused camera repair. The file edit is already complete; do not repeat edits or create inputs. Preserve the existing plan and task findings. Retest the current page using web_project action qa with exactly these checks: ${checks}. Update verification/plan truthfully, then finish. Use no terminal or external network.`, checkpoint);
  const resumed = await finish();
  result.resumed = resumed;
  assert(!resumed.error, JSON.stringify(resumed.error));
  assert(resumed.events.some(e => e.type === 'done'));
  assert.equal(resumed.nativeViewId, initialNativeId);
  assert.equal(resumed.ownership, 'user');
  assert.equal(await source(), result.repairedSource);
  assert.equal(writesOf(resumed).length, 0, 'Resume does not repeat successful writes');
  const retest = resumed.reports.findLast(report => report.status !== 'Blocked');
  assert(retest && !retest.errors.length, 'Resume runs actual QA without runtime errors');
  assert(retest.checks.some(c => c.action.startsWith('hold') && c.status === 'Verified'), 'A changed application state proves keyboard handling');
  assert(retest.checks.some(c => c.action === 'canvas animation' && c.status === 'Verified'), 'RAF continues after input');
  assert(retest.visual.analyzed, 'Actual project Page PNGs reach the multimodal backend after Resume');
  const continuedMemory = memoryOf(resumed);
  assert(continuedMemory?.plan?.steps?.some(step => checkpoint.plan.steps.some(old => old.id === step.id)), 'Plan identity survives Resume');
  assert(continuedMemory.entries.some(entry => checkpoint.entries.some(old => old.id === entry.id)), 'Task finding survives Resume');
  result.resume = { sameNativeView: true, sourcePreserved: true, status: retest.status, functionalStatus: retest.functionalStatus, final: textOf(resumed) };

  await start('Read-only: explain browser event handling in detail. Do not use tools or modify files.', continuedMemory);
  await sleep(400);
  const stopStarted = performance.now();
  assert(!(await summary()).finished, 'Stop must interrupt an active run');
  await command('stop');
  const stopped = await finish(15000);
  result.stopped = stopped;
  assert(stopped.events.some(e => e.type === 'cancelled'), 'Stop ends the actual Rust stream');
  assert.equal(stopped.nativeViewId, initialNativeId);
  result.stop = { ms: performance.now() - stopStarted, sameNativeView: true };
  await start('Continue read-only in this chat. Use web_project read to inspect the current page, report briefly and finish. Do not change files or repeat the repair.', continuedMemory);
  const next = await finish();
  result.afterStop = next;
  assert(next.events.some(e => e.type === 'done'));
  assert.equal(next.nativeViewId, initialNativeId);
  assert.equal(await source(), result.repairedSource);
  assert.equal(writesOf(next).length, 0);

  result.gpu = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,power.draw', '--format=csv'], { encoding: 'utf8' }).trim();
  result.serverRss = (await readFile(`/proc/${server.pid}/status`, 'utf8')).split('\n').filter(l => /^VmRSS:|^VmHWM:/.test(l));
  result.metrics = await (await fetch(new URL('/metrics', endpoint))).text();
  assert(Number(result.metrics.match(/^llamacpp:spec_decode_num_accepted_tokens_total ([0-9]+)/m)?.[1]) > 0, 'MTP accepts actual drafted tokens');
  result.result = 'PASS';
  console.log(JSON.stringify({ result: 'PASS', root, pauseMs: result.pauseMs, resume: result.resume, stop: result.stop, imageOnly: result.imageOnly }));
} catch (error) {
  result.error = { message: String(error), stack: error.stack };
  throw error;
} finally {
  await app?.evaluate(async () => global.nativeFixture.close()).catch(() => {});
  await app?.close().catch(() => {});
  if (server.exitCode === null) {
    const exited = new Promise(r => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([exited, sleep(5000)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]); }
  }
  await fd.close();
  result.serverStopped = server.exitCode !== null || server.signalCode !== null;
  await copyFile(join(root, 'server.log'), join(out, 'qwen-server.log')).catch(() => {});
  await writeFile(join(out, 'qwen-native-result.json'), JSON.stringify(result, null, 2));
}
