import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';
import { parseLayerRanges, estimateModelMemory, estimateHostMemory, verifiedMoe } from './model-memory';
import { blockOverrides } from './placement';
import type { ModelInspection, AdvancedModelParameters } from './model-profiles';
import type { GgufProfile } from '../ggufTypes';
const info = {
  architecture: 'qwen3next',
  layers: 48,
  experts: 512,
  fileType: 15,
  modelName: 'Qwen3 Coder Next',
  structure: {
    complete: true,
    totalBytes: 48 * 1024 ** 3,
    tensors: Array.from({ length: 48 }, (_, block) => ({
      name: `blk.${block}.ffn_up_exps.weight`,
      bytes: 1024 ** 3,
      block,
      expert: true,
      type: 12,
    })),
    kvHeads: 2,
    keyLength: 256,
    valueLength: 256,
    fullAttentionLayers: 12,
    recurrentLayers: 36,
  },
} as ModelInspection;
const params: AdvancedModelParameters = {
  mode: 'gpu-layers',
  moeAcceleration: 'manual',
  expertCacheMiB: 16384,
  cpuMoe: 'all',
  loadMode: 'mmap',
};
describe('ported donor placement core', () => {
  it('restricts expert cache to the qualified Qwen3Next and rejects GPT-OSS MXFP4', () => {
    const gpt = {
      ...info,
      architecture: 'gpt-oss',
      modelName: 'gpt-oss-120b',
      layers: 36,
      experts: 128,
      fileType: 38,
      structure: {
        ...info.structure!,
        complete: true,
        tensors: Array.from({ length: 36 }, (_, block) =>
          ['down', 'gate', 'up'].map((kind) => ({
            name: `blk.${block}.ffn_${kind}_exps.weight`,
            bytes: 2880 * 2880 * 128 / 32 * 17,
            block,
            expert: true,
            type: 39,
            shape: [2880, 2880, 128],
          }))
        ).flat(),
      },
    } as ModelInspection;
    expect(verifiedMoe(info)).toBe(true);
    expect(verifiedMoe(gpt)).toBe(false);
    expect(verifiedMoe({ ...gpt, fileType: 39 })).toBe(false);
    expect(verifiedMoe({ ...gpt, experts: 64 })).toBe(false);
    expect(
      verifiedMoe({
        ...gpt,
        structure: { ...gpt.structure!, complete: false },
      })
    ).toBe(false);
    expect(
      verifiedMoe({
        ...gpt,
        structure: {
          ...gpt.structure!,
          tensors: gpt.structure!.tensors.map((tensor, index) =>
            index === 0 ? { ...tensor, type: 8 } : tensor
          ),
        },
      })
    ).toBe(false);
  });
  it('preserves donor GPU and mmap-aware RAM reserves', () => {
    const estimate = estimateModelMemory(
      info,
      params,
      999,
      { contextWindow: 65536, kvCacheType: 'q8_0' },
      23000,
      24576
    );
    expect(estimate.kvMiB).toBe(816);
    expect(estimate.cpuWeightsMiB).toBe(49152);
    expect(estimate.cacheMiB).toBe(16384);
    expect(estimate.reserveMiB).toBe(2048);
    expect(estimate.fits).toBe(true);
    const host = estimateHostMemory(estimate, params, 52000, 56320);
    expect(host.reserveMiB).toBe(7168);
    expect(host.anonymousWeightsMiB).toBe(0);
    expect(host.fileBackedWeightsMiB).toBe(49152);
    expect(host.workingSetFits).toBe(false);
    expect(host.fits).toBe(true);
  });
  it('parses ranges and rejects invalid bounds', () => {
    expect(parseLayerRanges('3-5, 15, 16-20', 48)).toEqual([3, 4, 5, 15, 16, 17, 18, 19, 20]);
    for (const value of ['48', '3-1', '1,,2', '-1'])
      expect(() => parseLayerRanges(value, 48)).toThrow();
  });
  it('keeps experts CPU-resident under selective CUDA overrides and validates ordering', () => {
    const rule = blockOverrides({ gpuBlockIds: [1, 3], cpuMoe: true } as GgufProfile, 4)!;
    const rules = rule.split(',');
    expect(rules[0]).toContain('=CPU');
    const gpu = new RegExp(rules[1].replace('=CUDA0', ''));
    expect(gpu.test('blk.1.attn_q.weight')).toBe(true);
    expect(gpu.test('blk.1.ffn_up_exps.weight')).toBe(false);
    expect(gpu.test('blk.0.attn_q.weight')).toBe(false);
    expect(() => blockOverrides({ gpuBlockIds: [48] } as GgufProfile, 48)).toThrow();
  });
  const donor = process.env.LAD_DONOR_MODEL_MEMORY_MODULE;
  it.skipIf(!donor || !existsSync(donor))(
    'matches original donor calculations over identical fixtures',
    () => {
      const code = ts.transpileModule(readFileSync(donor!, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText;
      const original: Record<string, typeof estimateModelMemory> = {};
      new Function('exports', code)(original);
      for (const available of [null, 12000, 23000])
        for (const precision of ['f16', 'q8_0'] as const) {
          const defaults = { contextWindow: 65536, kvCacheType: precision };
          expect(estimateModelMemory(info, params, 999, defaults, available, 24576)).toEqual(
            original.estimateModelMemory(info, params, 999, defaults, available, 24576)
          );
        }
    }
  );
});
