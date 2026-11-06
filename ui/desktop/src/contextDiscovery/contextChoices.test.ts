import { describe, it, expect } from 'vitest';
import { contextChoices } from './contextChoices';
import type { ContextDiscoveryOption } from './contextEstimator';
const result = (contextWindow: number, kvCacheType: 'f16' | 'q8_0', extras = {}) =>
  ({ contextWindow, kvCacheType, discoveredAt: '2026-11-05T12:00:00Z', ...extras }) as ContextDiscoveryOption;
describe('context choice presentation', () => {
  it('shows only the selected precision while retaining the other result for the next toggle', () => {
    const registry = [result(53248, 'f16'), result(90112, 'q8_0')];
    const fp16 = contextChoices(262144, registry, [], 'f16');
    expect(fp16.map((c) => c.tokens)).toEqual([16384, 32768, 53248, 65536, 131072, 262144]);
    expect(fp16.filter((c) => c.kv).map((c) => c.kv)).toEqual(['f16']);

    const q8 = contextChoices(262144, registry, [], 'q8_0');
    expect(q8.map((c) => c.tokens)).toEqual([16384, 32768, 65536, 90112, 131072, 262144]);
    expect(q8.filter((c) => c.kv).map((c) => c.kv)).toEqual(['q8_0']);
    expect(contextChoices(262144, registry, [], 'f16').find((c) => c.kv)?.tokens).toBe(53248);
  });

  it('keeps manual context out of the grid and does not mix model catalogs', () => {
    const qwen27 = [result(53248, 'f16'), result(90112, 'q8_0')];
    const qwen35 = [result(65536, 'f16'), result(106496, 'q8_0')];
    const customContext = 49152;
    const visible = contextChoices(262144, qwen27, [], 'f16');
    expect(visible.some((choice) => choice.tokens === customContext)).toBe(false);
    expect(visible.some((choice) => choice.tokens === 65536 && choice.kv === 'f16')).toBe(false);
    expect(contextChoices(262144, qwen35, [], 'f16').find((choice) => choice.kv)?.tokens).toBe(65536);
    expect(contextChoices(262144, qwen27, [], 'custom').some((choice) => choice.kv)).toBe(false);
  });
  it('never upgrades restored/stale results to verified and respects technical limits', () => {
    expect(
      contextChoices(
        131072,
        [
          result(102400, 'f16', { validation: 'confirmed' }),
          result(114688, 'q8_0', { restored: true, validation: 'confirmed' }),
        ],
        [result(65536, 'q8_0', { conditions: 'changed' }), result(262144, 'f16')],
        'f16'
      )
        .filter((c) => c.kv)
        .map((c) => c.status)
    ).toEqual(['verified']);
    expect(
      contextChoices(131072, [result(114688, 'q8_0', { restored: true, validation: 'confirmed' })], [], 'q8_0')
        .find((choice) => choice.kv)?.status
    ).toBe('saved');
  });
});
