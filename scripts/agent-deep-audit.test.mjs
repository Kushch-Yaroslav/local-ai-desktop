// Deterministic Agent Runtime regressions. Build first with npm run build.
// All runtime/log artifacts go to a new temporary directory; no GGUF is loaded.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'lad-agent-deep-audit-'));
const section = process.argv.find(arg => arg.startsWith('--section='))?.split('=')[1] ?? 'all';
const selected = new Set(process.argv.filter(arg => arg.startsWith('--test=')).map(arg => arg.slice(7)));
if (!['all', 'rust', 'host', 'browser'].includes(section)) throw Error('Unknown test section');
const hosts = [
  'dist/main/services/rust-agent-runtime.test.js',
  'dist/main/services/agent-workspace.test.js',
  'dist/main/services/approval-broker.test.js',
  'dist/main/services/autonomy-session.test.js',
  'dist/main/services/database.test.js',
  'dist/main/services/run-recovery.test.js',
  'dist/main/services/protected-runtime.test.js',
  'dist/main/tools/tool-security.test.js',
  'dist/main/ipc/stop-history.test.js',
  'dist/main/ipc/terminal-lifecycle.test.js',
  'dist/main/ipc/logical-task-runtime.test.js',
  'dist/main/ipc/context-profiles.test.js',
  'dist/shared/generation-guard.test.js',
  'dist/main/services/browser-vision.test.js',
  'dist/main/web/qa-loop-guard.test.js',
];
const browsers = [
  'scripts/browser-session-reliability.test.mjs',
  'scripts/browser-session-native-electron.test.mjs',
  'scripts/scenario-qa.test.mjs',
  'scripts/scenario-qa-electron.test.mjs',
  'scripts/scenario-gate-runtime.test.mjs',
  'scripts/responsive-qa.test.mjs',
  'scripts/visual-layout-qa.test.mjs',
  'scripts/visual-layout-native-electron.test.mjs',
  'scripts/agent-status-renderer.test.mjs',
  'scripts/agent-approval-electron.test.mjs',
];
const commands = [
  ...(['all', 'rust'].includes(section) ? [{ name: 'rust', command: 'cargo', args: ['test', '--locked', '--manifest-path', 'rust-agent/Cargo.toml', '--', '--test-threads=1'] }] : []),
  ...(['all', 'host'].includes(section) ? hosts.map(name => ({ name, command: process.execPath, args: [name] })) : []),
  ...(['all', 'browser'].includes(section) ? browsers.map(name => ({ name, command: process.execPath, args: [name] })) : []),
];
for (const name of selected) if (!commands.some(test => test.name === name)) throw Error(`Unknown test in section ${section}: ${name}`);
const results = [];
for (const [index, test] of commands.filter(test => !selected.size || selected.has(test.name)).entries()) {
  const runtime = join(root, `runtime-${index}`);
  await Promise.all(['app-data', 'logs', 'cache'].map(name => mkdir(join(runtime, name), { recursive: true })));
  const output = await open(join(root, `${index}-${test.name.replaceAll('/', '_')}.log`), 'w');
  const started = performance.now();
  const child = spawn(test.command, test.args, {
    env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: runtime, LOCAL_AI_TEST_RESULTS_DIR: join(root, 'evidence') },
    stdio: ['ignore', output.fd, output.fd],
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Only the process group created for this isolated test is ours to stop.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
  }, 360_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  } finally { clearTimeout(timer); await output.close(); }
  results.push({ test: test.name, code, timedOut, durationMs: Math.round(performance.now() - started) });
  await writeFile(join(root, 'results.json'), JSON.stringify({ fixture: 'scripted providers; real Chromium/Electron where applicable; no model inference', results }, null, 2));
  console.log(code === 0 ? 'PASS' : 'FAIL', test.name, results.at(-1).durationMs + 'ms');
}
console.log('Logs and results:', root);
if (results.some(result => result.code !== 0)) process.exitCode = 1;
