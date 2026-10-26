import { resolve } from 'node:path';

export type ManagedPreviewTask = {
  taskId: string;
  runId: string;
  projectRoot: string;
  cwd: string;
  command: string;
  state: 'starting' | 'ready' | 'failed' | 'stopped';
  confirmedActive: boolean;
  url?: string;
  pid?: number;
  pgid?: number;
  observedAt: number;
  error?: string;
};

export type ManagedTaskCall = { action?: string; taskId?: string; command?: string };

function loopbackUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.port || url.username || url.password) return undefined;
    return url;
  } catch { return undefined; }
}

function viteCommand(command: string): boolean {
  return /(?:^|[\s/&])vite(?:[\s./]|$)/i.test(command)
    || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start)\b/i.test(command);
}

function taskFrom(value: unknown, call: ManagedTaskCall, projectRoot: string, runId: string, observedAt: number): ManagedPreviewTask | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const taskId = typeof raw.task_id === 'string' ? raw.task_id : call.taskId;
  if (!taskId) return undefined;
  const command = typeof raw.command === 'string' ? raw.command : call.command ?? '';
  const cwd = typeof raw.cwd === 'string' ? resolve(raw.cwd) : resolve(projectRoot);
  const stateValue = raw.state;
  const state: ManagedPreviewTask['state'] = stateValue === 'ready' ? 'ready' : stateValue === 'failed' ? 'failed' : stateValue === 'stopped' ? 'stopped' : 'starting';
  const url = loopbackUrl(raw.url)?.href;
  return {
    taskId, runId, projectRoot: resolve(projectRoot), cwd, command, state,
    confirmedActive:call.action==='list'||call.action==='status',
    ...(url ? { url } : {}),
    ...(typeof raw.pid === 'number' ? { pid: raw.pid } : {}),
    ...(typeof raw.pgid === 'number' ? { pgid: raw.pgid } : {}),
    observedAt, ...(typeof raw.diagnostic === 'string' ? { error: raw.diagnostic.slice(0, 260) } : {}),
  };
}

/** Called only for structured results emitted by the in-process Rust task registry. */
export function updateManagedPreviewTasks(
  records: Map<string, ManagedPreviewTask>, rawResult: unknown, call: ManagedTaskCall,
  projectRoot: string, runId: string, observedAt = Date.now(),
): void {
  let result = rawResult;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { return; }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return;
  const object = result as Record<string, unknown>;
  if (Array.isArray(object.tasks) || Array.isArray(object.recently_completed)) {
    for (const raw of [...(Array.isArray(object.tasks) ? object.tasks : []), ...(Array.isArray(object.recently_completed) ? object.recently_completed : [])]) {
      const record = taskFrom(raw, call, projectRoot, runId, observedAt);
      if (record) { const prior=records.get(record.taskId);records.set(record.taskId,{...prior,...record,command:record.command||prior?.command||''}); }
    }
    return;
  }
  const record = taskFrom(object, call, projectRoot, runId, observedAt);
  if (record) { const prior=records.get(record.taskId);records.set(record.taskId,{...prior,...record,command:record.command||prior?.command||''}); }
}

export function resolveManagedPreviewTask(
  records: ReadonlyMap<string, ManagedPreviewTask>, taskId: unknown, targetUrl: string,
  projectRoot: string, runId: string, now = Date.now(), maxAgeMs = 5_000,
): ManagedPreviewTask | undefined {
  if (typeof taskId !== 'string') return undefined;
  const record = records.get(taskId), target = loopbackUrl(targetUrl), reported = record && loopbackUrl(record.url);
  if (!record || !target || !reported || record.state !== 'ready' || !record.confirmedActive || record.runId !== runId
      || record.projectRoot !== resolve(projectRoot) || record.cwd !== resolve(projectRoot)
      || !viteCommand(record.command) || now < record.observedAt || now - record.observedAt > maxAgeMs
      || target.port !== reported.port) return undefined;
  return record;
}

/** A bare root URL means “same app on its new server”; keep its active route. */
export function carryBrowserRoute(currentRaw: string, targetRaw: string): string {
  const current = new URL(currentRaw), target = new URL(targetRaw);
  if (current.origin !== target.origin && target.pathname === '/') {
    if (current.pathname !== '/' && !target.hash) target.pathname = current.pathname;
    if (!target.search) target.search = current.search;
    if (!target.hash) target.hash = current.hash;
  }
  return target.href;
}

export function sameBrowserRoute(a: string, b: string): boolean {
  try {
    const left = new URL(a), right = new URL(b);
    return left.pathname === right.pathname && left.search === right.search && left.hash === right.hash;
  } catch { return false; }
}
