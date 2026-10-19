// Opt-in real Qwen + MTP + CPU projector + native Page + Rust file/browser tools.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, open, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { _electron } from 'playwright-core';

const root = await mkdtemp('/tmp/lad-native-qwen-');
const project = await mkdtemp('/tmp/lad-native-project-');
const out = resolve('docs/test-results/scenario-qa/qwen-contracts');
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

  const fixture=`<!doctype html><title>Scene controls</title><canvas tabindex="0" width="600" height="280"></canvas><output id="mode"></output><script>const keys=new Set();window.__qaDiagnostics={camera:0,distance:100};const d=window.__qaDiagnostics,c=document.querySelector('canvas').getContext('2d');onkeydown=e=>keys.add(e.key);onkeyup=e=>keys.delete(e.key);const mode=()=>location.hash.slice(1)||'info';function draw(){document.querySelector('#mode').textContent=mode();if(mode()==='play'&&keys.has('w'))d.camera++;if(mode()==='orbit')d.distance-=.1;c.fillStyle='navy';c.fillRect(0,0,600,280);c.fillStyle='yellow';c.fillRect(Math.max(0,d.distance),80,20,20);requestAnimationFrame(draw)}draw();</script>`;
  await writeFile(join(project,'index.html'),fixture);
  const scenarios=[{id:'camera',text:'Holding forward in Play moves the camera',kind:'interaction',spec:{target:'/index.html#play',preconditions:[{source:'text',selector:'#mode',operator:'equals',expected:'play'}],required_state:[],steps:[{action:'hold',key:'w',selector:'canvas',duration_ms:500}],assertion:{source:'diagnostic',path:'camera',operator:'increased'},timeout_ms:5000}},{id:'motion',text:'The object moves closer during Orbit',kind:'temporal',spec:{target:'/index.html#orbit',preconditions:[{source:'text',selector:'#mode',operator:'equals',expected:'orbit'}],required_state:[],steps:[],assertion:{source:'diagnostic',path:'distance',operator:'decreased',sample_ms:[0,200,500]},timeout_ms:5000}}];
  const registrations=scenarios.map(s=>({action:'add',id:s.id,text:s.text,check:'browser',criteria:[{id:'observed',description:s.text,kind:s.kind,scenario:s.spec}]}));
  await start(`Read-only verification of index.html. Do not edit, use terminals, install or access network. Read the source first. Register exactly these two deliverables by calling deliverables with each object: ${JSON.stringify(registrations)}. Mark each implemented citing index.html. Then call web_project action qa with scenario_refs [{"deliverable_id":"camera","criterion_id":"observed"},{"deliverable_id":"motion","criterion_id":"observed"}]. Use these immutable specifications without changing them. A generic open does not prove these requirements. Verify each deliverable using the fresh mapped evidence from the QA call. Report functional evidence separately from probabilistic Vision. Finish concisely.`);
  const run=await finish(300000);result.run=run;assert(!run.error,JSON.stringify(run.error));assert(run.events.some(e=>e.type==='done'));assert.equal(await source(),fixture);assert.equal(writesOf(run).length,0);
  const memory=memoryOf(run);assert(memory,JSON.stringify(run.events.slice(-5)));for(const id of ['camera','motion'])assert.equal(memory.deliverables.items.find(i=>i.id===id)?.status,'verified',JSON.stringify(memory.deliverables));
  const reports=run.reports.filter(r=>r.scenarios?.some(s=>s.deliverableId));assert(reports.length,JSON.stringify(run.reports));assert(reports.flatMap(r=>r.scenarios).some(s=>s.evidenceKind==='temporal'&&s.observations.length===3&&s.status==='Verified'));assert(reports.flatMap(r=>r.scenarios).some(s=>s.evidenceKind==='interaction'&&s.elapsedMs>=500&&s.status==='Verified'));assert(reports.some(r=>r.visual.analyzed));
  result.metrics=await(await fetch(new URL('/metrics',endpoint))).text();assert(Number(result.metrics.match(/^llamacpp:spec_decode_num_accepted_tokens_total ([0-9]+)/m)?.[1])>0);result.result='PASS';console.log(JSON.stringify({result:'PASS',root,scope:'Real Qwen3.8 MTP + Vision + native Electron; immutable scenario_refs, 500ms control, temporal object motion and mapped deliverable proof',final:textOf(run)}));
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
  await writeFile(join(out, 'qwen-contract-result.json'), JSON.stringify(result, null, 2));
}
