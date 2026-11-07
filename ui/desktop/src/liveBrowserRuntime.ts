/**
 * Local AI Desktop — Live Browser runtime manager (Electron main process).
 *
 * Spawns the self-contained Live Browser runtime (live-browser/dist/live-browser.js)
 * as a plain Node child process, parses its single JSON boot line and exposes the
 * loopback endpoint + bearer token to the renderer via IPC.
 *
 * The runtime owns ONE real Playwright Page per chat (system Chrome) that both the
 * Goose agent (via MCP browser_* tools) and the Live Browser UI (via the SSE
 * screencast) observe. Hiding the panel never stops the runtime.
 *
 * Node resolution order (first working wins, probed with `node -e`):
 *   1. LAD_LB_NODE env override (explicit node executable)
 *   2. dev: the Electron binary itself with ELECTRON_RUN_AS_NODE=1
 *   3. the app's bundled node launcher (src/bin/node → hermit-provisioned node),
 *      which is the mechanism Goose already uses for MCP stdio servers
 *   4. `node` from PATH (developer machines)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface LiveBrowserEndpoint {
  url: string;
  port: number;
  token: string;
  dataDir: string;
  headless: boolean;
  chrome: string;
}

export interface LiveBrowserStatus {
  running: boolean;
  endpoint: LiveBrowserEndpoint | null;
  node: string | null;
  script: string | null;
  pid: number | null;
  error: string | null;
}

interface NodeCandidate {
  label: string;
  cmd: string;
  env: Record<string, string>;
  needsArgs: boolean;
}

function runtimeScriptPath(): string {
  // Dev: <repo>/ui/desktop/src/liveBrowserRuntime.ts → live-browser/dist/live-browser.js
  // Packaged: .vite/build/main.js → resources/live-browser/dist/live-browser.js
  const devPath = path.join(__dirname, '..', '..', 'live-browser', 'dist', 'live-browser.js');
  if (existsSync(devPath)) return devPath;
  const packagedPath = path.join(process.resourcesPath, 'live-browser', 'dist', 'live-browser.js');
  return packagedPath;
}

function bundledNodeLauncherPath(): string | null {
  // Dev: <repo>/ui/desktop/src/bin/node ; Packaged: resources/bin/node
  const devLauncher = path.join(__dirname, '..', '..', 'bin', 'node');
  if (existsSync(devLauncher)) return devLauncher;
  const packagedLauncher = path.join(process.resourcesPath, 'bin', 'node');
  if (existsSync(packagedLauncher)) return packagedLauncher;
  return null;
}

function probeNode(cmd: string, env: Record<string, string>, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    let child: ChildProcess;
    try {
      child = spawn(cmd, ['-e', 'process.exit(0)'], {
        env: { ...process.env, ...env },
        stdio: 'ignore',
      });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead
      }
      finish(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

export class LiveBrowserRuntimeManager {
  private child: ChildProcess | null = null;
  private endpoint: LiveBrowserEndpoint | null = null;
  private nodeCmd: string | null = null;
  private nodeEnv: Record<string, string> = {};
  private starting: Promise<LiveBrowserEndpoint> | null = null;
  private lastError: string | null = null;
  private readonly token: string;
  private readonly dataDir: string;
  private readonly log: (message: string) => void;

  constructor(log: (message: string) => void) {
    this.log = log;
    this.token = randomBytes(24).toString('hex');
    this.dataDir = path.join(app.getPath('userData'), 'live-browser');
  }

  private scriptPath(): string {
    return runtimeScriptPath();
  }

  private nodeCandidates(): NodeCandidate[] {
    const candidates: NodeCandidate[] = [];
    const override = (process.env.LAD_LB_NODE ?? '').trim();
    if (override) {
      candidates.push({ label: 'LAD_LB_NODE', cmd: override, env: {}, needsArgs: false });
    }
    if (!app.isPackaged) {
      candidates.push({
        label: 'electron-run-as-node',
        cmd: process.execPath,
        env: { ELECTRON_RUN_AS_NODE: '1' },
        needsArgs: false,
      });
    }
    const launcher = bundledNodeLauncherPath();
    if (launcher) {
      candidates.push({ label: 'bundled-node-launcher', cmd: launcher, env: {}, needsArgs: false });
    }
    candidates.push({ label: 'node-on-PATH', cmd: 'node', env: {}, needsArgs: false });
    return candidates;
  }

  private async resolveNode(): Promise<{ cmd: string; env: Record<string, string>; label: string }> {
    if (this.nodeCmd) {
      return { cmd: this.nodeCmd, env: this.nodeEnv, label: 'cached' };
    }
    for (const candidate of this.nodeCandidates()) {
      const ok = await probeNode(candidate.cmd, candidate.env);
      if (ok) {
        this.nodeCmd = candidate.cmd;
        this.nodeEnv = candidate.env;
        this.log(`[live-browser] using node runtime: ${candidate.label} (${candidate.cmd})`);
        return { cmd: candidate.cmd, env: candidate.env, label: candidate.label };
      }
    }
    throw new Error('no working node runtime found for the Live Browser runtime');
  }

  async start(): Promise<LiveBrowserEndpoint> {
    if (this.endpoint && this.child && !this.child.killed) {
      return this.endpoint;
    }
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const node = await this.resolveNode();
      const script = this.scriptPath();
      if (!existsSync(script)) {
        throw new Error(`live-browser runtime bundle missing: ${script} (run: pnpm --dir ui/desktop live-browser:build)`);
      }
      const child = spawn(node.cmd, [script], {
        env: {
          ...process.env,
          ...node.env,
          LAD_LB_TOKEN: this.token,
          LAD_LB_DATA_DIR: this.dataDir,
          LAD_LB_HEADLESS: (process.env.LAD_LB_HEADLESS ?? 'true') as string,
          ...(process.env.LAD_LB_CHROME_PATH ? { LAD_LB_CHROME_PATH: process.env.LAD_LB_CHROME_PATH } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      this.lastError = null;

      return await new Promise<LiveBrowserEndpoint>((resolve, reject) => {
        const bootTimeout = setTimeout(() => {
          reject(new Error('live-browser runtime did not emit a boot line within 20s'));
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 20_000);
        let stdoutBuf = '';
        let settled = false;
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(bootTimeout);
          this.lastError = message;
          this.endpoint = null;
          this.child = null;
          reject(new Error(message));
        };
        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf8');
          let idx: number;
          while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
            const line = stdoutBuf.slice(0, idx).trim();
            stdoutBuf = stdoutBuf.slice(idx + 1);
            if (!line) continue;
            if (!line.startsWith('{')) {
              this.log(`[live-browser] ${line}`);
              continue;
            }
            try {
              const boot = JSON.parse(line) as {
                ok: boolean;
                port: number;
                token?: string;
                dataDir?: string;
                headless?: boolean;
                chrome?: string;
              };
              if (!boot.ok || typeof boot.port !== 'number') {
                fail(`unexpected boot line: ${line}`);
                return;
              }
              const endpoint: LiveBrowserEndpoint = {
                url: `http://127.0.0.1:${boot.port}`,
                port: boot.port,
                token: boot.token ?? this.token,
                dataDir: boot.dataDir ?? this.dataDir,
                headless: boot.headless ?? true,
                chrome: boot.chrome ?? 'auto',
              };
              if (settled) return;
              settled = true;
              clearTimeout(bootTimeout);
              this.endpoint = endpoint;
              this.log(`[live-browser] runtime ready at ${endpoint.url} (pid ${child.pid})`);
              resolve(endpoint);
            } catch {
              fail(`invalid boot line JSON: ${line}`);
            }
            return;
          }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8').trim();
          if (text) this.log(`[live-browser:stderr] ${text}`);
        });
        child.on('error', (error) => fail(`spawn error: ${error.message}`));
        child.on('exit', (code, signal) => {
          this.log(`[live-browser] runtime exited code=${code} signal=${signal}`);
          if (!settled) fail(`runtime exited during boot (code=${code} signal=${signal})`);
          this.endpoint = null;
          this.child = null;
        });
      });
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Stop the runtime (app quit / user request). Idempotent. */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 3000);
    killTimer.unref?.();
  }

  status(): LiveBrowserStatus {
    const alive = this.child && !this.child.killed;
    return {
      running: Boolean(alive && this.endpoint),
      endpoint: alive ? this.endpoint : null,
      node: this.nodeCmd,
      script: this.scriptPath(),
      pid: this.child?.pid ?? null,
      error: this.lastError,
    };
  }
}
