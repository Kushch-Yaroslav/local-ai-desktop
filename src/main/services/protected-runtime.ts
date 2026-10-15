import { agentRuntimeEnvironment } from './agent-environment';
import { readFileSync, readlinkSync, readdirSync, existsSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, agentRuntimePath } from './paths';
import { effectiveRuntimeConfiguration, executablePath } from './runtime-settings';

export type ProcessIdentity = { pid: number; startTime: string; executable: string; role: string; ppid: number; pgid: number; sessionId: number; state: string; lifecycle: string; endpoints: string[] };
export function processIdentity(pid: number, role: string): ProcessIdentity | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z') return null;
    return { pid, role, startTime: fields[19], executable: readlinkSync(`/proc/${pid}/exe`), ppid: Number(fields[1]), pgid: Number(fields[2]), sessionId: Number(fields[3]), state: fields[0], lifecycle: 'running', endpoints: [] };
  } catch { return null; }
}

/** Host-owned registry. Numeric PIDs are never accepted as cleanup authority. */
export class ProtectedRuntimeRegistry {
  private readonly registered = new Map<number, ProcessIdentity>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly endpoints = new Set<string>();
  private previous = new Map<string, ProcessIdentity>();
  readonly file: string;
  constructor(private readonly runtimeRoot = paths.dataRoot) { this.file = join(runtimeRoot, 'protected-runtime.json'); }
  register(pid: number | undefined, role: string): void {
    if (!pid) return;
    const identity = processIdentity(pid, role);
    if (identity) this.registered.set(pid, identity);
    this.refresh();
  }
  retire(pid: number | undefined): void { if (pid) this.registered.delete(pid); this.refresh(); }
  endpoint(endpoint: string): void { this.endpoints.clear(); if (endpoint) this.endpoints.add(endpoint); }
  start(): void {
    this.register(process.pid, 'electron-main');
    this.refresh();
    this.timer ??= setInterval(() => this.refresh(), 500);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  refresh(): ProcessIdentity[] {
    const records: ProcessIdentity[] = [];
    for (const [pid, saved] of this.registered) {
      const live = processIdentity(pid, saved.role);
      if (!live || live.startTime !== saved.startTime || live.executable !== saved.executable) { this.registered.delete(pid); continue; }
      records.push(live);
    }
    // A state file is evidence only while its owning launcher is alive.
    try {
      const state = JSON.parse(readFileSync(join(this.runtimeRoot, 'llama-cpp-runtime-state.json'), 'utf8'));
      const launcher = processIdentity(state.launcherPid, 'runtime-launcher');
      const args = readFileSync(`/proc/${state.launcherPid}/cmdline`, 'utf8');
      if (launcher && (!state.launcherStartTime || state.launcherStartTime === launcher.startTime) && args.includes('run-local-ai-desktop-llama-cpp-mtp.sh')) {
        records.push(launcher);
        const server = processIdentity(state.serverPid, 'llama-server');
        if (server && server.ppid === launcher.pid && (!state.serverStartTime || state.serverStartTime === server.startTime)) {
          const argv = readFileSync(`/proc/${server.pid}/cmdline`, 'utf8').split('\0');
          if (argv.includes('--ctx-size') && argv.includes('--port')) {
            const host = argv[argv.indexOf('--host') + 1] || '127.0.0.1';
            const port = argv[argv.indexOf('--port') + 1];
            server.endpoints = listenerEndpoints(server.pid);
            server.lifecycle = state.status;
            if (!server.endpoints.length) server.endpoints = [`pending:http://${host}:${port}`];
            records.push(server);
          }
        }
      }
    } catch { /* Idle/offline or atomically replaced state. */ }
    // Protect infrastructure descendants, not terminal tasks: tasks are children
    // of bwrap and are outside the host PID namespace used by tool commands.
    const all = readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => processIdentity(Number(name), 'infrastructure-child')).filter((p): p is ProcessIdentity => p !== null);
    for (const endpoint of this.endpoints) {
      try {
        const url = new URL(endpoint);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) continue;
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        const hosts = ['[hex:00000000000000000000000000000000]', '[hex:00000000000000000000000001000000]'];
        if (url.hostname !== '[::1]') hosts.push('127.0.0.1', '0.0.0.0');
        const matchesEndpoint = (address: string) => hosts.some(host => address === `tcp://${host}:${port}`);
        if (records.some(record => record.endpoints.some(matchesEndpoint))) continue;
        // Protect the process actually serving the configured local endpoint.
        // This association never grants agent ownership or cleanup authority.
        if (!['tcp', 'tcp6'].some(protocol => readFileSync(`/proc/net/${protocol}`, 'utf8').split('\n').some(line => {
          const fields = line.trim().split(/\s+/); return fields[3] === '0A' && parseInt(fields[1]?.split(':')[1], 16) === port;
        }))) continue;
        for (const process of all) {
          const addresses = listenerEndpoints(process.pid).filter(matchesEndpoint);
          if (addresses.length && !records.some(record => record.pid === process.pid)) records.push({ ...process, role: 'model-serving-endpoint', endpoints: addresses });
        }
      } catch { /* Remote/unavailable endpoint has no local process identity. */ }
    }
    const parents = new Set(records.filter(p => p.role === 'electron-main').map(p => p.pid));
    for (let changed = true; changed;) {
      changed = false;
      for (const p of all) {
        if (parents.has(p.ppid) && !parents.has(p.pid) && !p.executable.endsWith('/bwrap') && !p.executable.endsWith('/local-ai-agent-runtime')) {
          parents.add(p.pid); if (!records.some(r => r.pid === p.pid)) records.push(p); changed = true;
        }
      }
    }
    const snapshot = { bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), updatedAt: new Date().toISOString(), configuredEndpoints: [...this.endpoints], processes: records, protectedPaths: protectedInfrastructurePaths() };
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 }); renameSync(temporary, this.file);
      const current = new Map(records.map(record => [`${record.pid}:${record.startTime}:${record.executable}:${record.role}`, record]));
      const events = [...current].flatMap(([key, record]) => !this.previous.has(key) ? [{ event: 'registered', process: record }]
        : JSON.stringify(record.endpoints) !== JSON.stringify(this.previous.get(key)!.endpoints) || record.lifecycle !== this.previous.get(key)!.lifecycle ? [{ event: 'updated', process: record }] : []);
      for (const [key, record] of this.previous) if (!current.has(key)) events.push({ event: 'retired', process: { ...record, lifecycle: 'retired' } });
      if (events.length) appendFileSync(join(this.runtimeRoot, 'protected-runtime-events.jsonl'), events.map(event => JSON.stringify({ ...event, bootId: snapshot.bootId, at: snapshot.updatedAt })).join('\n') + '\n', { mode: 0o600 });
      this.previous = current;
    }
    catch (error) { console.error('Protected runtime registry persistence failed:', error); }
    return records;
  }
  environment(restrictedPath = false): NodeJS.ProcessEnv {
    this.refresh();
    return { ...agentRuntimeEnvironment(process.env, restrictedPath), LOCAL_AI_PROTECTED_REGISTRY: this.file, LOCAL_AI_PROTECTED_PATHS: JSON.stringify(protectedInfrastructurePaths()) };
  }
}

export function protectedInfrastructurePaths(): string[] {
  const configuration = effectiveRuntimeConfiguration();
  const server = configuration.llamaServerPath;
  let serverExecutable: string[] = [];
  try { if (server) serverExecutable = [executablePath(server)]; } catch { /* Not configured yet. */ }
  return [paths.dataRoot, paths.configDirectory, paths.logs, paths.models,
    configuration.modelsPath, ...configuration.models.flatMap(model => [model.modelPath, model.mmprojPath].filter(Boolean)), ...serverExecutable,
    join(paths.root, 'dist'), join(paths.root, 'node_modules/electron'),
    join(paths.root, 'run-local-ai-desktop-llama-cpp-mtp.sh'), agentRuntimePath()]
    .filter(path => existsSync(path));
}

/** Associate a socket with its process via inode, never infer task ownership from a port. */
function listenerEndpoints(pid: number): string[] {
  try {
    const inodes = new Set(readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
      try { return [readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1]]; } catch { return []; }
    }));
    return ['tcp', 'tcp6'].flatMap(protocol => readFileSync(`/proc/${pid}/net/${protocol}`, 'utf8').split('\n').slice(1).flatMap(line => {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '0A' || !inodes.has(fields[9])) return [];
      const [address, port] = fields[1].split(':');
      const host = protocol === 'tcp' ? address.match(/../g)!.reverse().map(byte => parseInt(byte, 16)).join('.') : `[hex:${address}]`;
      return [`tcp://${host}:${parseInt(port, 16)}`];
    }));
  } catch { return []; }
}

export const protectedRuntime = new ProtectedRuntimeRegistry();
