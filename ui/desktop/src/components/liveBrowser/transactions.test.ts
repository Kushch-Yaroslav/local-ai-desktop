/** Regression: async capture/recheck must not lose concurrent chat-local edits. */
import { test, expect } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegionService } from '../../../live-browser/runtime/regions';
import { LadStore } from '../../../live-browser/runtime/store';
import type { BrowserManager } from '../../../live-browser/runtime/browser';
test('serializes mutations in one conversation while preserving independent chats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lad-transaction-test-'));
  try {
    const store = new LadStore(dir),
      service = new RegionService({} as BrowserManager, store, { emit: () => {} });
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
    const service = new RegionService({} as BrowserManager, store, { emit: () => {} });
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
