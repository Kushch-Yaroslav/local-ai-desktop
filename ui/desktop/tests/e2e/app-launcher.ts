import { spawn, spawnSync, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Launches the desktop app for E2E tests without depending on the pnpm
 * version installed on the machine.
 *
 * Primary path: `pnpm run start-gui` (the project's standard dev chain,
 * including the goose-acp-client build).
 *
 * Fallback path: when pnpm refuses project commands because the local
 * pnpm/Node pair does not satisfy the manifest engines (ERR_PNPM_UNSUPPORTED_ENGINE),
 * the equivalent start-gui chain is executed directly with node:
 *
 *   node scripts/clean-vite-cache.js
 *   node scripts/i18n-compile.js
 *   node live-browser/build.mjs
 *   electron-forge start        (workspace hoisted node_modules)
 *
 * The goose-acp-client build is skipped on the fallback path: it is built
 * into node_modules by postinstall and does not change between tests.
 *
 * Returns the spawned child process (detached, so the fixture can kill the
 * whole process group on cleanup).
 */
export function launchApp(cwd: string, env: Record<string, string | undefined>): ChildProcess {
  const isWin = process.platform === 'win32';
  const desktopDir = resolve(cwd);
  const uiDir = resolve(desktopDir, '..');
  const forgeBin = join(
    uiDir,
    'node_modules',
    '.bin',
    isWin ? 'electron-forge.cmd' : 'electron-forge',
  );

  const commonEnv = {
    ...env,
    ELECTRON_IS_DEV: '1',
    NODE_ENV: 'development',
    GOOSE_ALLOWLIST_BYPASS: 'true',
    ENABLE_PLAYWRIGHT: 'true',
    RUST_LOG: 'info',
  } as Record<string, string | undefined>;

  const spawnPrimary = (): ChildProcess => {
    const child = spawn('pnpm', ['run', 'start-gui'], {
      cwd: desktopDir,
      stdio: 'pipe',
      detached: !isWin,
      env: commonEnv,
    });
    drain(child);
    return child;
  };

  // Probe with a cheap, idempotent project command: it triggers the same
  // engines validation as `pnpm run start-gui` but finishes quickly.
  const probe = spawnSync('pnpm', ['run', 'i18n:compile'], {
    cwd: desktopDir,
    stdio: 'pipe',
    env: commonEnv,
    timeout: 60_000,
  });
  const pnpmUsable =
    probe.status === 0 && !String(probe.stderr).includes('ERR_PNPM_UNSUPPORTED_ENGINE');

  if (pnpmUsable) {
    return spawnPrimary();
  }

  if (!existsSync(forgeBin)) {
    throw new Error(
      `E2E launcher: pnpm is unusable in this environment and the electron-forge binary was not found at ${forgeBin}`,
    );
  }

  console.log('E2E launcher: pnpm rejected the environment; using direct-node fallback chain');
  const steps = [
    'node scripts/i18n-compile.js || true',
    'node live-browser/build.mjs || true',
    isWin ? `call "${forgeBin}" start` : `exec "${forgeBin}" start`,
  ];
  const child = spawn(isWin ? 'cmd' : '/bin/bash', [isWin ? '/c' : '-c', steps.join(' && ')], {
    cwd: desktopDir,
    stdio: 'pipe',
    detached: !isWin,
    env: commonEnv,
  });
  drain(child);
  return child;
}

/**
 * Keeps piped stdio flowing so the child never blocks on a full pipe
 * buffer (Playwright does not read these streams unless DEBUG_TESTS is set).
 */
function drain(child: ChildProcess): void {
  child.stdout?.resume();
  child.stderr?.resume();
}

/** Kills the whole process group of a detached child (best effort). */
export function killTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }
    }
  } catch {
    /* already dead */
  }
}
