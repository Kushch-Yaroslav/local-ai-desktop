import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { readStorageConfiguration, validateStorage } from './storagePaths';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('storage selection before backend startup', () => {
  const config = {
    version: 1 as const,
    dataRoot: '/data/app',
    bulkRoot: '/bulk/app',
    volumes: [{ mountpoint: '/bulk', uuid: 'disk-id' }],
  };
  it('blocks a missing mount before creating any directory or opening state', () => {
    expect(() => validateStorage(config, '')).toThrow('not mounted');
  });
  it('rejects the wrong disk mounted under the expected path', () => {
    vi.spyOn(fs, 'realpathSync').mockImplementation((p) =>
      String(p).startsWith('/dev/disk/by-uuid/') ? '/dev/expected' : String(p)
    );
    expect(() => validateStorage(config, '1 0 1:2 / /bulk rw - ntfs3 /dev/wrong rw')).toThrow(
      'not mounted'
    );
  });
  it('accepts initialized writable roots only after the correct disk is mounted', () => {
    vi.spyOn(fs, 'realpathSync').mockReturnValue('/dev/expected');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
    expect(validateStorage(config, '1 0 1:2 / /bulk rw - ntfs3 /dev/expected rw')).toEqual(config);
  });
  it('does not fall back when an explicitly configured file is unavailable', () => {
    vi.stubEnv('LOCAL_AI_DESKTOP_STORAGE_CONFIG', '/missing/storage.json');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(() => readStorageConfiguration('/config')).toThrow('configuration missing');
  });
});

it('initializes a new installation with distinct XDG categories, preserving existing installations', async () => {
  const { initializeDefaultStorage } = await import('./storagePaths');
  const { layoutFor } = await import('./storageService');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lad-default-storage-'));
  try {
    const layout = {
      ...layoutFor(path.join(root, 'data'), path.join(root, 'data'), path.join(root, 'config')),
      cacheRoot: path.join(root, 'cache'),
      logsRoot: path.join(root, 'logs'),
    };
    const configuration = initializeDefaultStorage(path.join(root, 'control'), layout, [
      path.join(root, 'old'),
    ]);
    expect(configuration?.useDefault).toBe(true);
    expect(await fsp.realpath(path.join(layout.backendRoot, 'config'))).toBe(layout.configRoot);
    expect(await fsp.realpath(path.join(layout.backendRoot, 'state', 'logs'))).toBe(
      path.join(layout.logsRoot, 'goose')
    );
    const persisted = await fsp.readFile(
      path.join(root, 'control', 'local-ai-desktop-storage.json'),
      'utf8'
    );
    expect(
      initializeDefaultStorage(path.join(root, 'control'), layout, [layout.backendRoot])
    ).toBeUndefined();
    expect(
      await fsp.readFile(path.join(root, 'control', 'local-ai-desktop-storage.json'), 'utf8')
    ).toBe(persisted);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it('canonicalizes mapped devices on encrypted POSIX volumes', () => {
  const config = {
    version: 1 as const,
    dataRoot: '/data/app',
    bulkRoot: '/data/app',
    volumes: [{ mountpoint: '/data', uuid: 'encrypted-uuid' }],
  };
  vi.spyOn(fs, 'realpathSync').mockReturnValue('/dev/dm-0');
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
  expect(validateStorage(config, '1 0 1:2 / /data rw - ext4 /dev/mapper/crypt-data rw')).toEqual(
    config
  );
});
