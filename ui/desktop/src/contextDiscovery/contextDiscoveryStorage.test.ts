import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDiscoveryOptions, saveDiscoveryOptions } from './contextDiscoveryStorage';
import type { ContextDiscoveryOption } from './contextEstimator';

const model = '/models/qwen.gguf';
const option = (kvCacheType: 'f16' | 'q8_0', contextWindow: number): ContextDiscoveryOption => ({
  modelId: model,
  contextWindow,
  kvCacheType,
  kvOffload: true,
  discoveredAt: new Date().toISOString(),
  memoryBaseline: { hostAvailableBytes: 24e9, deviceAvailableBytes: 20e9 },
  measuredHeadroom: { hostBytes: 16e9, deviceBytes: 2e9 },
  vramBudget: {
    totalBytes: 24e9,
    nonLlmBytes: 1e9,
    llmBytes: 18e9,
    freeBytes: 5e9,
    driverReservedBytes: 0,
    backgroundBudgetBytes: 1e9,
    marginBytes: 384e6,
    llmBudgetBytes: 22e9,
    availableLlmBytes: 22e9,
    backgroundOverBudget: false,
  },
});

describe('donor-compatible context discovery persistence', () => {
  let directory = '';
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
  });
  it('stores FP16 and Q8 per model identity, reuses exact matches and marks changed conditions unconfirmed', async () => {
    directory = await mkdtemp(join(tmpdir(), 'lad-context-'));
    const file = join(directory, 'measurements.json');
    const first = [option('f16', 65536), option('q8_0', 98304)];
    await saveDiscoveryOptions(file, 'identity-a', '{"runtime":"a"}', first, 1000);
    const exact = await loadDiscoveryOptions(file, {
      configKey: 'identity-a',
      modelId: model,
      hardLimit: 131072,
    });
    expect(exact.options.map((entry) => [entry.kvCacheType, entry.contextWindow])).toEqual([
      ['f16', 65536],
      ['q8_0', 98304],
    ]);
    expect(exact.options.every((entry) => entry.restored && entry.conditions === 'unknown')).toBe(
      true
    );
    const changed = await loadDiscoveryOptions(file, {
      configKey: 'identity-b',
      modelId: model,
      hardLimit: 131072,
    });
    expect(changed.options).toHaveLength(0);
    expect(
      changed.previous.every(
        (entry) => entry.conditions === 'changed' && entry.validation === 'previous'
      )
    ).toBe(true);
    const placementChanged = await loadDiscoveryOptions(file, {
      configKey: 'identity-a',
      modelId: model,
      hardLimit: 131072,
      kvOffload: false,
    });
    expect(placementChanged.options).toHaveLength(0);
    expect(placementChanged.previous).toHaveLength(2);
  });
  it('replaces both precisions for one model/config after completion, leaves other models and manual selection intact across reopen', async () => {
    directory = await mkdtemp(join(tmpdir(), 'lad-context-replace-'));
    const file = join(directory, 'measurements.json');
    const qwen27 = '/models/qwen27.gguf';
    const qwen35 = '/models/qwen35.gguf';
    const old = [option('f16', 49152), option('q8_0', 90112)].map((entry) => ({
      ...entry,
      modelId: qwen27,
    }));
    const other = option('f16', 180224);
    await saveDiscoveryOptions(file, 'key-27', 'identity-27', old);
    await saveDiscoveryOptions(file, 'key-35', 'identity-35', [{ ...other, modelId: qwen35 }]);
    const manualContext = 98304;
    await saveDiscoveryOptions(
      file,
      'key-27',
      'identity-27',
      [{ ...option('f16', 102400), modelId: qwen27 }],
      Date.now(),
      true,
      qwen27
    );
    let reopened = await loadDiscoveryOptions(file, {
      configKey: 'key-27',
      modelId: qwen27,
      hardLimit: 262144,
    });
    expect(
      reopened.options.map(({ kvCacheType, contextWindow }) => [kvCacheType, contextWindow])
    ).toEqual([['f16', 102400]]);
    expect(reopened.options.some(({ contextWindow }) => contextWindow === manualContext)).toBe(
      false
    );
    reopened = await loadDiscoveryOptions(file, {
      configKey: 'key-35',
      modelId: qwen35,
      hardLimit: 262144,
    });
    expect(reopened.options.map(({ contextWindow }) => contextWindow)).toEqual([180224]);
    await saveDiscoveryOptions(file, 'key-27', 'identity-27', [], Date.now(), true, qwen27);
    reopened = await loadDiscoveryOptions(file, {
      configKey: 'key-27',
      modelId: qwen27,
      hardLimit: 262144,
    });
    expect(reopened.options).toEqual([]);
    expect(reopened.previous).toEqual([]);
    const qwen35Reopened = await loadDiscoveryOptions(file, {
      configKey: 'key-35',
      modelId: qwen35,
      hardLimit: 262144,
    });
    expect(qwen35Reopened.options).toHaveLength(1);
  });
  it('preserves prior completed values when a run is cancelled or fails before save', async () => {
    directory = await mkdtemp(join(tmpdir(), 'lad-context-incomplete-'));
    const file = join(directory, 'measurements.json');
    await saveDiscoveryOptions(file, 'identity-a', '{}', [
      option('f16', 65536),
      option('q8_0', 98304),
    ]);
    // Incomplete operations never call the completed-run replacement API.
    let reopened = await loadDiscoveryOptions(file, {
      configKey: 'identity-a',
      modelId: model,
      hardLimit: 131072,
    });
    expect(reopened.options.map((entry) => entry.contextWindow)).toEqual([65536, 98304]);
    reopened = await loadDiscoveryOptions(file, {
      configKey: 'identity-a',
      modelId: model,
      hardLimit: 131072,
    });
    expect(reopened.options.map((entry) => entry.contextWindow)).toEqual([65536, 98304]);
  });
});

it('retains verified 4K/8K MTP options across persistence instead of dropping them at the legacy 16K floor',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lad-context-mtp-floor-'));
 try{
 const file=join(dir,'measurements.json');
 await saveDiscoveryOptions(file,'mtp-identity','{"mode":"mtp"}',[option('f16',4096),option('q8_0',8192)]);
 const restored=await loadDiscoveryOptions(file,{configKey:'mtp-identity',modelId:model,hardLimit:262144});
 expect(restored.options.map(o=>[o.kvCacheType,o.contextWindow])).toEqual([['f16',4096],['q8_0',8192]]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
