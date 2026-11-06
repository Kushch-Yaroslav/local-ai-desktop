import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { speculativeFixture } from './test/ggufFixtures';
import { validateProfile } from './ggufConfig';
import { inspectPlacement } from './moe/placement';
import { ManagedGguf } from './managedGguf';
import type { GgufProfile, RuntimeProbe } from './ggufTypes';

vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));

const temporaryDirectories: string[] = [];
const probe: RuntimeProbe = {
  executable: '/runtime/llama-server',
  version: 'llama.cpp 5047748 test',
  flags: [
    '--model', '--host', '--port', '--gpu-layers', '--ctx-size', '--api-key', '--alias',
    '--parallel', '--override-tensor', '--fit', '--load-mode', '--no-host', '--no-repack',
    '--lazy-mode', '--flash-attn',
  ],
  cacheTypes: ['f16'],
  devices: 'CUDA0: test device',
  gpuAvailable: true,
  apiKeyEnvironment: true,
  speculativeModes: [],
  diagnosis: 'gpuVisible',
};

async function makeProfile(placementIdentity?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'gguf-placement-identity-'));
  temporaryDirectories.push(dir);
  const model = join(dir, 'qwen.gguf');
  await writeFile(model, speculativeFixture({ architecture: 'qwen35', head: false }));
  const inspection = await inspectPlacement(model);
  const profile: GgufProfile = {
    id: 'qwen-profile',
    name: 'Qwen test profile',
    model,
    executable: probe.executable,
    backend: 'external',
    gpuLayers: 999,
    context: 8192,
    gpuBlockIds: [0],
    flashAttention: 'on',
    speculativeMode: 'off',
    placementIdentity,
  };
  return { profile, inspection };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GGUF placement profile save validation', () => {
  it('saves a legacy selective-placement profile after the user confirms the inspected identity', async () => {
    const { profile, inspection } = await makeProfile();
    await expect(validateProfile(profile, probe)).rejects.toThrow('GGUF:placementIdentity');
    await expect(
      validateProfile({ ...profile, placementIdentity: inspection.identity }, probe)
    ).resolves.toBeUndefined();
  });

  it('rejects an identity from an earlier file version and accepts only the newly confirmed one', async () => {
    const { profile, inspection } = await makeProfile('old-device:inode:size:mtime:ctime');
    await expect(validateProfile(profile, probe)).rejects.toThrow('GGUF:placementIdentity');
    await expect(
      validateProfile({ ...profile, placementIdentity: inspection.identity }, probe)
    ).resolves.toBeUndefined();
  });

  it('also protects legacy cache-size profiles whose explicit mode field is absent', async () => {
    const { profile } = await makeProfile();
    const legacy = { ...profile, gpuBlockIds: undefined, moeCacheMiB: 4096 };
    await expect(validateProfile(legacy, { ...probe, flags: [...probe.flags, '--moe-cache-mib'] })).rejects.toThrow(
      'GGUF:placementIdentity'
    );
  });

  it('persists the explicitly confirmed identity through the managed profile save path', async () => {
    const { profile, inspection } = await makeProfile();
    const root = temporaryDirectories.at(-1)!;
    const executable = join(root, 'fake-llama-server');
    await writeFile(
      executable,
      `#!/bin/sh\ncase "$1" in\n--help) cat <<'HELP'\n--model --host --port --gpu-layers --ctx-size --api-key LLAMA_API_KEY --alias --list-devices --parallel --override-tensor --fit --load-mode --no-host --no-repack --lazy-mode --flash-attn\nHELP\n;;\n--version) echo 'llama.cpp 5047748 test' ;;\n--list-devices) echo 'CUDA0: test device' ;;\nesac\n`,
      { mode: 0o700 }
    );
    const service = new ManagedGguf(root, () => {}, executable);
    await expect(service.save(profile)).rejects.toThrow('GGUF:placementIdentity');

    const saved = await service.save({ ...profile, placementIdentity: inspection.identity });
    expect(saved).toMatchObject({
      id: profile.id,
      model: profile.model,
      placementIdentity: inspection.identity,
      gpuBlockIds: [0],
    });
    const persisted = JSON.parse(await readFile(join(root, 'gguf-profiles.json'), 'utf8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: profile.id,
      placementIdentity: inspection.identity,
      gpuBlockIds: [0],
    });
  });
});
