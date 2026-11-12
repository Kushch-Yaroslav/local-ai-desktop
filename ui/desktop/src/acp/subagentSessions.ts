// Local AI Desktop: metadata only; histories stay in the existing ACP session store.
import { useEffect, useSyncExternalStore } from 'react';
import { getAcpClient, subscribeToAcpRecovery } from './acpConnection';
import type { SessionInfo } from '@agentclientprotocol/sdk';

export const SUBAGENT_UPDATED = 'goose:subagent-updated';
export type SubagentStatus =
  'waiting' | 'running' | 'compacting' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface SubagentSession {
  id: string;
  parentId: string;
  title: string;
  createdAt?: string;
  status: SubagentStatus;
  contextLimit?: number;
  totalTokens?: number;
  compactions?: number;
  lastCompactionAt?: string;
  updatedAt?: string;
}
const entries = new Map<string, SubagentSession>();
const parents = new Map<string, string>();
const deletedSessionIds = new Set<string>();
const listeners = new Set<() => void>();
const pending = new Map<string, Promise<void>>();
const runtimePhases = new Map<string, string>();
let unsubscribeRuntime: (() => void) | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  unsubscribeRuntime ??= window.electron?.ggufOnInference?.((event) => {
    if (!event.sessionId || !['waiting', 'admitted', 'released', 'cancelled'].includes(event.phase))
      return;
    if (event.phase === 'released' || event.phase === 'cancelled')
      runtimePhases.delete(event.sessionId);
    else runtimePhases.set(event.sessionId, event.phase);
    notify();
  });
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeRuntime?.();
      unsubscribeRuntime = undefined;
    }
  };
}
let revision = 0;
const statuses = new Set([
  'waiting',
  'running',
  'compacting',
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);
function notify() {
  revision++;
  listeners.forEach((listener) => listener());
}
export function receiveSubagent(raw: unknown) {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as SubagentSession;
  if (
    typeof value.id !== 'string' ||
    typeof value.parentId !== 'string' ||
    !statuses.has(value.status)
  )
    return;
  if (deletedSessionIds.has(value.id) || deletedSessionIds.has(value.parentId)) return;
  const previous = entries.get(value.id);
  if (previous?.updatedAt && (!value.updatedAt || previous.updatedAt > value.updatedAt)) return;
  entries.set(value.id, {
    ...value,
    title: typeof value.title === 'string' ? value.title : value.id,
    createdAt: value.createdAt ?? previous?.createdAt,
  });
  parents.set(value.id, value.parentId);
  if (['completed', 'failed', 'cancelled'].includes(value.status)) runtimePhases.delete(value.id);
  notify();
  window.dispatchEvent(new CustomEvent(SUBAGENT_UPDATED, { detail: value }));
}

export function forgetSubagentSessions(sessionIds: Iterable<string>) {
  const removed = new Set(sessionIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries.values()) {
      if (removed.has(entry.parentId) && !removed.has(entry.id)) {
        removed.add(entry.id);
        changed = true;
      }
    }
  }

  for (const id of removed) {
    deletedSessionIds.add(id);
    entries.delete(id);
    parents.delete(id);
    runtimePhases.delete(id);
  }
  notify();
}
function ingest(info: SessionInfo) {
  const meta = (info._meta ?? {}) as {
    parentSessionId?: string;
    subagent?: unknown;
    children?: SessionInfo[];
    createdAt?: string;
  };
  if (meta.parentSessionId) {
    parents.set(String(info.sessionId), meta.parentSessionId);
    receiveSubagent({
      ...((meta.subagent ?? {
        id: String(info.sessionId),
        parentId: meta.parentSessionId,
        title: info.title ?? String(info.sessionId),
        status: 'unknown',
      }) as object),
      createdAt: meta.createdAt,
    });
  }
  meta.children?.forEach(ingest);
  notify();
  return meta.parentSessionId;
}
async function hydrate(id: string): Promise<void> {
  if (pending.has(id)) return pending.get(id);
  const task = (async () => {
    const client = await getAcpClient();
    const result = await client.goose.sessionInfo_unstable({ sessionId: id });
    const parent = ingest(result.session);
    if (parent && parent !== id) await hydrate(parent);
  })().finally(() => pending.delete(id));
  pending.set(id, task);
  return task;
}
export function useSubagentFamily(sessionId: string) {
  useSyncExternalStore(subscribe, () => revision);
  useEffect(() => {
    if (!sessionId) return;
    void hydrate(sessionId).catch(() => {});
    return subscribeToAcpRecovery((recovering) => {
      if (!recovering) void hydrate(sessionId).catch(() => {});
    });
  }, [sessionId]);
  const parentId = parents.get(sessionId) ?? sessionId;
  return {
    parentId,
    children: [...entries.values()]
      .filter((entry) => entry.parentId === parentId)
      .map((entry) =>
        entry.status === 'running' && runtimePhases.get(entry.id) === 'waiting'
          ? { ...entry, status: 'waiting' as const }
          : entry
      )
      .sort((a, b) =>
        a.createdAt && b.createdAt
          ? a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
          : a.id.localeCompare(b.id)
      ),
  };
}
