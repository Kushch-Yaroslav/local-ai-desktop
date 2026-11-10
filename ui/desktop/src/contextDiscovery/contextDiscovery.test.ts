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
  it('preserves donor search decisions while enforcing the explicit VRAM reserve', async () => {
    const result = await discoverContextBoundary({ modelId: 'model', hardLimit: 262144, kvOffload: true,
      hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB,
      probe: async (context, mode, phase) => fixture(context, mode, phase), restore: async () => undefined,
      progress: () => undefined });
    expect(result.options.map(({ contextWindow, kvCacheType }) => ({ contextWindow, kvCacheType }))).toEqual([
      { contextWindow: 81920, kvCacheType: 'f16' },
      { contextWindow: 151552, kvCacheType: 'q8_0' },
    ]);
    expect(result.options.every((option) => option.vramBudget!.llmBytes <= option.vramBudget!.availableLlmBytes && option.measuredHeadroom.deviceBytes >= 2 * GiB)).toBe(true);
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

it('stops infrastructure failures after one probe and restores without claiming a memory boundary', async () => {
 let calls=0, restores=0;
 await expect(discoverContextBoundary({ modelId:'broken', hardLimit:65536, kvOffload:true, hostReserveBytes:8*GiB, deviceReserveBytes:2*GiB, progress:()=>{}, restore:async()=>{restores++;}, probe:async(context,mode,phase)=>{calls++;return {failureKind:'arguments',estimate:null,record:{contextWindow:context,kvCacheType:mode,phase,startup:false,health:false,inference:false,fits:false,reason:'unknown argument',elapsedMs:1,headroom:null,memoryBaseline:null}};} })).rejects.toThrow('Discovery stopped (arguments)');
 expect(calls).toBe(1);expect(restores).toBe(1);
});

it('MTP search starts below the old 16K floor and retains independently verified Q8', async()=>{
 const seen:number[]=[];
 const result=await discoverContextBoundary({modelId:'mtp',hardLimit:16384,minimumContextTokens:4096,retainEquivalentKvOptions:true,kvOffload:true,hostReserveBytes:8*GiB,deviceReserveBytes:2*GiB,progress:()=>{},restore:async()=>{},probe:async(context,mode,phase)=>{seen.push(context);return fixture(context,mode,phase);}});
 expect(seen[0]).toBe(4096);
 expect(result.probeContextTokens).toBe(4096);
 expect(result.options.map(o=>o.kvCacheType)).toEqual(['f16','q8_0']);
});

it('measures fixed MTP compute overhead at a second nearby context instead of stopping at the calibration floor',async()=>{
 const seen:number[]=[];
 const result=await discoverContextBoundary({modelId:'fixed-mtp',hardLimit:32768,minimumContextTokens:4096,measureInitialGrowth:true,retainEquivalentKvOptions:true,kvOffload:true,hostReserveBytes:8*GiB,deviceReserveBytes:2*GiB,progress:()=>{},restore:async()=>{},probe:async(context,mode,phase)=>{seen.push(context);const probe=fixture(context,mode,phase);probe.estimate!.allocationEvidence!.allocations.speculativeCompute={device:2*GiB};return probe;}});
 expect(seen.slice(0,2)).toEqual([4096,8192]);
 expect(result.options.every(o=>o.contextWindow>4096)).toBe(true);
});

it('preserves an explicitly larger VRAM reserve even when a process budget is available',async()=>{
 const reserve=4*GiB;
 const result=await discoverContextBoundary({modelId:'reserved-mtp',hardLimit:262144,minimumContextTokens:4096,measureInitialGrowth:true,retainEquivalentKvOptions:true,kvOffload:true,hostReserveBytes:8*GiB,deviceReserveBytes:reserve,progress:()=>{},restore:async()=>{},probe:async(context,mode,phase)=>fixture(context,mode,phase)});
 expect(result.options).toHaveLength(2);
 expect(result.options.every(option=>option.measuredHeadroom.deviceBytes>=reserve)).toBe(true);
});
