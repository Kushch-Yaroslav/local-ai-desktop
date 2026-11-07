// Local AI Desktop: real filesystem/SQLite fixtures, never the user's storage.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  StorageService,
  defaultLayout,
  configuredLayout,
  recoverInterruptedStorage,
  probeFilesystem,
  verifyCommittedStorageSync,
  type StorageEnvironment,
} from './storageService';
import type { StorageConfiguration } from './storagePaths';
// These tests sync real files and directories to disk and inspect live process FDs.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
let root: string, env: StorageEnvironment;
const probe = vi.fn(async () => ({
  volume: { mountpoint: '/', uuid: '', type: 'ext4' },
  safeState: true,
  freeBytes: 10 ** 12,
}));
async function write(file: string, value: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
async function restart(service: StorageService) {
  const configuration = JSON.parse(
    await fs.readFile(service.configFile, 'utf8')
  ) as StorageConfiguration;
  const next = new StorageService({ ...env, configuration }, () => {}, probe);
  await next.verifyStartup();
  await next.confirmStartup();
  return next;
}
function messages(file: string) {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare('select text from messages order by rowid')
      .all()
      .map((r) => r.text);
  } finally {
    db.close();
  }
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lad-storage-test-'));
  vi.unstubAllEnvs();
  probe.mockReset();
  probe.mockResolvedValue({
    volume: { mountpoint: '/', uuid: '', type: 'ext4' },
    safeState: true,
    freeBytes: 10 ** 12,
  });
  env = {
    configHome: path.join(root, 'control'),
    defaultDataRoot: path.join(root, 'xdg-data', 'app'),
    defaultConfigRoot: path.join(root, 'xdg-config', 'app'),
    defaultCacheRoot: path.join(root, 'xdg-cache', 'app'),
    defaultLogsRoot: path.join(root, 'xdg-state', 'logs'),
    electronRoot: path.join(root, 'legacy', 'electron'),
    backendRoot: path.join(root, 'legacy', 'goose-backend'),
  };
  await write(
    path.join(env.electronRoot, 'gguf-model-profiles.json'),
    JSON.stringify({
      model: '/models/external.gguf',
      thinking: true,
      mode: 'auto',
      context: 114688,
    })
  );
  await write(path.join(env.backendRoot, 'config', 'config.yaml'), 'GOOSE_MODE: auto\n');
  await write(path.join(env.backendRoot, 'state', 'logs', 'llm_request.1.jsonl'), 'original log');
  await write(path.join(env.electronRoot, 'Cache', 'cache.dat'), 'cached data');
  await fs.mkdir(path.join(env.backendRoot, 'data'), { recursive: true });
  const db = new DatabaseSync(path.join(env.backendRoot, 'data', 'sessions.db'));
  db.exec(
    "PRAGMA journal_mode=WAL;CREATE TABLE messages(text);INSERT INTO messages VALUES('old chat'),('old response')"
  );
  db.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function custom() {
  const folder = path.join(root, 'custom');
  await fs.mkdir(folder);
  return { useDefault: false, customPath: folder };
}
describe('offline storage transactions', () => {
  it('first/default status does not persist or move anything', async () => {
    const s = new StorageService(env, () => {}, probe);
    expect((await s.status()).useDefault).toBe(true);
    expect((await s.preview({ useDefault: true })).unchanged).toBe(true);
    await expect(fs.stat(s.configFile)).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled();
  });
  it('copies default → custom, verifies SQLite/profiles/logs, persists through restart', async () => {
    const s = new StorageService(env, () => {}, probe),
      choice = await custom(),
      quiet = vi.fn(async () => {});
    await s.transfer(choice, quiet);
    expect(quiet).toHaveBeenCalledOnce();
    expect(messages(path.join(env.backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
    const next = await restart(s),
      l = next.current();
    expect((await next.status()).customPath).toBe(choice.customPath);
    expect(messages(path.join(l.backendRoot, 'data', 'sessions.db'))).toEqual([
      'old chat',
      'old response',
    ]);
    expect(
      await fs.readFile(path.join(l.electronRoot, 'gguf-model-profiles.json'), 'utf8')
    ).toContain('/models/external.gguf');
    expect(
      await fs.readFile(path.join(l.backendRoot, 'state', 'logs', 'llm_request.1.jsonl'), 'utf8')
    ).toBe('original log');
    expect((await next.status()).cleanupAvailable).toBe(true);
  });
  it('custom → default copies current history rather than reopening a stale default', async () => {
    const s = new StorageService(env, () => {}, probe);
    await s.transfer(await custom(), async () => {});
    const next = await restart(s);
    const db = new DatabaseSync(path.join(next.current().backendRoot, 'data', 'sessions.db'));
    db.exec("insert into messages values('new chat')");
    db.close();
    await next.transfer({ useDefault: true }, async () => {});
    const final = await restart(next);
    expect((await final.status()).useDefault).toBe(true);
    expect(final.current()).toEqual(defaultLayout(env));
    expect(messages(path.join(final.current().backendRoot, 'data', 'sessions.db'))).toHaveLength(3);
  });
  it('NTFS keeps sensitive state on POSIX and moves bulk categories', async () => {
    probe.mockResolvedValue({
      volume: { mountpoint: '/', uuid: '', type: 'ntfs3' },
      safeState: false,
      freeBytes: 10 ** 12,
    });
    const s = new StorageService(env, () => {}, probe),
      choice = await custom();
    const p = await s.preview(choice);
    expect(p.split).toBe(true);
    expect(p.layout.dataRoot).toBe(s.current().dataRoot);
    await s.transfer(choice, async () => {});
    const next = await restart(s);
    expect(messages(path.join(next.current().backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
    expect(next.current().cacheRoot).toBe(path.join(choice.customPath, 'cache'));
  });
  it('legacy v1 split bootstrap is displayed without mutation or migration', async () => {
    const configuration: StorageConfiguration = {
      version: 1,
      dataRoot: path.join(root, 'ext4', 'data'),
      bulkRoot: path.join(root, 'ntfs'),
      volumes: [],
    };
    const s = new StorageService({ ...env, configuration }, () => {}, probe);
    expect((await s.status()).useDefault).toBe(false);
    expect((await s.status()).split).toBe(true);
    expect(s.current()).toEqual(configuredLayout(configuration));
    expect(
      (await s.preview({ useDefault: false, customPath: configuration.bulkRoot })).unchanged
    ).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
  it('rejects unavailable volumes, insufficient capacity and foreign data before quiescing', async () => {
    const s = new StorageService(env, () => {}, probe),
      choice = await custom(),
      quiet = vi.fn(async () => {});
    probe.mockRejectedValueOnce(new Error('unavailable'));
    await expect(s.transfer(choice, quiet)).rejects.toThrow('unavailable');
    probe.mockResolvedValueOnce({
      volume: { mountpoint: '/', uuid: '', type: 'ext4' },
      safeState: true,
      freeBytes: 1,
    });
    await expect(s.transfer(choice, quiet)).rejects.toThrow('insufficientSpace');
    await write(path.join(choice.customPath, 'data', 'foreign'), 'data');
    await expect(s.transfer(choice, quiet)).rejects.toThrow('destinationConflict');
    expect(quiet).not.toHaveBeenCalled();
  });
  it('quiesce failure preserves source/config and allows retry', async () => {
    const s = new StorageService(env, () => {}, probe),
      choice = await custom();
    await expect(
      s.transfer(choice, async () => {
        throw new Error('storageInUse');
      })
    ).rejects.toThrow('storageInUse');
    expect(messages(path.join(env.backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
    await expect(fs.stat(s.configFile)).rejects.toThrow();
    await s.transfer(choice, async () => {});
    await restart(s);
  });
  it('blocks concurrent migrations', async () => {
    const s = new StorageService(env, () => {}, probe),
      choice = await custom();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r));
    const first = s.transfer(choice, async () => {
      entered();
      await new Promise<void>((r) => (release = r));
    });
    await ready;
    await expect(s.transfer(choice, async () => {})).rejects.toThrow('migrationBusy');
    release();
    await first;
  });
  it('rollback after use preserves new messages', async () => {
    const s = new StorageService(env, () => {}, probe);
    await s.transfer(await custom(), async () => {});
    const next = await restart(s);
    const db = new DatabaseSync(path.join(next.current().backendRoot, 'data', 'sessions.db'));
    db.exec("insert into messages values('after migration')");
    db.close();
    await next.rollback(async () => {});
    const back = await restart(next);
    expect((await back.status()).useDefault).toBe(true);
    expect(messages(path.join(back.current().backendRoot, 'data', 'sessions.db'))).toHaveLength(3);
  });
  it('interrupted installing transaction restores retained roots before opening state', async () => {
    const s = new StorageService(env, () => {}, probe);
    await s.transfer(await custom(), async () => {});
    const j = JSON.parse(await fs.readFile(s.journalFile, 'utf8'));
    await fs.rm(s.configFile);
    j.phase = 'installing';
    await fs.writeFile(s.journalFile, JSON.stringify(j));
    recoverInterruptedStorage(env.configHome);
    expect(JSON.parse(await fs.readFile(s.journalFile, 'utf8')).phase).toBe('failed');
    expect(messages(path.join(env.backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
    await s.transfer({ useDefault: false, customPath: j.target.selectedRoot }, async () => {});
    await restart(s);
  });
  it('detects target corruption and does not permit cleanup before verified startup', async () => {
    const s = new StorageService(env, () => {}, probe);
    await s.transfer(await custom(), async () => {});
    await expect(s.cleanup()).rejects.toThrow('notVerified');
    const c = JSON.parse(await fs.readFile(s.configFile, 'utf8'));
    await write(path.join(c.dataRoot, 'electron', 'gguf-model-profiles.json'), 'corrupted');
    const next = new StorageService({ ...env, configuration: c }, () => {}, probe);
    await expect(next.verifyStartup()).rejects.toThrow('startupVerification');
    await next.rollback();
    expect(messages(path.join(env.backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
  });
  it('retains legacy sources and allows verified cleanup of owned transfer copies', async () => {
    const s = new StorageService(env, () => {}, probe);
    await s.transfer(await custom(), async () => {});
    const next = await restart(s);
    await next.cleanup();
    expect(messages(path.join(env.backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
    const second = path.join(root, 'second');
    await fs.mkdir(second);
    await next.transfer({ useDefault: false, customPath: second }, async () => {});
    const last = await restart(next);
    await last.cleanup();
    expect(messages(path.join(last.current().backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
    expect(messages(path.join(next.current().backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
  });
  it('rejects a live SQLite writer', async () => {
    const db = new DatabaseSync(path.join(env.backendRoot, 'data', 'sessions.db'));
    db.exec('BEGIN IMMEDIATE');
    try {
      const s = new StorageService(env, () => {}, probe);
      await expect(s.transfer(await custom(), async () => {})).rejects.toThrow(
        'databaseBusyOrInvalid'
      );
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
  });
  it('runs actual POSIX capability probes in disposable directories', async () => {
    const p = await probeFilesystem(root);
    expect(p.volume.type).toBe('ext4');
    expect(p.safeState).toBe(true);
  });
  it('verifies a committed checkpoint before Electron opens its databases and recovers the commit journal gap', async () => {
    const s = new StorageService(env, () => {}, probe);
    await s.transfer(await custom(), async () => {});
    const j = JSON.parse(await fs.readFile(s.journalFile, 'utf8'));
    j.phase = 'installing';
    await fs.writeFile(s.journalFile, JSON.stringify(j));
    recoverInterruptedStorage(env.configHome);
    expect(JSON.parse(await fs.readFile(s.journalFile, 'utf8')).phase).toBe('committed');
    expect(() => verifyCommittedStorageSync(env.configHome)).not.toThrow();
    await write(path.join(j.target.dataRoot, 'electron', 'gguf-model-profiles.json'), 'corrupt');
    expect(() => verifyCommittedStorageSync(env.configHome)).toThrow('startupVerification');
    recoverInterruptedStorage(env.configHome, true);
    expect(messages(path.join(env.backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
  });

  it('returns to an existing fresh-install default that has no ownership ID yet', async () => {
    env.defaultDataRoot = path.dirname(env.backendRoot);
    env.defaultConfigRoot = path.join(env.backendRoot, 'config');
    const configuration = {
      version: 1 as const,
      ...defaultLayout(env),
      useDefault: true,
      volumes: [],
    };
    const first = new StorageService({ ...env, configuration }, () => {}, probe);
    await first.transfer(await custom(), async () => {});
    const next = await restart(first);
    await next.transfer({ useDefault: true }, async () => {});
    const final = await restart(next);
    expect((await final.status()).useDefault).toBe(true);
    expect(messages(path.join(final.current().backendRoot, 'data', 'sessions.db'))).toHaveLength(2);
  });
  it('rechecks the full source snapshot before commit', async () => {
    let changed = false;
    const file = path.join(env.electronRoot, 'gguf-model-profiles.json');
    const s = new StorageService(
      env,
      (p) => {
        if (p.phase === 'verifying' && !changed) {
          changed = true;
          writeFileSync(file, 'changed externally');
        }
      },
      probe
    );
    await expect(s.transfer(await custom(), async () => {})).rejects.toThrow('sourceChanged');
    await expect(fs.stat(s.configFile)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('changed externally');
  });
  it('probes a long directory without exceeding the Unix socket pathname limit', async () => {
    const long = path.join(root, 'deep-'.repeat(30));
    await fs.mkdir(long);
    expect((await probeFilesystem(long)).safeState).toBe(true);
  });
});
