/**
 * Local AI Desktop — Live Browser runtime manager (Electron main process).
 *
 * Spawns the self-contained Live Browser runtime (live-browser/dist/live-browser.js)
 * as a plain Node child process, parses its single JSON boot line and exposes the
 * loopback endpoint + bearer token to the renderer via IPC.
 *
 * Electron owns one native Page per chat; the runtime attaches through the
 * scoped CDP bridge for Goose MCP/grounding. SSE carries state in native mode.
 * Standalone mode retains system Chromium/screencast. Hide preserves the Page.
 *
 * Node resolution order (first working wins, probed with `node -e`):
 *   1. LAD_LB_NODE env override (explicit node executable)
 *   2. packaged: resources/live-browser/bin/node (offline, version checked)
 *   3. dev: the Electron binary itself with ELECTRON_RUN_AS_NODE=1
 *   4. the app's bundled node launcher (src/bin/node → hermit-provisioned node),
 *      which is the mechanism Goose already uses for MCP stdio servers
 *   5. `node` from PATH (developer machines)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { NativeBrowserHost } from './nativeBrowserHost';
import { probeLiveBrowserNode } from './liveBrowserNode';

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
  // Candidate locations, in priority order:
  //  1. Dev: <repo>/ui/desktop/src/liveBrowserRuntime.ts → live-browser/dist/live-browser.js
  //  2. Packaged (designed nested): resources/live-browser/dist/live-browser.js
  //  3. Packaged (flat): @electron/packager extraResource copies each entry to
  //     resources/<basename>, so `live-browser/dist/live-browser.js` lands at
  //     resources/live-browser.js, with browsers.json/package.json as siblings.
  const candidates = [
    path.join(__dirname, '..', '..', 'live-browser', 'dist', 'live-browser.js'),
    path.join(process.resourcesPath, 'live-browser', 'dist', 'live-browser.js'),
    path.join(process.resourcesPath, 'dist', 'live-browser.js'),
    path.join(process.resourcesPath, 'live-browser.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function bundledNodeLauncherPath(): string | null {
  // Dev: <repo>/ui/desktop/src/bin/node ; Packaged: resources/bin/node
  const devLauncher = path.join(__dirname, '..', '..', 'bin', 'node');
  if (existsSync(devLauncher)) return devLauncher;
  const packagedLauncher = path.join(process.resourcesPath, 'bin', 'node');
  if (existsSync(packagedLauncher)) return packagedLauncher;
  return null;
}

export class LiveBrowserRuntimeManager {
  readonly native = new NativeBrowserHost();
  private child: ChildProcess | null = null;
  private endpoint: LiveBrowserEndpoint | null = null;
  private nodeCmd: string | null = null;
  private nodeEnv: Record<string, string> = {};
  private starting: Promise<LiveBrowserEndpoint> | null = null;
  private lastError: string | null = null;
  private assignedPort: number | null = null;
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
    const packagedNode = path.join(
      process.resourcesPath,
      'live-browser',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node'
    );
    if (app.isPackaged && existsSync(packagedNode)) {
      candidates.push({
        label: 'bundled-node-executable',
        cmd: packagedNode,
        env: {},
        needsArgs: false,
      });
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

  private async resolveNode(): Promise<{
    cmd: string;
    env: Record<string, string>;
    label: string;
  }> {
    if (this.nodeCmd) {
      return { cmd: this.nodeCmd, env: this.nodeEnv, label: 'cached' };
    }
    for (const candidate of this.nodeCandidates()) {
      const ok = await probeLiveBrowserNode(candidate.cmd, candidate.env);
      if (ok) {
        this.nodeCmd = candidate.cmd;
        this.nodeEnv = candidate.env;
        this.log(`[live-browser] using node runtime: ${candidate.label} (${candidate.cmd})`);
        return { cmd: candidate.cmd, env: candidate.env, label: candidate.label };
      }
    }
    throw new Error(
      'Live Browser requires Node.js 20 or newer; no compatible runtime found. Reinstall the complete application package.'
    );
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
        throw new Error(
          `live-browser runtime bundle missing: ${script} (run: pnpm --dir ui/desktop live-browser:build)`
        );
      }
      const nativeEndpoint = await this.native.start(this.token);
      const child = spawn(node.cmd, [script], {
        env: {
          ...process.env,
          ...node.env,
          LAD_LB_TOKEN: this.token,
          ...(this.assignedPort ? { LAD_LB_PORT: String(this.assignedPort) } : {}),
          LAD_LB_NATIVE_ENDPOINT: nativeEndpoint,
          LAD_LB_DATA_DIR: this.dataDir,
          LAD_LB_HEADLESS: (process.env.LAD_LB_HEADLESS ?? 'true') as string,
          ...(process.env.LAD_LB_CHROME_PATH
            ? { LAD_LB_CHROME_PATH: process.env.LAD_LB_CHROME_PATH }
            : {}),
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
          if (this.child === child) {
            this.endpoint = null;
            this.child = null;
          }
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
              this.assignedPort = endpoint.port;
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
          if (this.child === child) {
            this.endpoint = null;
            this.child = null;
          }
        });
      });
    })()
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** Stop the runtime (app quit / user request). Idempotent. */
  stop(): void {
    this.native.stop();
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
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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
