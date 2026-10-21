// Opt-in real model stress run. Uses the production launcher/controller and
// Electron Native Browser fixture with an isolated runtime and project.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { _electron } from 'playwright-core';

const modelId = process.env.LOCAL_AI_TEST_MODEL_ID ?? 'qwen3.6:35b-a3b-ud-q4_k_m';
const qwen36 = modelId === 'qwen3.6:35b-a3b-ud-q4_k_m';
const onlyLong = process.env.LOCAL_AI_TEST_ONLY_LONG === '1';
const onlyAb = process.env.LOCAL_AI_TEST_ONLY_AB === '1';
const onlyBrowserPair = process.env.LOCAL_AI_TEST_ONLY_BROWSER_PAIR === '1';
const model = process.env.LOCAL_AI_TEST_GGUF ?? (qwen36
  ? '/media/yaroslav/DATA/llama-models/Qwen3.6-35B-A3B-Q4_K_M/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'
  : '/media/yaroslav/01D9B3596C5596B0/LINUX-LLM/Qwen3-Coder-Next-80B-Q4/Qwen_Qwen3-Coder-Next-Q4_K_M.gguf');
const root = await mkdtemp(join(tmpdir(), 'lad-real-agent-reliability-'));
process.env.LOCAL_AI_RUNTIME_ROOT = root;
const project = await mkdtemp(join(tmpdir(), 'lad-real-agent-project-'));
await mkdir(project, { recursive: true });
const result = { modelId, model, root, project, mtp: 'off', runs: [], startedAt: new Date().toISOString() };
const require = createRequire(import.meta.url);
const runtimeSettings = require('../dist/main/services/runtime-settings.js');
require('../dist/main/services/paths.js').ensureAppDirectories();
const { LlamaRuntimeController } = require('../dist/main/services/llama-runtime-controller.js');
const freeGpu = () => Number(execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim());
const availableRam = () => Number(execFileSync('bash', ['-lc', "awk '/^MemAvailable:/ {print $2*1024}' /proc/meminfo"], { encoding: 'utf8' }).trim());
assert(freeGpu() >= 21_000, 'Refusing to compete with an active GPU workload; need at least 21 GiB free');
assert(availableRam() >= (qwen36 ? 36 : 48) * 1024 ** 3, 'Available RAM is below the conservative model startup threshold');
assert(!execFileSync('bash', ['-lc', "pgrep -af '[l]lama-server' || true"], { encoding: 'utf8' }).trim(), 'A llama-server is already active; refusing to touch it');

const base = runtimeSettings.loadRuntimeConfiguration();
const userConfiguration = JSON.parse(await readFile(resolve('runtime/app-data/runtime-settings.json'), 'utf8'));
const sourceProfile = userConfiguration.models.find(entry => entry.id === modelId);
assert(sourceProfile, `No saved profile ${modelId} exists`);
assert.equal(sourceProfile.modelPath, model, 'The configured GGUF path must match the requested real model');
const profile = {
  ...sourceProfile,
  modelPath: model,
  mmprojPath: '',
  mtpMode: 'off',
  ...(qwen36
    ? { gpuLayers: 8, advanced: { mode: 'gpu-layers', cpuMoe: 'first', cpuMoeLayers: 32, threads: 8, threadsBatch: 8, batchSize: 1024, ubatchSize: 128, flashAttention: 'on', loadMode: 'mmap' } }
    : { gpuLayers: 48, advanced: { mode: 'gpu-layers', cpuMoe: 'first', cpuMoeLayers: 32, threads: 8, threadsBatch: 8, batchSize: 2048, ubatchSize: 512, flashAttention: 'on', loadMode: 'mmap' } }),
};
runtimeSettings.saveRuntimeConfiguration({ ...base, llamaServerPath: '/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server', models: [profile] });

const socket = createServer();
await new Promise(resolveListen => socket.listen(0, '127.0.0.1', resolveListen));
const port = socket.address().port;
await new Promise(resolveClose => socket.close(resolveClose));
const controller = new LlamaRuntimeController({ stateFile: join(root, 'llama-cpp-runtime-state.json'), requestFile: join(root, 'llama-cpp-runtime-request.env'), launcherPidFile: join(root, 'llama-cpp-mtp-launcher.pid') }, 360_000);
const launcherLog = join(root, 'launcher.log');
const launcherFd = await import('node:fs').then(fs => fs.openSync(launcherLog, 'w'));
const launcher = spawn('bash', [resolve('run-local-ai-desktop-llama-cpp-mtp.sh')], {
  env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root, LOCAL_AI_APP_DIR: resolve('.'), LOCAL_AI_LLAMA_PORT: String(port), LOCAL_AI_LAUNCHER_HEADLESS: '1', LOCAL_AI_PARENT_PID: String(process.pid) },
  stdio: ['ignore', launcherFd, launcherFd],
});
let app;
const delay = ms => new Promise(done => setTimeout(done, ms));
const waitFor = async (fn, label, timeout = 360_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return;
    assert.equal(launcher.exitCode, null, `Launcher exited before ${label}: ${await readFile(launcherLog, 'utf8')}`);
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const summary = async () => JSON.parse(await readFile(join(root, 'agent-status.json'), 'utf8'));
const snapshot = async () => JSON.parse(await readFile(join(root, 'agent-result.json'), 'utf8'));
const runAgent = async (name, prompt, memory, { pauseAfterRead = false, options = {} } = {}) => {
  const begin = Date.now();
  const eventFile = join(root, 'agent-events.jsonl');
  const priorEventBytes = await readFile(eventFile).then(bytes => bytes.length).catch(() => 0);
  await app.evaluate((_event, args) => global.nativeFixture.startRealAgent(args.endpoint, args.model, args.prompt, args.context, args.memory, args.options), { endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: modelId, prompt, context: 65_536, memory, options });
  if (pauseAfterRead) {
    await waitFor(async () => {
      const bytes = await readFile(eventFile).catch(() => Buffer.alloc(0));
      const events = bytes.subarray(priorEventBytes).toString('utf8');
      const parsed = events.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const tools = new Map();
      for (const event of parsed) if (event.type === 'tool' && event.activity?.id) tools.set(event.activity.id, { ...(tools.get(event.activity.id) ?? {}), ...event.activity });
      return [...tools.values()].some(activity => activity.toolName === 'read_file' && activity.state === 'completed');
    }, `${name} first read`, 480_000);
    const command = { id: `${Date.now()}-pause`, action: 'pause' };
    await writeFile(join(root, 'native-command.json'), JSON.stringify(command));
    await waitFor(async () => {
      const state = await summary().catch(() => null);
      return state?.finished === true;
    }, `${name} Pause checkpoint`, 30_000);
  } else {
    await waitFor(async () => (await summary()).finished, `${name} completion`, 480_000);
  }
  const run = await snapshot();
  const activities = run.events.filter(event => event.type === 'tool' && event.activity);
  const byId = new Map();
  for (const event of activities) byId.set(event.activity.id, { ...(byId.get(event.activity.id) ?? {}), ...event.activity });
  const calls = [...byId.values()].filter(activity => typeof activity.toolName === 'string');
  const completed = calls.filter(activity => activity.state === 'completed');
  const failed = calls.filter(activity => activity.state === 'failed' || activity.state === 'error');
  const duplicateSignatures = completed.filter(activity => activity.toolName).map(activity => `${activity.toolName}:${JSON.stringify(activity.arguments ?? activity.input ?? {})}`);
  const text = run.events.filter(event => event.type === 'token').map(event => event.content ?? '').join('');
  const telemetry = run.events.filter(event => event.type === 'agent-telemetry').map(event => event.telemetry ?? {});
  const completion = run.events.some(event => event.type === 'paused') ? 'paused' : run.events.some(event => event.type === 'cancelled') ? 'cancelled' : run.events.some(event => event.type === 'error') || run.error ? 'error' : run.events.some(event => event.type === 'done') ? 'done' : 'other';
  const record = { name, elapsedMs: Date.now() - begin, result: run, metrics: { toolCalls: calls.length, completedToolCalls: completed.length, failedToolCalls: failed.length, duplicateToolCalls: duplicateSignatures.length - new Set(duplicateSignatures).size, toolNames: completed.map(activity => activity.toolName), streamEvents: run.events.length, emittedTextChars: text.length, latestInputTokens: telemetry.findLast(value => Number.isFinite(value.inputTokens))?.inputTokens ?? 'unavailable', latestOutputTokens: telemetry.findLast(value => Number.isFinite(value.outputTokens))?.outputTokens ?? 'unavailable', latestDecodeTokPerSec: telemetry.findLast(value => Number.isFinite(value.tokensPerSecond))?.tokensPerSecond ?? 'unavailable', contextUsed: run.events.findLast(event => event.type === 'context-usage')?.used ?? 'unavailable', browserActions: completed.filter(activity => /web|browser|qa/i.test(activity.toolName ?? '')).length, fileReads: completed.filter(activity => activity.toolName === 'read_file').length, fileMutations: completed.filter(activity => /write|edit|patch|replace|create/i.test(activity.toolName ?? '')).length, verificationReports: run.reports?.length ?? 0, finishReason: completion } };
  result.runs.push(record);
  await writeFile(join(root, `${name}.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ name, ...record.metrics, elapsedMs: record.elapsedMs }));
  if (name === 'scenario-a-research' || name === 'scenario-b-bugfix' || name === 'scenario-d-browser-qa' || name === 'scenario-f-resume-same-chat' || name === 'scenario-g-browser-followup') {
    assert.equal(completion, 'done', `${name} must finish normally, not just return after Stop/error`);
  }
  return run;
};

try {
  await waitFor(async () => (await controller.state()).status === 'idle', 'launcher idle');
  const context = 65_536;
  const loaded = await controller.switchTo(modelId, context, 'q8_0', true, undefined, 'off');
  assert(loaded.ok, JSON.stringify(loaded));
  assert.equal(loaded.state.contextWindow, context);
  assert.equal(loaded.state.kvCacheType, 'q8_0');
  assert.equal(loaded.state.speculativeMode, 'none');
  result.backend = { version: '0.4.1-dev d1d3c33', context, kv: 'q8_0 K/V', mtp: 'off baseline', profile: loaded.state.profileConfiguration, argv: loaded.state.launchArguments };
  result.memoryAtLoad = { freeGpuMiB: freeGpu(), availableRamBytes: availableRam() };

  app = await _electron.launch({ executablePath: resolve('scripts/electron-unconfined-fixture.sh'), args: [resolve('test-fixtures/native-browser/workspace-main.cjs')], env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: root, LOCAL_AI_TEST_PROJECT_ROOT: project, LOCAL_AI_TEST_MODEL_ID: modelId, LOCAL_AI_TEST_SOFTWARE: '1' }, timeout: 30_000 });
  const page = await app.firstWindow();
  await page.locator('.conversation').waitFor();

  await mkdir(join(project, 'src'), { recursive: true }); await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'filter-bug-fixture', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  if (onlyAb) {
    await writeFile(join(project, 'src/filter.js'), "export function filterItems(items, query) { return items.filter(item => item.name.includes(query)); }\n");
    await writeFile(join(project, 'test/filter.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { filterItems } from '../src/filter.js'; test('filter is case insensitive', () => assert.deepEqual(filterItems([{name:'Alpha'},{name:'beta'}], 'AL'), [{name:'Alpha'}]));\n");
    const research = await runAgent('scenario-a-research', 'Inspect this small project without changing files. Use the project tools to identify its files, explain what the exported function does, describe the existing test and state only limitations supported by those files. Cite file paths. Finish when you have enough evidence.', undefined, { options: { vision: 'off', qa: false } });
    assert(!research.error, JSON.stringify(research.error));
  }
  if (!onlyLong) {
    if (!onlyAb && !onlyBrowserPair) {
      await writeFile(join(project, 'src/filter.js'), "export function filterItems(items, query) { return items.filter(item => item.name.includes(query)); }\n");
      await writeFile(join(project, 'test/filter.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { filterItems } from '../src/filter.js'; test('filter is case insensitive', () => assert.deepEqual(filterItems([{name:'Alpha'},{name:'beta'}], 'AL'), [{name:'Alpha'}]));\n");
    }
    if (!onlyBrowserPair) {
      const bugRun = await runAgent('scenario-b-bugfix', 'Fix the bug in src/filter.js so the existing case-insensitive test in test/filter.test.js passes. Read only those two files with read_file, make the smallest change using apply_patch, then run `npm test` once from the project root (do not cd). Do not edit tests or package.json. Do not create diagrams or other artifacts. After a passing test, report the cause and finish.', undefined, { options: { vision: 'off', qa: false } });
      const test = spawn('node', ['--test'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
      let testOutput = ''; test.stdout.on('data', chunk => testOutput += chunk); test.stderr.on('data', chunk => testOutput += chunk);
      const testExit = await new Promise(done => test.once('exit', done));
      result.runs.at(-1).objectiveCheck = { command: 'node --test', exitCode: testExit, output: testOutput };
      await writeFile(join(root, 'scenario-b-test-output.txt'), testOutput);
      assert.equal(testExit, 0, `The actual project test must pass after Scenario B: ${testOutput}`);
      assert(!bugRun.error, JSON.stringify(bugRun.error));
    }

    if (!onlyAb) {
      const brokenPage = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}main{width:100vw;height:100vh;background:#192436}article{width:620px;height:40px;background:#d44;color:white}</style></head><body><main><article id="overflow">Responsive preview</article></main></body></html>';
      await writeFile(join(project, 'index.html'), brokenPage);
      const browserRun = await runAgent('scenario-d-browser-qa', 'Use the existing Browser tools on index.html. At a 390 px mobile viewport, identify and fix the unintended horizontal overflow while preserving the full-height dark scene. Recheck with existing QA tools and report the route, viewport and evidence. Do not use vision inference; DOM/layout evidence is enough.', undefined, { options: { vision: 'off', qa: true } });
      result.browserFixtureFinal = await readFile(join(project, 'index.html'), 'utf8');
      assert(!browserRun.error, JSON.stringify(browserRun.error));
      if (onlyBrowserPair) {
        const followup = await runAgent('scenario-g-browser-followup', 'This is a follow-up run in the same chat immediately after the previous browser QA. Reuse the existing Native Browser page if it is still available; only open index.html if the browser reports no current page. Capture a screenshot with analyze=false (no Vision inference), and report the route, viewport, capture ID and whether the existing page was reused. Do not reload or navigate unless recovery requires it.', undefined, { options: { vision: 'off', qa: false } });
        assert(!followup.error, JSON.stringify(followup.error));
      }
    }
  }

  if (!onlyAb && !onlyBrowserPair) {
    await writeFile(join(project, 'src/tasks.js'), "export function visibleTasks(tasks) { return tasks; }\n");
    await writeFile(join(project, 'test/tasks.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { visibleTasks } from '../src/tasks.js'; test('filter and sort with saved settings', () => { const settings={query:'a',sort:'name'}; const actual=visibleTasks([{name:'Zulu'},{name:'Alpha'},{name:'Beta'}],settings); assert.deepEqual(actual.map(x=>x.name),['Alpha','Beta']); });\n");
  }
  if (!onlyAb && !onlyBrowserPair) {
  const first = await runAgent('scenario-e-long-pause', 'Implement the task-list behavior required by test/tasks.test.js in src/tasks.js. First create a short plan, inspect the test and implementation, then make a minimal change. Do not edit tests. Verify the behavior. Keep this task scoped to one function.', undefined, { pauseAfterRead: true, options: { vision: 'off', qa: false } });
  assert(first.events.some(event => event.type === 'paused'), 'The long-task run must actually pause after a successful read');
  const checkpoint = first.events.findLast(event => event.type === 'task-memory')?.memory;
  assert(checkpoint, 'Pause checkpoint should contain Task Memory');
  const observationIds = first.events
    .filter(event => event.type === 'tool' && event.activity?.toolName === 'read_file')
    .map(event => String(event.activity.output ?? '').match(/obs-[0-9a-z]+/i)?.[0] ?? null)
    .filter(Boolean);
  const resumePrompt = `Continue the previous task from its checkpoint. The unchanged file reads are already in this chat; do not call read_file again for the same paths. If you need their contents, use observation_read with one of these IDs: ${observationIds.join(', ') || 'none reported'}. Make the minimal implementation change, ensure test/tasks.test.js passes, then report completion.`;
  const resume = await runAgent('scenario-f-resume-same-chat', resumePrompt, checkpoint, { options: { vision: 'off', qa: false } });
  result.runs.at(-1).objectiveCheck = { actualTaskTest: 'run below' };
  const featureTest = spawn('node', ['--test'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  let featureOutput = ''; featureTest.stdout.on('data', chunk => featureOutput += chunk); featureTest.stderr.on('data', chunk => featureOutput += chunk);
  const featureExit = await new Promise(done => featureTest.once('exit', done));
  result.runs.at(-1).objectiveCheck = { command: 'node --test', exitCode: featureExit, output: featureOutput };
  await writeFile(join(root, 'scenario-e-test-output.txt'), featureOutput);
  assert.equal(featureExit, 0, `The actual long-task project test must pass: ${featureOutput}`);
  assert(!resume.error, JSON.stringify(resume.error));
  }
  result.completedAt = new Date().toISOString();
  result.status = 'PASS';
  await writeFile(join(root, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, root, runs: result.runs.map(run => ({ name: run.name, ...run.metrics, elapsedMs: run.elapsedMs, objectiveCheck: run.objectiveCheck })) }));
} catch (error) {
  result.status = 'FAILED_OR_BLOCKED'; result.error = { message: String(error), stack: error.stack };
  result.completedAt = new Date().toISOString();
  await writeFile(join(root, 'results.json'), JSON.stringify(result, null, 2)).catch(() => {});
  console.error(JSON.stringify({ status: result.status, root, error: result.error, recentRuns: result.runs.map(run => ({ name: run.name, ...run.metrics, elapsedMs: run.elapsedMs })) }));
  throw error;
} finally {
  await app?.close().catch(() => {});
  if (launcher.exitCode === null) {
    const exited = new Promise(done => launcher.once('exit', done)); launcher.kill('SIGTERM');
    await Promise.race([exited, delay(15_000)]);
    if (launcher.exitCode === null) launcher.kill('SIGKILL');
  }
  await import('node:fs').then(fs => fs.closeSync(launcherFd));
  result.launcherStopped = launcher.exitCode !== null || launcher.signalCode !== null;
  await writeFile(join(root, 'results.json'), JSON.stringify(result, null, 2)).catch(() => {});
  if (process.env.LOCAL_AI_KEEP_TEST_ARTIFACTS !== '1') {
    await rm(root, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}
