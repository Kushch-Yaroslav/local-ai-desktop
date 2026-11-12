import { describe, expect, it } from 'vitest';
import { parseLlamaServerRuntimeContext } from './managedGguf';

describe('managed llama-server runtime context', () => {
  it.each([70, 112, 170])('preserves the measured %i Ki-token request limit', (kib) => {
    const contextTokens = kib * 1024;
    expect(
      parseLlamaServerRuntimeContext(
        'profile-1',
        {
          total_slots: 4,
          default_generation_settings: { n_ctx: contextTokens },
        },
        ['--ctx-size', String(contextTokens), '--kv-unified']
      )
    ).toMatchObject({
      profileId: 'profile-1',
      contextTokens,
      totalSlots: 4,
      kvUnified: true,
      maxConcurrentRequests: 1,
    });
  });

  it('uses the actual per-slot context and slot count for independent KV caches', () => {
    expect(
      parseLlamaServerRuntimeContext(
        'profile-2',
        {
          total_slots: 3,
          default_generation_settings: { n_ctx: 32 * 1024 },
        },
        ['--ctx-size', String(96 * 1024), '--parallel', '3', '--no-kv-unified']
      )
    ).toMatchObject({
      contextTokens: 32 * 1024,
      totalSlots: 3,
      kvUnified: false,
      maxConcurrentRequests: 3,
    });
  });

  it('serializes when an older runtime does not expose its KV policy', () => {
    expect(
      parseLlamaServerRuntimeContext(
        'profile-3',
        { total_slots: 4, default_generation_settings: { n_ctx: 16 * 1024 } },
        ['--ctx-size', String(64 * 1024)]
      )
    ).toMatchObject({ kvUnified: null, maxConcurrentRequests: 1 });
  });

  it('rejects metadata context in place of live request properties', () => {
    expect(parseLlamaServerRuntimeContext('profile-4', { n_ctx_train: 262144 }, [])).toBeNull();
  });
});
