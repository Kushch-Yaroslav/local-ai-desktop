import { describe, it, expect } from 'vitest';
import { compatibleFlashAttentionDefault } from './ggufFlashAttention';
import type { GgufProfile, RuntimeProbe } from './ggufTypes';
const profile = {
  name: 'Qwen',
  model: '/qwen.gguf',
  executable: '/llama-server',
  gpuLayers: 999,
  context: 8192,
} as GgufProfile;
const probe = {
  version: '0.4.1-dev d1d3c33',
  gpuAvailable: true,
  devices: 'CUDA0: NVIDIA RTX 3090',
  flags: ['--flash-attn'],
} as RuntimeProbe;
describe('audited implicit Flash Attention default', () => {
  it('enables only the audited compatible CUDA/Qwen combination without mutating the original', () => {
    expect(
      compatibleFlashAttentionDefault(profile, probe, { architecture: 'qwen35' }).flashAttention
    ).toBe('on');
    expect(profile.flashAttention).toBeUndefined();
  });
  it.each(['off', 'auto', 'on'] as const)('preserves explicit %s', (value) => {
    expect(
      compatibleFlashAttentionDefault({ ...profile, flashAttention: value }, probe, {
        architecture: 'qwen35',
      }).flashAttention
    ).toBe(value);
  });
  it('preserves unsupported/native/experimental configurations and unknown builds', () => {
    for (const p of [
      { ...profile, backend: 'native' as const },
      { ...profile, gpuLayers: 0 },
      { ...profile, moeCacheMiB: 512 },
      { ...profile, tensorOverride: 'blk=CPU' },
      { ...profile, speculativeMode: 'draft-simple' as const },
    ])
      expect(
        compatibleFlashAttentionDefault(p, probe, { architecture: 'qwen35' }).flashAttention
      ).toBeUndefined();
    expect(
      compatibleFlashAttentionDefault(profile, { ...probe, flags: [] }, { architecture: 'qwen35' })
        .flashAttention
    ).toBeUndefined();
    expect(
      compatibleFlashAttentionDefault(
        profile,
        { ...probe, version: 'unknown' },
        { architecture: 'qwen35' }
      ).flashAttention
    ).toBeUndefined();
    expect(
      compatibleFlashAttentionDefault(profile, probe, { architecture: 'unknown' }).flashAttention
    ).toBeUndefined();
  });
  it('permits audited embedded MTP while preserving an explicitly disabled value', () => {
    expect(
      compatibleFlashAttentionDefault({ ...profile, speculativeMode: 'mtp-embedded' }, probe, {
        architecture: 'qwen35',
      }).flashAttention
    ).toBe('on');
  });
});
