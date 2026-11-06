import { describe, expect, it } from 'vitest';
import { buildArguments } from './ggufConfig';
import { effectiveCpuMoe } from './moe/config';
import type { GgufProfile } from './ggufTypes';

const base: GgufProfile = {
  id: 'gpt-oss-profile',
  name: 'GPT-OSS test profile',
  model: '/models/gpt-oss.gguf',
  executable: '/runtime/llama-server',
  gpuLayers: 999,
  context: 4096,
};

const has = (args: string[], flag: string) => args.includes(flag);
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('independent CPU MoE and expert-cache launch settings', () => {
  it('does not put all experts on CPU for Standard with no explicit CPU MoE choice', () => {
    const profile = { ...base, moeCacheMode: 'standard' as const };
    const args = buildArguments(profile, 1234);

    expect(has(args, '--gpu-layers')).toBe(true);
    expect(value(args, '--gpu-layers')).toBe('999');
    expect(has(args, '--cpu-moe')).toBe(false);
    expect(has(args, '--moe-cache-mib')).toBe(false);
  });

  it('preserves an explicitly selected standalone CPU MoE setting with cache off', () => {
    const args = buildArguments({ ...base, cpuMoe: true, moeCacheMode: 'standard' }, 1234);

    expect(args.filter((arg) => arg === '--cpu-moe')).toHaveLength(1);
    expect(effectiveCpuMoe({ ...base, cpuMoe: true, moeCacheMode: 'standard' })).toBe(true);
  });

  it('derives CPU expert placement for an active cache without mutating the saved profile', () => {
    const profile = {
      ...base,
      moeCacheMode: 'manual' as const,
      moeCacheMiB: 4096,
      cpuMoe: undefined,
    };
    const args = buildArguments(profile, 1234);

    expect(args.filter((arg) => arg === '--cpu-moe')).toHaveLength(1);
    expect(value(args, '--moe-cache-mib')).toBe('4096');
    expect(args).toEqual(expect.arrayContaining(['--no-host', '--no-repack', '--lazy-mode', 'off']));
    expect(profile.cpuMoe).toBeUndefined();
  });

  it('removes cache-derived CPU placement and stale cache arguments when switched to Standard', () => {
    const previouslyEnabled = { ...base, moeCacheMode: 'manual' as const, moeCacheMiB: 8192 };
    expect(buildArguments(previouslyEnabled, 1234)).toContain('--cpu-moe');

    const standard = { ...previouslyEnabled, moeCacheMode: 'standard' as const };
    const args = buildArguments(standard, 1234);
    expect(args).not.toContain('--cpu-moe');
    expect(args).not.toContain('--moe-cache-mib');
    expect(args).not.toContain('--no-host');
    expect(standard.moeCacheMiB).toBe(8192);
  });

  it('keeps CPU placement isolated between profiles and does not add it for 999 GPU layers', () => {
    const cpuProfile = { ...base, cpuMoe: true };
    const gpuProfile = { ...base, id: 'dense-profile', name: 'Dense', cpuMoe: undefined };
    expect(buildArguments(cpuProfile, 1234)).toContain('--cpu-moe');
    expect(buildArguments(gpuProfile, 1234)).not.toContain('--cpu-moe');
    expect(gpuProfile.cpuMoe).toBeUndefined();
  });

  it('keeps legacy explicit CPU MoE values as standalone choices', () => {
    const legacy = { ...base, cpuMoe: true };
    expect(buildArguments(legacy, 1234)).toContain('--cpu-moe');
    expect(legacy.cpuMoe).toBe(true);
  });

  it('rejects combining first-N CPU placement with an all-expert cache', () => {
    expect(() =>
      buildArguments(
        {
          ...base,
          nCpuMoe: 2,
          moeCacheMode: 'manual',
          moeCacheMiB: 4096,
        },
        1234
      )
    ).toThrow('GGUF:conflictingMoe');
  });
});
