import { expect, it } from 'vitest';
import { buildArguments } from './ggufConfig';
import {
  stableRuntimeArguments,
  buildContextDiscoveryIdentity,
  contextDiscoveryKey,
} from './contextDiscovery/contextDiscoveryPersistence';
import type { GgufProfile } from './ggufTypes';
const profile: GgufProfile = {
  name: 'MTP',
  model: '/fixture/model.gguf',
  executable: '/fixture/llama-server',
  gpuLayers: 999,
  context: 32768,
  speculativeMode: 'mtp-embedded',
  parallel: 1,
  batch: 512,
  ubatch: 128,
  draftUbatch: 128,
  draftCacheK: 'q8_0',
  draftCacheV: 'q8_0',
  flashAttention: 'on',
};
it('uses the same explicit MTP memory controls in ordinary launches', () => {
  const args = buildArguments(profile, 1234);
  for (const [flag, value] of [
    ['--parallel', '1'],
    ['--spec-type', 'draft-mtp'],
    ['--spec-draft-n-ubatch', '128'],
    ['--cache-type-k-draft', 'q8_0'],
    ['--cache-type-v-draft', 'q8_0'],
  ])
    expect(args[args.indexOf(flag) + 1]).toBe(value);
  expect(args).not.toContain('none');
});
it('keeps draft KV, parallel and offload identity separate from the calibrated main KV', () => {
  const main = stableRuntimeArguments(buildArguments(profile, 1234));
  expect(
    stableRuntimeArguments(
      buildArguments({ ...profile, cacheK: 'f16', cacheV: 'f16', context: 8192 }, 4567)
    )
  ).toEqual(main);
  for (const change of [
    { parallel: 4 },
    { draftCacheK: 'f16' },
    { nCpuMoe: 1 },
    { speculativeMode: 'off' as const },
  ])
    expect(stableRuntimeArguments(buildArguments({ ...profile, ...change }, 1234))).not.toEqual(
      main
    );
});

it('invalidates stored context options when the requested device reserve changes', () => {
  const input = {
    modelId: 'model',
    modelFingerprint: 'weights',
    projectorFingerprint: null,
    runtimeFingerprint: 'runtime',
    arguments: buildArguments(profile, 1234),
    speculative: 'mtp-embedded',
    hardLimit: 262144,
    gpu: { name: 'GPU', vramTotalBytes: 24 * 1024 ** 3 },
    hostReserveBytes: 8 * 1024 ** 3,
  };
  const small = contextDiscoveryKey(
    buildContextDiscoveryIdentity({ ...input, deviceReserveBytes: 384 * 1024 ** 2 })
  );
  const large = contextDiscoveryKey(
    buildContextDiscoveryIdentity({ ...input, deviceReserveBytes: 4 * 1024 ** 3 })
  );
  expect(small.key).not.toBe(large.key);
});
