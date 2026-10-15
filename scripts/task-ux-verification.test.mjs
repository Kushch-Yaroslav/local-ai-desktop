// Focused verification regressions. Never rebuild a running production ELF.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, copyFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const loopContext = process.argv.includes('--loop-context');
const target = await mkdtemp(join(tmpdir(), 'lad-task-ux-build-'));
const parent = resolve('.ai-research/validation'); await mkdir(parent, { recursive: true });
// Bootstrap/harness must be visible outside the sandbox's private /tmp.
const fixture = await mkdtemp(join(parent, 'task-ux-runtime-'));
const env = { ...process.env, CARGO_TARGET_DIR: target };
const manifest = resolve('rust-agent/Cargo.toml');

async function run(label, program, args, executionEnv = env) {
  const child = spawn(program, args, { env: executionEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; const append = chunk => { output = (output + chunk).slice(-12000); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  let expired = false, killTimer;
  const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); }, 120000);
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    assert(!expired && code === 0, `${label}: exit ${code}${expired ? ' (timeout)' : ''}\n${output}`);
    console.log(`${label}: passed`);
    if (label === 'real Electron mandatory sandbox acceptance') console.log(output.split('\n').filter(line => line.startsWith('Effective payload security:')).join('\n'));
  } finally { clearTimeout(timer); clearTimeout(killTimer); }
}

try {
  await run('separate Rust build', 'cargo', ['build', '--offline', '--locked', '--manifest-path', manifest]);
  if (loopContext) {
    for (const filter of ['context::projection', 'permissions::tests', 'loop_detector', 'loop_repair_rearms', 'repaired_strategy_with_different_failed_calls', 'completed_then_multiple_interruptions', 'runtime_guidance', 'tools::failure'])
      await run(filter, 'cargo', ['test', '--offline', '--locked', '--manifest-path', manifest, '--lib', filter]);
  } else {
  await run('verification unit tests', 'cargo', ['test', '--offline', '--locked', '--manifest-path', manifest, '--lib', 'verification']);
  await run('wrapper and owned-stop evidence tests', 'cargo', ['test', '--offline', '--locked', '--manifest-path', manifest, '--lib', 'wrapped_evidence_tests']);
  await run('deliverable contract tests', 'cargo', ['test', '--offline', '--locked', '--manifest-path', manifest, '--lib', 'deliverables::tests']);
  await run('retry guidance tests', 'cargo', ['test', '--offline', '--locked', '--manifest-path', manifest, '--lib', 'tools::failure']);
  }
  await run('isolated integration compilation', 'cargo', ['test', '--offline', '--locked', '--manifest-path', manifest, '--test', 'agent_loop', '--no-run']);
  const deps = join(target, 'debug/deps');
  const files = (await readdir(deps)).filter(name => name.startsWith('agent_loop-') && !name.endsWith('.d'));
  const executable = (await Promise.all(files.map(async name => ({ name, elf: (await readFile(join(deps, name))).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) })))).find(file => file.elf);
  assert(executable, 'integration ELF not found');
  await mkdir(join(fixture, 'deps'));
  const harness = join(fixture, 'deps', executable.name), binary = join(fixture, 'local-ai-agent-runtime');
  await copyFile(join(deps, executable.name), harness); await chmod(harness, 0o755);
  await copyFile(join(target, 'debug/local-ai-agent-runtime'), binary); await chmod(binary, 0o755);
  if (process.argv.includes('--sandbox')) {
    await run('runtime protection integration compilation', 'cargo', ['test', '--offline', '--locked', '--manifest-path', manifest, '--test', 'runtime_protection', '--no-run']);
    const name = (await readdir(deps)).find(name => name.startsWith('runtime_protection-') && !name.endsWith('.d'));
    assert(name, 'runtime protection ELF missing');
    const protection = join(fixture, 'deps', name);
    await copyFile(join(deps, name), protection); await chmod(protection, 0o755);
    await run('protected fixture processes and owned managed tasks', protection, []);
  }
  for (const name of (loopContext ? ['confirmed_metadata_loop_cleans_only_model_context_and_preserves_evidence', 'live_loop_pause_resume_correction_and_cancel_preserve_state'] : [
    'continued_task_checks_use_tracked_source_scope_instead_of_launch_cwd',
    'task_scoped_tests_do_not_prove_sibling_integrity_claims',
    'invalid_edits_and_missing_checks_have_actionable_retry_guidance',
    'a_pending_verification_rejection_recovers_after_implementation_with_the_same_arguments',
    'an_unchanged_report_does_not_invalidate_observed_runtime_evidence',
    'verified_terminal_literal_noop_keeps_evidence_but_real_edits_do_not',
    'a_check_that_rewrites_a_tracked_file_is_not_trusted',
    'verification_state_returns_on_continue_with_old_checks_stale_and_a_fresh_run_is_empty',
  ])) await run(name, harness, ['--exact', name]);
  if (process.argv.includes('--sandbox')) await run('real Electron mandatory sandbox acceptance', process.execPath, ['scripts/sandbox-startup-electron.test.mjs'], { ...process.env, LOCAL_AI_AGENT_RUNTIME: binary });
  await run('production IPC + real Rust task restoration', process.execPath, ['dist/main/ipc/logical-task-runtime.test.js'], { ...process.env, LOCAL_AI_AGENT_RUNTIME: binary, ...(loopContext ? { LOCAL_AI_TEST_LOOP_RECOVERY: '1' } : {}) });
  if (process.argv.includes('--permissions-ui')) await run('real Electron Ask and Autopilot approval workflow', process.execPath, ['scripts/agent-approval-electron.test.mjs', '--permissions-only'], { ...process.env, LOCAL_AI_AGENT_RUNTIME: binary });
} finally {
  // Only directories created by this invocation; user cache/models remain intact.
  await rm(fixture, { recursive: true, force: true }); await rm(target, { recursive: true, force: true });
}
