import { describe, expect, it } from 'vitest';
import { discoverContextBoundary, type DiscoveryProbe } from './contextDiscovery';
import { estimateHardwareSafeContext, type RuntimeContextEstimate } from './contextEstimator';
import { createVramBudget } from './vramBudget';

const GiB = 1024 ** 3;
function fixture(context: number, mode: 'f16' | 'q8_0', phase: 'base' | 'search' | 'final'): DiscoveryProbe {
  const kv = context * (mode === 'f16' ? 64 * 1024 : 34 * 1024);
  const headroom = { hostBytes: 40 * GiB, deviceBytes: 7 * GiB - kv };
  const estimate: RuntimeContextEstimate = {
    vramBudget: createVramBudget(24 * GiB, 17 * GiB + kv, headroom.deviceBytes, 17 * GiB + kv),
    backend: 'llama-cpp', modelId: 'model', configuredMaxTokens: 262144, modelTrainContextTokens: 262144,
    observedContextTokens: context, modelFileSizeBytes: 10 * GiB, observedResidentBytes: null, observedDeviceResidentBytes: null,
    hardwareSafeTokens: 262144, activeKvCacheType: mode, activeKvOffload: true,
    memoryBaseline: { hostAvailableBytes: 50 * GiB, deviceAvailableBytes: 24 * GiB }, memoryHeadroom: headroom,
    status: 'estimated', source: 'startup-log', unknownReasons: [], estimator: null,
    allocationEvidence: { contextTokens: context, sequenceSlots: 1, speculativeSlots: 1, speculativeMode: 'mtp',
      kvTypeK: mode, kvTypeV: mode, speculativeKvTypeK: mode, speculativeKvTypeV: mode, unknownReasons: [],
      allocations: { weights: { device: 10 * GiB }, compute: { device: 0 }, output: { device: 0 }, kv: { device: kv },
        speculativeWeights: { device: 0 }, speculativeCompute: { device: 0 }, speculativeKv: { device: 0 }, ssm: { device: 0 } } },
  };
  return { estimate, record: { contextWindow: context, kvCacheType: mode, phase, startup: true, health: true,
    inference: true, fits: false, headroom, memoryBaseline: estimate.memoryBaseline, elapsedMs: 1 } };
}

describe('ported donor context discovery core', () => {
  it('preserves the v0.3.2.0 reserve and candidate decisions for identical measured probes', async () => {
    const result = await discoverContextBoundary({ modelId: 'model', hardLimit: 262144, kvOffload: true,
      hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB,
      probe: async (context, mode, phase) => fixture(context, mode, phase), restore: async () => undefined,
      progress: () => undefined });
    expect(result.options.map(({ contextWindow, kvCacheType }) => ({ contextWindow, kvCacheType }))).toEqual([
      { contextWindow: 81920, kvCacheType: 'f16' },
      { contextWindow: 155648, kvCacheType: 'q8_0' },
    ]);
    expect(result.options.every((option) => option.vramBudget!.llmBytes <= option.vramBudget!.availableLlmBytes)).toBe(true);
    expect(result.probes!.some((probe) => !probe.startup && probe.reason?.includes('Пропущено'))).toBe(true);
  });

  it('restores configuration after probe failure and returns no partial result', async () => {
    let restores = 0;
    await expect(discoverContextBoundary({ modelId: 'model', hardLimit: 131072, kvOffload: true,
      hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB, probe: async () => { throw new Error('probe failed'); },
      restore: async () => { restores += 1; }, progress: () => undefined })).rejects.toThrow('probe failed');
    expect(restores).toBe(1);
  });

  it('cancels between probes, restores the source runtime and rejects partial results', async () => {
    const controller = new AbortController();
    let restores = 0;
    await expect(discoverContextBoundary({ modelId: 'model', hardLimit: 131072, kvOffload: true,
      hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB,
      probe: async (context, mode, phase) => { controller.abort(); return fixture(context, mode, phase); },
      restore: async () => { restores += 1; }, progress: () => undefined, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(restores).toBe(1);
  });

  it('refuses hardware-safe estimates when enabled speculative allocation is unknown', () => {
    const estimate = estimateHardwareSafeContext({
      configuredMaxTokens: 131072, contextPresets: [16384, 32768, 65536, 131072],
      hostAvailableBytes: 64 * GiB, deviceAvailableBytes: 24 * GiB,
      hostReserveBytes: 8 * GiB, deviceReserveBytes: 384 * 1024 ** 2,
      hostWeightBytes: 8 * GiB, deviceWeightBytes: 10 * GiB,
      hostKvBytesPerToken: 0, deviceKvBytesPerToken: 128 * 1024,
      speculativeHostKvBytesPerToken: 0, speculativeDeviceKvBytesPerToken: 0,
      sequenceSlots: 1, speculativeMode: 'unknown',
      speculativeHostWeightBytes: null, speculativeDeviceWeightBytes: null,
      speculativeHostBufferBytesPerSlot: null, speculativeDeviceBufferBytesPerSlot: null,
      speculativeSlots: null,
    });
    expect(estimate.hardwareSafeTokens).toBeNull();
    expect(estimate.unknownReasons.length).toBeGreaterThan(0);
  });
});
