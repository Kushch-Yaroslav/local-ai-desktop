import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, readJson, nowIso } from './util';
import type { LadArea, LadRegion, LadRegionStatus, LadWorkspaceSettings } from '../shared/types';
import { LAD_DEFAULT_WORKSPACE, LAD_REGION_STATUSES, ladValidateWorkspace } from '../shared/types';

type LadEventEntry = {
  at: string;
  source: 'user' | 'agent' | 'runtime';
  action: string;
  status?: LadRegionStatus;
};

export interface LadConversationState {
  conversationId: string;
  areas: LadArea[];
  regions: LadRegion[];
  workspace: LadWorkspaceSettings;
  updatedAt: string;
}

/**
 * Per-conversation JSON store. The runtime process is the single writer;
 * the renderer only reads through the control API. Files live under
 * <dataDir>/conversations/<conversationId>/.
 */
export class LadStore {
  constructor(private readonly dataDir: string) {}

  private convDir(conversationId: string): string {
    // Conversation ids come from the renderer; keep them path-safe.
    const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120) || 'default';
    return join(this.dataDir, 'conversations', safe);
  }

  async load(conversationId: string): Promise<LadConversationState> {
    const dir = this.convDir(conversationId);
    const [areas, regions, workspace] = await Promise.all([
      readJson<LadArea[]>(join(dir, 'areas.json'), []),
      readJson<LadRegion[]>(join(dir, 'regions.json'), []),
      readJson<LadWorkspaceSettings>(join(dir, 'workspace.json'), LAD_DEFAULT_WORKSPACE),
    ]);
    return {
      conversationId,
      areas,
      regions,
      workspace: ladValidateWorkspace(workspace),
      updatedAt: nowIso(),
    };
  }

  async save(conversationId: string, state: LadConversationState): Promise<void> {
    const dir = this.convDir(conversationId);
    state.updatedAt = nowIso();
    await Promise.all([
      atomicWrite(join(dir, 'areas.json'), JSON.stringify(state.areas, null, 2)),
      atomicWrite(join(dir, 'regions.json'), JSON.stringify(state.regions, null, 2)),
      atomicWrite(join(dir, 'workspace.json'), JSON.stringify(state.workspace, null, 2)),
    ]);
  }

  async saveEvidence(conversationId: string, id: string, value: unknown): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid evidence ID');
    const dir = join(this.convDir(conversationId), 'evidence');
    const entries = await readdir(dir).catch(() => []);
    let bytes = 0;
    for (const entry of entries) bytes += (await stat(join(dir, entry))).size;
    const data = JSON.stringify(value);
    if (data.length > 2_000_000 || bytes + data.length > 32_000_000)
      throw new Error('Historical evidence quota reached (32 MB per conversation)');
    await atomicWrite(join(dir, id + '.json'), data);
  }
  async copyEvidence(from: string, to: string): Promise<void> {
    const dir = join(this.convDir(from), 'evidence');
    for (const name of await readdir(dir).catch(() => [])) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
      const value = await readJson(join(dir, name), null);
      if (value) await this.saveEvidence(to, name.slice(0, -5), value);
    }
  }
  async evidence(conversationId: string, id: string): Promise<unknown> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid evidence ID');
    return readJson(join(this.convDir(conversationId), 'evidence', id + '.json'), null);
  }

  /** In-memory helper used by the runtime to mutate consistently. */
  static appendEvent(target: { events: LadEventEntry[] }, event: Omit<LadEventEntry, 'at'>): void {
    target.events.push({ at: nowIso(), ...event });
    // Keep the bounded history (most recent last).
    if (target.events.length > 200) target.events.splice(0, target.events.length - 200);
  }

  static setAreaStatus(
    area: LadArea,
    status: string,
    source: 'user' | 'agent' | 'runtime',
    note?: string
  ): void {
    if (!(LAD_REGION_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`unknown-status: ${status}`);
    }
    const typedStatus = status as LadRegionStatus;
    if (area.verification) {
      area.verification = {
        ...area.verification,
        outcome: 'Not Verified',
        reason: 'Explicit status change; recheck required',
      };
    }
    area.status = typedStatus;
    area.statusSource = source;
    area.updatedAt = nowIso();
    LadStore.appendEvent(area, {
      source,
      action: note ? `status:${status} (${note})` : `status:${status}`,
      status: typedStatus,
    });
    if (area.check !== undefined) area.check = undefined;
  }
}
