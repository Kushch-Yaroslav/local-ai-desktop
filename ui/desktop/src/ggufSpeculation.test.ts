import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSpeculativeMetadata } from './ggufSpeculativeMetadata';
import {
  speculationModes,
  validateSpeculation,
  validateSpeculativePair,
  speculativeArguments,
} from './ggufSpeculation';
import { speculativeFixture } from './test/ggufFixtures';
import type { GgufProfile, RuntimeProbe } from './ggufTypes';
let dir: string, target: string, draft: string;
let profile: GgufProfile;
const probe: RuntimeProbe = {
  executable: '/fixture',
  version: 'fixture',
  flags: [
    '--spec-type',
    '--spec-draft-n-max',
    '--spec-draft-n-min',
    '--spec-draft-model',
    '--gpu-layers-draft',
  ],
  cacheTypes: ['f16', 'q8_0'],
  gpuAvailable: false,
  apiKeyEnvironment: true,
  devices: '',
  diagnosis: 'devicesInaccessible',
  speculativeModes: ['mtp-embedded', 'mtp-external', 'draft-simple'],
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mtp-metadata-'));
  target = join(dir, 'target.gguf');
  draft = join(dir, 'draft.gguf');
  await writeFile(target, speculativeFixture());
  await writeFile(draft, speculativeFixture());
  profile = {
    name: 'test',
    model: target,
    executable: '/fixture',
    context: 8192,
    gpuLayers: 0,
    speculativeMode: 'mtp-external',
    draft,
    draftTokens: 2,
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true });
});
describe('speculative decoding compatibility', () => {
  it('reads tokenizer identities and verifies a complete embedded head without mapping weights', async () => {
    const metadata = await readSpeculativeMetadata(target);
    expect(metadata.values['qwen35.nextn_predict_layers']).toBe(1);
    expect(metadata.tensors['blk.1.nextn.eh_proj.weight']).toMatchObject({
      shape: [16, 8],
      valid: true,
    });
    await expect(
      validateSpeculation({ ...profile, speculativeMode: 'mtp-embedded', draft: undefined }, probe)
    ).resolves.toBeUndefined();
  });
  it('validates an external MTP pair and serializes explicit profile settings', async () => {
    await expect(validateSpeculation(profile, probe)).resolves.toBeUndefined();
    const restored = JSON.parse(JSON.stringify(profile));
    expect(speculativeArguments(restored)).toEqual([
      '--spec-type',
      'draft-mtp',
      '--spec-draft-n-max',
      '2',
      '--spec-draft-model',
      draft,
    ]);
  });
  it('retains but never activates a disabled draft setting', async () => {
    const disabled = {
      ...profile,
      speculativeMode: 'off' as const,
      draft: '/disconnected/draft.gguf',
    };
    await expect(
      validateSpeculation(disabled, { ...probe, speculativeModes: [] })
    ).resolves.toBeUndefined();
    expect(speculativeArguments(disabled)).toEqual([]);
  });
  it('rejects unsupported modes, flags, paths and token counts before launch', async () => {
    await expect(validateSpeculation(profile, { ...probe, flags: [] })).rejects.toThrow(
      'unsupportedFlag'
    );
    await expect(validateSpeculation(profile, { ...probe, speculativeModes: [] })).rejects.toThrow(
      'specBackend'
    );
    await expect(validateSpeculation({ ...profile, draft: undefined }, probe)).rejects.toThrow(
      'specDraftRequired'
    );
    await expect(validateSpeculation({ ...profile, draft: target }, probe)).rejects.toThrow(
      'specSameFile'
    );
    await expect(validateSpeculation({ ...profile, draftTokens: 17 }, probe)).rejects.toThrow(
      'invalidValue'
    );
  });
  it('rejects mismatched architecture, tokenizer, dimensions, context and incomplete tensors', async () => {
    for (const [options, code] of [
      [{ architecture: 'llama' }, 'specArchitecture'],
      [{ tokens: ['different'] }, 'specTokenizer'],
      [{ embedding: 16 }, 'specDimensions'],
      [{ context: 512 }, 'specDimensions'],
      [{ badHead: true }, 'specHead'],
      [{ truncated: true }, 'specHead'],
    ] as const) {
      await writeFile(draft, speculativeFixture(options));
      await expect(validateSpeculation(profile, probe)).rejects.toThrow(code);
    }
  });
  it('never treats a generic draft as Qwen MTP or enables unaudited embedded architectures', async () => {
    await writeFile(draft, speculativeFixture({ head: false }));
    await expect(validateSpeculation(profile, probe)).rejects.toThrow('specHead');
    await writeFile(target, speculativeFixture({ architecture: 'qwen3', head: false }));
    await expect(
      validateSpeculation({ ...profile, speculativeMode: 'mtp-embedded', draft: undefined }, probe)
    ).rejects.toThrow('specArchitecture');
  });
  it('permits classic same-tokenizer llama drafts without claiming MTP', async () => {
    await writeFile(target, speculativeFixture({ architecture: 'llama', head: false }));
    await writeFile(draft, speculativeFixture({ architecture: 'llama', head: false }));
    await expect(
      validateSpeculation(
        { ...profile, speculativeMode: 'draft-simple', draftGpuLayers: 0, draftMinTokens: 1 },
        probe
      )
    ).resolves.toBeUndefined();
    expect(speculativeArguments({ ...profile, speculativeMode: 'draft-simple' })).toContain(
      'draft-simple'
    );
  });
  it('reads wrapped mode enums and blocks the audited standard external-path bug', () => {
    const help = '--spec-type none,draft-simple,\n  draft-mtp,draft-eagle3\n--next FLAG';
    expect(speculationModes(help, 'donor 5047748')).toEqual([
      'mtp-embedded',
      'mtp-external',
      'draft-simple',
    ]);
    expect(speculationModes(help, 'version d1d3c33')).toEqual(['mtp-embedded']);
    expect(speculationModes('--model-draft FNAME', '')).toEqual([]);
  });
  it('does not modify metadata objects during compatibility checks', async () => {
    const a = await readSpeculativeMetadata(target),
      b = await readSpeculativeMetadata(draft);
    const before = JSON.stringify(a);
    validateSpeculativePair(profile, a, b);
    expect(JSON.stringify(a)).toBe(before);
  });
});
