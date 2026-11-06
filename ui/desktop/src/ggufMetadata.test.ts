// Local AI Desktop: bounded model capability inspection and argument gating.
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectGguf } from './ggufMetadata';
import { buildArguments, validateProfile } from './ggufConfig';
function u32(value: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}
function u64(value: number) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}
function str(value: string) {
  const b = Buffer.from(value);
  return Buffer.concat([u64(b.length), b]);
}
describe('GGUF capability validation', () => {
  it('reads architecture and MoE metadata without mapping tensor weights', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gguf-meta-'));
    const file = join(dir, 'model.gguf');
    try {
      const fields = [
        Buffer.concat([str('general.architecture'), u32(8), str('testmoe')]),
        ...Object.entries({
          'testmoe.block_count': 40,
          'testmoe.context_length': 8192,
          'testmoe.expert_count': 128,
        }).map(([key, value]) => Buffer.concat([str(key), u32(4), u32(value)])),
      ];
      await writeFile(
        file,
        Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(fields.length), ...fields])
      );
      expect(await inspectGguf(file)).toMatchObject({
        architecture: 'testmoe',
        layers: 40,
        context: 8192,
        experts: 128,
      });
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it('checks Qwen/projector projection dimensions and capability-gates CPU projector placement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gguf-vision-pair-'));
    try {
      const model = join(dir, 'model.gguf'),
        projector = join(dir, 'projector.gguf');
      const encode = (fields: Array<[string, string | number]>) =>
        Buffer.concat([
          Buffer.from('GGUF'),
          u32(3),
          u64(0),
          u64(fields.length),
          ...fields.map(([key, value]) =>
            Buffer.concat([
              str(key),
              u32(typeof value === 'string' ? 8 : 4),
              typeof value === 'string' ? str(value) : u32(value),
            ])
          ),
        ]);
      await writeFile(
        model,
        encode([
          ['general.architecture', 'qwen35'],
          ['qwen35.embedding_length', 5120],
          ['qwen35.context_length', 8192],
        ])
      );
      await writeFile(
        projector,
        encode([
          ['general.architecture', 'clip'],
          ['clip.vision.projection_dim', 4096],
        ])
      );
      const profile = {
        name: 'vision',
        model,
        projector,
        executable: process.execPath,
        gpuLayers: 0,
        context: 8192,
        projectorCpu: true,
      };
      const probe = {
        executable: process.execPath,
        version: 'fixture',
        flags: [
          '--model',
          '--host',
          '--port',
          '--gpu-layers',
          '--ctx-size',
          '--alias',
          '--mmproj',
          '--no-mmproj-offload',
          '--api-key',
        ],
        cacheTypes: ['f16'],
        devices: '',
        gpuAvailable: false,
        apiKeyEnvironment: true,
        speculativeModes: [],
        diagnosis: 'backendUnsupported' as const,
      };
      await expect(validateProfile(profile, probe)).rejects.toThrow('visionPair');
      await writeFile(
        projector,
        encode([
          ['general.architecture', 'clip'],
          ['clip.vision.projection_dim', 5120],
        ])
      );
      await expect(validateProfile(profile, probe)).resolves.toBeUndefined();
      expect(buildArguments(profile, 1234)).toContain('--no-mmproj-offload');
      await expect(
        validateProfile(profile, {
          ...probe,
          flags: probe.flags.filter((flag) => flag !== '--no-mmproj-offload'),
        })
      ).rejects.toThrow('unsupportedFlag');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('builds discrete arguments and never interpolates tensor rules into a shell', () => {
    const profile = {
      name: 'test',
      model: '/model.gguf',
      executable: '/runtime',
      gpuLayers: 24,
      context: 8192,
      threads: 8,
      cacheK: 'q8_0',
      flashAttention: 'on' as const,
      nCpuMoe: 1,
      tensorOverride: 'blk.*=CPU',
    };
    const args = buildArguments(profile, 1234);
    expect(args).toContain('--cache-type-k');
    expect(args).toContain('--n-cpu-moe');
    expect(args[args.indexOf('--override-tensor') + 1]).toBe('blk.*=CPU');
    expect(args).not.toContain('--api-key');
  });
  it('rejects draft assumptions and unsupported native settings explicitly', async () => {
    await expect(
      validateProfile({
        name: 'test',
        model: '/missing',
        executable: '/runtime',
        gpuLayers: 0,
        context: 8192,
        draft: '/draft.gguf',
      })
    ).rejects.toThrow('GGUF:specDraftMode');
  });
});
