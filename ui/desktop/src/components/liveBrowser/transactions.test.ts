/** Regression: async capture/recheck must not lose concurrent chat-local edits. */
import { test, expect } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegionService } from '../../../live-browser/runtime/regions';
import { LadStore } from '../../../live-browser/runtime/store';
import type { BrowserManager } from '../../../live-browser/runtime/browser';
import type { LadRegion } from '../../../live-browser/shared/types';

function testManager(): BrowserManager {
  return {
    on: () => undefined,
    pageOf: () => null,
  } as unknown as BrowserManager;
}
test('serializes mutations in one conversation while preserving independent chats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lad-transaction-test-'));
  try {
    const store = new LadStore(dir),
      service = new RegionService(testManager(), store, { emit: () => {} });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        service.createArea(i < 10 ? 'chat-a' : 'chat-b', { name: `Area ${i}` })
      )
    );
    const a = await service.list('chat-a'),
      b = await service.list('chat-b');
    expect(a.areas).toHaveLength(10);
    expect(b.areas).toHaveLength(2);
    expect((await stat(join(dir, 'conversations', 'chat-a', 'areas.json'))).mode & 0o777).toBe(
      0o600
    );
    expect(new Set(a.areas.map((area) => area.number)).size).toBe(10);
    await Promise.all([
      service.updateArea('chat-a', a.areas[0].id, { name: 'Retained rename' }),
      service.workflow('chat-a', a.areas[0].id, 'completed'),
    ]);
    const saved = await service.list('chat-a');
    expect(saved.areas[0].name).toBe('Retained rename');
    expect(saved.areas[0].workflow?.state).toBe('completed');
    expect(saved.areas[0].status).toBe('Detected');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editing acceptance or manually setting status invalidates current proof but preserves ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lad-proof-test-'));
  try {
    const store = new LadStore(dir);
    const service = new RegionService(testManager(), store, { emit: () => {} });
    const area = await service.createArea('chat', { name: 'Target' });
    const state = await store.load('chat');
    const proof = {
      id: 'proof',
      at: new Date().toISOString(),
      outcome: 'Verified' as const,
      regions: [],
      errors: [],
    };
    state.areas[0].status = 'Verified';
    state.areas[0].verification = proof;
    state.areas[0].ledger = [proof];
    await store.save('chat', state);
    const edited = await service.updateArea('chat', area.id, {
      description: 'A different requirement',
    });
    expect(edited.status).toBe('Fixed');
    expect(edited.verification?.outcome).toBe('Not Verified');
    expect(edited.ledger?.[0].outcome).toBe('Verified');
    edited.verification = proof;
    LadStore.setAreaStatus(edited, 'Unresolved', 'user');
    expect(edited.verification?.outcome).toBe('Not Verified');
    expect(edited.ledger?.[0].outcome).toBe('Verified');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remove all clears only the current chat and its referenced captures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lad-remove-areas-test-'));
  try {
    const store = new LadStore(dir);
    const service = new RegionService(testManager(), store, { emit: () => {} });
    const currentArea = await service.createArea('chat-a', { name: 'Current chat area' });
    const otherArea = await service.createArea('chat-b', { name: 'Other chat area' });
    const timestamp = new Date().toISOString();
    const region = {
      id: 'region-a',
      conversationId: 'chat-a',
      areaId: currentArea.id,
      url: 'https://example.test/products',
      route: '/products',
      viewport: { width: 1280, height: 800 },
      dpr: 1,
      scroll: { x: 0, y: 0 },
      rect: { x: 10, y: 10, width: 100, height: 80 },
      anchors: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      snapshot: 'snapshot-a',
      diagnostics: [],
      events: [],
      history: [
        {
          id: 'evidence-a',
          at: timestamp,
          kind: 'selection' as const,
          url: 'https://example.test/products',
          viewport: { width: 1280, height: 800 },
          snapshot: 'snapshot-a',
          anchors: [],
          rect: { x: 10, y: 10, width: 100, height: 80 },
          cropId: 'capture-a',
          diagnostics: [],
        },
      ],
    } satisfies LadRegion;
    const stateA = await store.load('chat-a');
    stateA.areas[0].regionIds = [region.id];
    stateA.regions = [region];
    await store.save('chat-a', stateA);
    await store.saveEvidence('chat-a', 'capture-a', { data: 'current capture' });
    await store.saveEvidence('chat-b', 'capture-b', { data: 'other capture' });

    await expect(service.removeAllAreas('chat-a')).resolves.toEqual({
      areaCount: 1,
      regionCount: 1,
      captureCount: 1,
    });
    expect((await store.load('chat-a')).areas).toEqual([]);
    expect((await store.load('chat-a')).regions).toEqual([]);
    expect(await store.evidence('chat-a', 'capture-a')).toBeNull();
    expect((await store.load('chat-b')).areas.map((item) => item.id)).toContain(otherArea.id);
    expect(await store.evidence('chat-b', 'capture-b')).toEqual({ data: 'other capture' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
