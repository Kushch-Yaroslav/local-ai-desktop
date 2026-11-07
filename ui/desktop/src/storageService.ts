// Local AI Desktop: offline, journaled storage transfers. No live state is copied while a backend is running.
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ELECTRON_CACHE_PATHS, type StorageConfiguration } from './storagePaths';
import type {
  StorageChoice,
  StorageLayout,
  StoragePreview,
  StorageProgress,
  StorageStatus,
} from './storageTypes';
const execute = promisify(execFile);
const marker = '.local-ai-desktop-storage';
const owner = '.local-ai-desktop-transfer';
const exists = (p: string) =>
  fs.lstat(p).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  );
const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
export class StorageError extends Error {
  constructor(
    public code: string,
    detail = ''
  ) {
    super(`${code}${detail ? ': ' + detail : ''}`);
  }
}
export interface Volume {
  mountpoint: string;
  uuid: string;
  type: string;
}
export interface StorageEnvironment {
  configHome: string;
  defaultDataRoot: string;
  defaultConfigRoot: string;
  defaultCacheRoot: string;
  defaultLogsRoot: string;
  electronRoot: string;
  backendRoot: string;
  configuration?: StorageConfiguration;
}
type Category = 'core' | 'config' | 'cache' | 'logs' | 'artifacts' | 'backups';
type Entry = { category: Category; relative: string; source: string; excludes?: string[] };
type Group = { final: string; stage: string; retained: string; existed: boolean };
type RecordFile = { root: string; relative: string; hash: string; size: number; source: string };
interface Journal {
  id: string;
  installationId: string;
  phase: string;
  previous: StorageConfiguration | null;
  target: StorageConfiguration;
  source: StorageLayout;
  groups: Group[];
  manifest: string;
  files: RecordFile[];
  error?: string;
}
export function layoutFor(
  dataRoot: string,
  bulkRoot: string,
  configRoot = path.join(bulkRoot, 'config')
): StorageLayout {
  return {
    dataRoot,
    bulkRoot,
    configRoot,
    cacheRoot: path.join(bulkRoot, 'cache'),
    logsRoot: path.join(bulkRoot, 'logs'),
    artifactsRoot: path.join(bulkRoot, 'artifacts'),
    backupsRoot: path.join(bulkRoot, 'backups'),
    electronRoot: path.join(dataRoot, 'electron'),
    backendRoot: path.join(dataRoot, 'goose-backend'),
  };
}
export function configuredLayout(c: StorageConfiguration): StorageLayout {
  return {
    ...layoutFor(c.dataRoot, c.bulkRoot, path.join(c.dataRoot, 'goose-backend', 'config')),
    ...Object.fromEntries(
      ['configRoot', 'cacheRoot', 'logsRoot', 'artifactsRoot', 'backupsRoot'].flatMap((k) =>
        c[k as keyof StorageConfiguration] ? [[k, c[k as keyof StorageConfiguration]]] : []
      )
    ),
  } as StorageLayout;
}
export function defaultLayout(e: StorageEnvironment): StorageLayout {
  return {
    ...layoutFor(e.defaultDataRoot, e.defaultDataRoot, e.defaultConfigRoot),
    cacheRoot: e.defaultCacheRoot,
    logsRoot: e.defaultLogsRoot,
  };
}
async function atomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  const handle = await fs.open(temp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  const parent = await fs.open(path.dirname(file), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function volumeFor(folder: string): Promise<Volume> {
  if (process.platform !== 'linux') throw new StorageError('unsupportedPlatform');
  let current = folder;
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) throw new StorageError('unavailable');
    current = parent;
  }
  const { stdout } = await execute('findmnt', [
    '--json',
    '--target',
    current,
    '--output',
    'TARGET,UUID,FSTYPE',
  ]);
  const v = JSON.parse(stdout).filesystems?.[0];
  if (!v?.target) throw new StorageError('unavailable');
  // Non-root removable filesystems must have an identifiable mounted volume.
  if (v.target !== '/' && !v.uuid) throw new StorageError('unidentifiedVolume');
  return { mountpoint: v.target, uuid: v.uuid ?? '', type: v.fstype };
}
export async function probeFilesystem(
  folder: string
): Promise<{ volume: Volume; safeState: boolean; freeBytes: number }> {
  const volume = await volumeFor(folder);
  const stat = await fs.statfs(folder);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  const probe = await fs.mkdtemp(path.join(folder, '.local-ai-storage-probe-'));
  const results: boolean[] = [];
  try {
    const file = path.join(probe, 'file');
    await fs.writeFile(file, 'probe', { mode: 0o600 });
    // Writing and atomic replacement are mandatory even for bulk storage.
    await fs.rename(file, file + '.renamed');
    await fs.rename(file + '.renamed', file);
  } catch (error) {
    await fs.rm(probe, { recursive: true, force: true });
    throw error;
  }
  const attempt = async (operation: () => Promise<boolean | void>) => {
    try {
      results.push((await operation()) !== false);
    } catch {
      results.push(false);
    }
  };
  let alias: string | undefined;
  try {
    const file = path.join(probe, 'file');
    await attempt(async () => {
      await fs.chmod(file, 0o600);
      return ((await fs.stat(file)).mode & 0o777) === 0o600;
    });
    await attempt(async () => {
      await fs.link(file, path.join(probe, 'hard'));
    });
    await attempt(async () => {
      await fs.symlink('file', path.join(probe, 'link'));
    });
    await attempt(async () => {
      // A short symlink keeps AF_UNIX's pathname limit from misclassifying a
      // compatible filesystem when the chosen folder has a long path.
      alias = await fs.mkdtemp('/tmp/local-ai-fs-probe-');
      await fs.symlink(probe, path.join(alias, 'p'), 'dir');
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.listen(path.join(alias!, 'p', 'socket'), resolve);
      });
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    });
    await attempt(async () => {
      let db: DatabaseSync | undefined, second: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(path.join(probe, 'wal.db'));
        second = new DatabaseSync(path.join(probe, 'wal.db'));
        if (db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal') return false;
        second.exec('PRAGMA busy_timeout=0');
        db.exec('CREATE TABLE test(value); BEGIN IMMEDIATE');
        let blocked = false;
        try {
          second.exec('BEGIN IMMEDIATE');
          second.exec('ROLLBACK');
        } catch {
          blocked = true;
        }
        db.exec('ROLLBACK');
        return blocked && db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok';
      } finally {
        second?.close();
        db?.close();
      }
    });
    // Short probes cannot establish power-loss recovery on NTFS/exFAT/network FS.
    const safeState =
      ['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs'].includes(volume.type) &&
      results.every(Boolean);
    return { volume, safeState, freeBytes };
  } finally {
    if (alias) await fs.rm(alias, { recursive: true, force: true });
    await fs.rm(probe, { recursive: true, force: true });
  }
}
function isExcluded(relative: string, excludes: string[]) {
  return (
    relative
      .split(path.sep)
      .some(
        (n) =>
          n === 'SingletonLock' ||
          n === 'SingletonSocket' ||
          n === 'SingletonCookie' ||
          n === marker ||
          n === owner
      ) ||
    excludes.some((p) => relative === p || relative.startsWith(p + path.sep)) ||
    relative.endsWith('-shm')
  );
}
async function walk(
  root: string,
  visit: (file: string, relative: string, stat: sync.Stats) => Promise<void>,
  excludes: string[] = [],
  relative = ''
) {
  if (!(await exists(root))) return;
  for (const name of await fs.readdir(path.join(root, relative))) {
    const rel = path.join(relative, name);
    if (isExcluded(rel, excludes)) continue;
    const file = path.join(root, rel);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) await walk(root, visit, excludes, rel);
    else if (stat.isFile() || stat.isSymbolicLink()) await visit(file, rel, stat);
  }
}
async function hash(file: string) {
  const h = createHash('sha256');
  for await (const block of sync.createReadStream(file)) h.update(block);
  return h.digest('hex');
}
export async function verifySqlite(root: string, excludes: string[] = [], exclusive = true) {
  const candidates: string[] = [];
  await walk(
    root,
    async (file, _rel, stat) => {
      if (stat.isFile() && stat.size >= 16 && !file.endsWith('-wal')) candidates.push(file);
    },
    excludes
  );
  for (const file of candidates) {
    const handle = await fs.open(file, 'r');
    const header = Buffer.alloc(16);
    try {
      await handle.read(header, 0, 16, 0);
    } finally {
      await handle.close();
    }
    if (header.toString() !== 'SQLite format 3\u0000') continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: !exclusive });
      if (exclusive) db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
      const rows = db.prepare('PRAGMA integrity_check').all();
      if (rows.some((row) => row.integrity_check !== 'ok')) throw new Error('integrity');
    } catch {
      throw new StorageError('databaseBusyOrInvalid', path.basename(file));
    } finally {
      db?.close();
    }
  }
}
async function removeTree(root: string) {
  // Called only on journal-owned stage/retained directories.
  if (!(await exists(root))) return;
  const s = await fs.lstat(root);
  if (s.isDirectory() && !s.isSymbolicLink()) {
    await fs.chmod(root, s.mode | 0o700);
    for (const n of await fs.readdir(root)) await removeTree(path.join(root, n));
    await fs.rmdir(root);
  } else await fs.unlink(root);
}
async function syncDirectories(root: string) {
  for (const entry of await fs.readdir(root, { withFileTypes: true }))
    if (entry.isDirectory()) await syncDirectories(path.join(root, entry.name));
  const handle = await fs.open(root, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function paths(l: StorageLayout): Record<Category, string> {
  return {
    core: l.dataRoot,
    config: l.configRoot,
    cache: l.cacheRoot,
    logs: l.logsRoot,
    artifacts: l.artifactsRoot,
    backups: l.backupsRoot,
  };
}
export class StorageService {
  busy = false;
  readonly configFile: string;
  readonly journalFile: string;
  constructor(
    readonly environment: StorageEnvironment,
    readonly progress: (p: StorageProgress) => void = () => {},
    readonly probe = probeFilesystem
  ) {
    this.configFile =
      process.env.LOCAL_AI_DESKTOP_STORAGE_CONFIG ??
      path.join(environment.configHome, 'local-ai-desktop-storage.json');
    this.journalFile = path.join(environment.configHome, 'local-ai-desktop-storage-transfer.json');
  }
  current(): StorageLayout {
    if (this.environment.configuration) return configuredLayout(this.environment.configuration);
    const base = defaultLayout(this.environment);
    if (path.dirname(this.environment.electronRoot) === path.dirname(this.environment.backendRoot))
      base.dataRoot = path.dirname(this.environment.backendRoot);
    return {
      ...base,
      electronRoot: this.environment.electronRoot,
      backendRoot: this.environment.backendRoot,
      configRoot: path.join(this.environment.backendRoot, 'config'),
    };
  }
  async journal(): Promise<Journal | undefined> {
    return (await exists(this.journalFile))
      ? JSON.parse(await fs.readFile(this.journalFile, 'utf8'))
      : undefined;
  }
  async status(): Promise<StorageStatus> {
    const c = this.environment.configuration;
    const l = this.current();
    const j = await this.journal();
    const v = await volumeFor(l.bulkRoot).catch(() => undefined);
    const s = await fs.statfs(l.bulkRoot).catch(() => undefined);
    return {
      useDefault: c?.useDefault ?? !c,
      customPath: c?.selectedRoot ?? (c && c.useDefault !== true ? c.bulkRoot : ''),
      defaultPath: this.environment.defaultDataRoot,
      layout: l,
      freeBytes: s ? Number(s.bavail) * Number(s.bsize) : undefined,
      filesystem: v?.type,
      split: !!c && c.useDefault !== true && !inside(l.dataRoot, l.bulkRoot),
      busy: this.busy,
      cleanupAvailable: j?.phase === 'verified',
      recoveryAvailable: !!j && !['verified', 'cleaned', 'rolledBack'].includes(j.phase),
    };
  }
  async entries(): Promise<Entry[]> {
    const l = this.current();
    const out: Entry[] = [
      {
        category: 'core',
        relative: 'electron',
        source: l.electronRoot,
        excludes: [
          ...ELECTRON_CACHE_PATHS,
          'logs',
          ...(inside(l.backendRoot, l.electronRoot)
            ? [path.relative(l.electronRoot, l.backendRoot)]
            : []),
        ],
      },
      {
        category: 'core',
        relative: 'goose-backend',
        source: l.backendRoot,
        excludes: ['config', path.join('state', 'logs')],
      },
      {
        category: 'config',
        relative: '',
        source: l.configRoot,
        excludes: [path.join('mcp-hermit', 'cache')],
      },
      { category: 'artifacts', relative: '', source: l.artifactsRoot },
      { category: 'backups', relative: '', source: l.backupsRoot },
    ];
    if (this.environment.configuration) {
      out.push(
        { category: 'cache', relative: '', source: l.cacheRoot },
        { category: 'logs', relative: '', source: l.logsRoot }
      );
    } else {
      for (const n of ELECTRON_CACHE_PATHS)
        out.push({
          category: 'cache',
          relative: path.join('electron', n),
          source: path.join(l.electronRoot, n),
        });
      out.push(
        {
          category: 'cache',
          relative: 'mcp-hermit',
          source: path.join(l.configRoot, 'mcp-hermit', 'cache'),
        },
        { category: 'logs', relative: 'electron', source: path.join(l.electronRoot, 'logs') },
        { category: 'logs', relative: 'goose', source: path.join(l.backendRoot, 'state', 'logs') }
      );
    }
    // Older bootstrap files redirected only the top-level Chromium cache.
    if (this.environment.configuration)
      for (const n of ELECTRON_CACHE_PATHS) {
        const source = path.join(l.electronRoot, n),
          stat = await fs.lstat(source).catch(() => undefined);
        if (stat?.isDirectory())
          out.push({ category: 'cache', relative: path.join('electron', n), source });
      }
    // Legacy runtime log files lived directly beside profiles.
    if (await exists(l.electronRoot))
      for (const n of await fs.readdir(l.electronRoot))
        if (/^gguf-.*\.log(?:\.1)?$/.test(n)) {
          out[0].excludes!.push(n);
          out.push({
            category: 'logs',
            relative: path.join('runtime', n),
            source: path.join(l.electronRoot, n),
          });
        }
    return out.filter((e) => e.source);
  }
  async preview(choice: StorageChoice, forced?: StorageLayout): Promise<StoragePreview> {
    if (typeof choice.useDefault !== 'boolean') throw new StorageError('invalidPath');
    const current = await this.status();
    if (
      !forced &&
      choice.useDefault === current.useDefault &&
      (choice.useDefault ||
        path.resolve(choice.customPath ?? '') === path.resolve(current.customPath))
    )
      return {
        choice,
        layout: current.layout,
        filesystem: current.filesystem ?? '',
        split: current.split,
        requiredBytes: 0,
        freeBytes: current.freeBytes ?? 0,
        unchanged: true,
      };
    let target: StorageLayout;
    let checked;
    if (forced) {
      target = forced;
      let parent = target.bulkRoot;
      while (!(await exists(parent))) parent = path.dirname(parent);
      checked = await this.probe(parent);
    } else if (choice.useDefault) {
      target = defaultLayout(this.environment);
      let parent = path.dirname(target.dataRoot);
      while (!(await exists(parent))) parent = path.dirname(parent);
      checked = await this.probe(parent);
      if (!checked.safeState) throw new StorageError('unsafeDefault');
    } else {
      if (!choice.customPath || !path.isAbsolute(choice.customPath))
        throw new StorageError('invalidPath');
      const selected = await fs.realpath(choice.customPath).catch(() => {
        throw new StorageError('unavailable');
      });
      if (selected === path.parse(selected).root || selected === os.homedir())
        throw new StorageError('chooseAppFolder');
      if (
        (await exists(path.join(selected, marker))) &&
        selected !== current.customPath &&
        selected !== current.layout.bulkRoot
      ) {
        const known = await fs.readFile(path.join(selected, owner), 'utf8').catch(() => '');
        const old = await this.journal();
        if (
          (!this.environment.configuration?.installationId ||
            !known.startsWith(this.environment.configuration.installationId + '\n')) &&
          !(old && known === old.installationId + '\n' + old.id)
        )
          throw new StorageError('destinationConflict', selected);
      }
      checked = await this.probe(selected);
      if (checked.safeState) target = layoutFor(path.join(selected, 'data'), selected);
      else {
        const safe = await volumeFor(current.layout.dataRoot);
        if (!['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs'].includes(safe.type))
          throw new StorageError('unsafeDefault');
        target = layoutFor(
          current.layout.dataRoot,
          selected,
          path.join(current.layout.dataRoot, 'goose-backend', 'config')
        );
      }
    }
    const entries = await this.entries();
    let requiredBytes = 0;
    for (const e of entries) {
      const s = await fs.stat(e.source).catch(() => undefined);
      if (!s) continue;
      if (s.isFile()) requiredBytes += s.size;
      else
        await walk(
          e.source,
          async (_f, _r, stat) => {
            if (stat.isFile()) requiredBytes += stat.size;
          },
          e.excludes
        );
    }
    requiredBytes += 64 * 1024 * 1024;
    if (checked.freeBytes < requiredBytes) throw new StorageError('insufficientSpace');
    const journal = await this.journal();
    const installationId = this.environment.configuration?.installationId;
    const sourceRoots = Object.values(paths(current.layout));
    // The retained source of the last verified transaction is our own previous
    // installation, including a default bootstrap created before ownership IDs.
    const trusted = journal ? Object.values(paths(journal.source)) : [];
    for (const dest of Object.values(paths(target))) {
      // Same path is permitted for an atomic in-place swap on the safe POSIX volume.
      for (const source of sourceRoots)
        if (dest !== source && inside(dest, source) && !sourceRoots.includes(dest))
          throw new StorageError('nestedStorage');
      if (await exists(dest)) {
        const real = await fs.realpath(dest);
        const same =
          sourceRoots.some((p) => p === dest) ||
          (await Promise.all(sourceRoots.map((p) => fs.realpath(p).catch(() => p))).then((all) =>
            all.includes(real)
          ));
        const ownership = await fs.readFile(path.join(dest, owner), 'utf8').catch(() => '');
        if (
          !same &&
          !(
            trusted.includes(dest) &&
            (!ownership || ownership.startsWith(journal!.installationId + '\n'))
          ) &&
          !(installationId && ownership.startsWith(installationId + '\n')) &&
          !(journal && ownership === journal.installationId + '\n' + journal.id)
        )
          throw new StorageError('destinationConflict', dest);
      }
      let parent = path.dirname(dest);
      while (!(await exists(parent))) parent = path.dirname(parent);
      const stat = await fs.statfs(parent);
      if (Number(stat.bavail) * Number(stat.bsize) < requiredBytes)
        throw new StorageError('insufficientSpace');
    }
    return {
      choice,
      layout: target,
      filesystem: checked.volume.type,
      split: !inside(target.dataRoot, target.bulkRoot),
      requiredBytes,
      freeBytes: checked.freeBytes,
      unchanged: false,
    };
  }
  async transfer(choice: StorageChoice, quiesce: () => Promise<void>, forced?: StorageLayout) {
    if (this.busy) throw new StorageError('migrationBusy');
    this.busy = true;
    let journal: Journal | undefined;
    let committed = false;
    try {
      this.progress({ phase: 'checking', completed: 0, total: 0 });
      const preview = await this.preview(choice, forced);
      if (preview.unchanged) return;
      const oldJournal = await this.journal();
      if (oldJournal && !['verified', 'cleaned', 'rolledBack', 'failed'].includes(oldJournal.phase))
        throw new StorageError('recoveryRequired');
      if (oldJournal?.phase === 'failed')
        for (const group of oldJournal.groups) {
          const content = await fs.readFile(path.join(group.stage, owner), 'utf8').catch(() => '');
          if (content === oldJournal.installationId + '\n' + oldJournal.id)
            await removeTree(group.stage);
        }
      const id = randomUUID();
      const installationId =
        this.environment.configuration?.installationId ??
        oldJournal?.installationId ??
        randomUUID();
      const target = preview.layout;
      const rootPaths = Object.values(paths(target));
      const top = rootPaths.filter(
        (p, i) =>
          rootPaths.indexOf(p) === i && !rootPaths.some((other) => other !== p && inside(p, other))
      );
      const groups: Group[] = top.map((final) => ({
        final,
        stage: path.join(path.dirname(final), `.local-ai-transfer-${id}-${path.basename(final)}`),
        retained: final + `.storage-previous-${id}`,
        existed: false,
      }));
      const volumes: StorageConfiguration['volumes'] = [];
      for (const dest of top) {
        const v = await volumeFor(dest);
        if (!volumes.some((p) => p.mountpoint === v.mountpoint) && v.uuid)
          volumes.push({ mountpoint: v.mountpoint, uuid: v.uuid });
      }
      const configuration: StorageConfiguration = {
        version: 1,
        ...target,
        useDefault: choice.useDefault,
        selectedRoot: choice.useDefault ? undefined : choice.customPath,
        installationId,
        transferId: id,
        volumes,
      };
      journal = {
        id,
        installationId,
        phase: 'quiescing',
        previous: this.environment.configuration ?? null,
        target: configuration,
        source: this.current(),
        groups,
        manifest: path.join(target.backupsRoot, `storage-transfer-${id}.json`),
        files: [],
      };
      await atomic(this.journalFile, { ...journal, files: [] });
      await quiesce();
      // The picker/preflight may have preceded shutdown by seconds. Recheck the
      // exact mounted devices before creating any destination/staging directories.
      for (const volume of volumes) {
        const actual = await volumeFor(volume.mountpoint);
        if (actual.mountpoint !== volume.mountpoint || actual.uuid !== volume.uuid)
          throw new StorageError('unavailable');
      }
      const entries = await this.entries();
      for (const e of entries.filter((e) => e.category === 'core' || e.category === 'config'))
        if (
          await fs.stat(e.source).then(
            (s) => s.isDirectory(),
            () => false
          )
        )
          await verifySqlite(e.source, e.excludes);
      // Catch another app instance/process still writing this state after our own backends stopped.
      await this.assertNoWriters(entries.map((e) => e.source));
      journal.phase = 'copying';
      await atomic(this.journalFile, { ...journal, files: [] });
      for (const group of groups) {
        await fs.mkdir(group.stage, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(group.stage, owner), installationId + '\n' + id, {
          mode: 0o600,
        });
      }
      const stageFor = (dest: string) => {
        const group = groups.find((g) => inside(dest, g.final))!;
        return path.join(group.stage, path.relative(group.final, dest));
      };
      for (const dest of rootPaths)
        await fs.mkdir(stageFor(dest), { recursive: true, mode: 0o700 });
      let completed = 0;
      const total = preview.requiredBytes - 64 * 1024 * 1024;
      for (const entry of entries) {
        const destination = stageFor(path.join(paths(target)[entry.category], entry.relative));
        const sourceStat = await fs.stat(entry.source).catch(() => undefined);
        if (!sourceStat) continue;
        const copy = async (file: string, relative: string, stat: sync.Stats) => {
          const dest = relative ? path.join(destination, relative) : destination;
          await fs.mkdir(path.dirname(dest), { recursive: true });
          if (stat.isSymbolicLink()) {
            await fs.symlink(await fs.readlink(file), dest);
            return;
          }
          if (file.endsWith('.gguf')) throw new StorageError('weightsInsideStorage');
          const before = await fs.stat(file);
          await fs.copyFile(file, dest, sync.constants.COPYFILE_EXCL);
          await fs.chmod(dest, before.mode & 0o777);
          await fs.utimes(dest, before.atime, before.mtime);
          const copied = await fs.open(dest, 'r');
          try {
            await copied.sync();
          } finally {
            await copied.close();
          }
          const [left, right, after] = await Promise.all([hash(file), hash(dest), fs.stat(file)]);
          if (left !== right || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
            throw new StorageError('sourceChanged');
          const logical = path.join(paths(target)[entry.category], entry.relative, relative);
          const group = groups.find((g) => inside(logical, g.final))!;
          journal!.files.push({
            root: group.final,
            relative: path.relative(group.final, logical),
            hash: right,
            size: before.size,
            source: file,
          });
          completed += before.size;
          this.progress({ phase: 'copying', completed, total });
        };
        if (sourceStat.isFile()) await copy(entry.source, '', sourceStat);
        else await walk(entry.source, copy, entry.excludes);
      }
      const link = async (dest: string, to: string) => {
        if (dest === to) return;
        await fs.mkdir(path.dirname(stageFor(dest)), { recursive: true });
        await fs.symlink(to, stageFor(dest), 'dir');
      };
      await link(path.join(target.backendRoot, 'config'), target.configRoot);
      await link(
        path.join(target.backendRoot, 'state', 'logs'),
        path.join(target.logsRoot, 'goose')
      );
      await link(
        path.join(target.configRoot, 'mcp-hermit', 'cache'),
        path.join(target.cacheRoot, 'mcp-hermit')
      );
      await link(path.join(target.electronRoot, 'logs'), path.join(target.logsRoot, 'electron'));
      for (const name of ELECTRON_CACHE_PATHS)
        await link(
          path.join(target.electronRoot, name),
          path.join(target.cacheRoot, 'electron', name)
        );
      if (inside(this.current().backendRoot, this.current().electronRoot))
        await link(
          path.join(
            target.electronRoot,
            path.relative(this.current().electronRoot, this.current().backendRoot)
          ),
          target.backendRoot
        );
      for (const dir of ['goose', 'electron', 'runtime'])
        await fs.mkdir(stageFor(path.join(target.logsRoot, dir)), { recursive: true });
      await fs.mkdir(stageFor(path.join(target.cacheRoot, 'mcp-hermit')), { recursive: true });
      for (const name of ELECTRON_CACHE_PATHS)
        await fs.mkdir(stageFor(path.join(target.cacheRoot, 'electron', name)), {
          recursive: true,
        });
      for (const root of [target.dataRoot, target.bulkRoot]) {
        if (groups.some((g) => inside(root, g.final)))
          await fs.writeFile(stageFor(path.join(root, marker)), 'Local AI Desktop storage v1\n');
      }
      this.progress({ phase: 'verifying', completed, total });
      await this.assertNoWriters(entries.map((e) => e.source));
      const expectedFiles = new Map(journal.files.map((file) => [file.source, file.hash]));
      for (const entry of entries) {
        const stat = await fs.stat(entry.source).catch(() => undefined);
        if (!stat) continue;
        const check = async (file: string, _rel: string, s: sync.Stats) => {
          if (
            s.isFile() &&
            (!expectedFiles.has(file) || (await hash(file)) !== expectedFiles.get(file))
          )
            throw new StorageError('sourceChanged');
        };
        if (stat.isFile()) await check(entry.source, '', stat);
        else await walk(entry.source, check, entry.excludes);
      }
      for (const file of expectedFiles.keys())
        if (!(await exists(file))) throw new StorageError('sourceChanged');
      // Validate staged databases without following the links that still point at their final locations.
      await verifySqlite(stageFor(target.dataRoot), [], false);
      if (!inside(target.configRoot, target.dataRoot))
        await verifySqlite(stageFor(target.configRoot), [], false);
      for (const group of groups) await syncDirectories(group.stage);
      journal.phase = 'installing';
      await atomic(this.journalFile, { ...journal, files: [] });
      for (const group of groups) {
        const expected = volumes
          .filter((v) => inside(group.final, v.mountpoint))
          .sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0];
        if (expected) {
          const actual = await volumeFor(group.final);
          if (actual.mountpoint !== expected.mountpoint || actual.uuid !== expected.uuid)
            throw new StorageError('unavailable');
        }
        if (await exists(group.final)) {
          group.existed = true;
          await atomic(this.journalFile, { ...journal, files: [] });
          await fs.rename(group.final, group.retained);
        }
        await fs.rename(group.stage, group.final);
        const parent = await fs.open(path.dirname(group.final), 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
      // bulkRoot is only a container, not an independently replaceable directory.
      await fs.mkdir(target.bulkRoot, { recursive: true });
      if (!(await exists(path.join(target.bulkRoot, marker))))
        await fs.writeFile(path.join(target.bulkRoot, marker), 'Local AI Desktop storage v1\n');
      if (!(await exists(path.join(target.bulkRoot, owner))))
        await fs.writeFile(path.join(target.bulkRoot, owner), installationId + '\n' + id, {
          mode: 0o600,
        });
      await atomic(journal.manifest, journal);
      await atomic(this.configFile, configuration);
      committed = true;
      journal.phase = 'committed';
      await atomic(this.journalFile, { ...journal, files: [] });
      this.progress({ phase: 'restarting', completed: total, total });
    } catch (error) {
      if (journal && !committed) {
        journal.error = String(error);
        await this.restore(journal);
        journal.phase = 'failed';
        await atomic(this.journalFile, { ...journal, files: [] });
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async assertNoWriters(roots: string[]) {
    if (process.platform !== 'linux') return;
    const resolved = await Promise.all(roots.map((p) => fs.realpath(p).catch(() => p)));
    for (const pid of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      const fds = await fs.readdir(`/proc/${pid}/fd`).catch(() => []);
      for (const fd of fds) {
        const file = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
        if (resolved.some((root) => inside(file, root))) throw new StorageError('storageInUse');
      }
    }
  }
  async restore(j: Journal) {
    for (const group of [...j.groups].reverse()) {
      const content = await fs.readFile(path.join(group.final, owner), 'utf8').catch(() => '');
      if (content === j.installationId + '\n' + j.id) {
        if (await exists(group.stage)) await removeTree(group.stage);
        await fs.rename(group.final, group.stage);
      }
      if (await exists(group.retained)) {
        if (await exists(group.final)) throw new StorageError('recoveryConflict');
        await fs.rename(group.retained, group.final);
      }
    }
    if (j.previous) await atomic(this.configFile, j.previous);
    else await fs.rm(this.configFile, { force: true });
  }
  async recover() {
    const j = await this.journal();
    if (!j || ['verified', 'cleaned', 'rolledBack', 'failed'].includes(j.phase)) return;
    const c = await fs.readFile(this.configFile, 'utf8').then(
      (t) => JSON.parse(t) as StorageConfiguration,
      () => undefined
    );
    if (c?.transferId === j.id) {
      j.phase = 'committed';
      await atomic(this.journalFile, j);
      return;
    }
    await this.restore(j);
    j.phase = 'failed';
    j.error = 'interrupted';
    await atomic(this.journalFile, j);
  }
  async verifyStartup() {
    const j = await this.journal();
    if (j?.phase !== 'committed') return;
    const full: Journal = JSON.parse(await fs.readFile(j.manifest, 'utf8'));
    // Cache/log files may change during startup. Durable user state must match the verified copy.
    for (const file of full.files.filter(
      (f) =>
        inside(path.join(f.root, f.relative), j.target.dataRoot) ||
        inside(path.join(f.root, f.relative), j.target.configRoot ?? '')
    )) {
      const actual = path.join(file.root, file.relative);
      if ((await hash(actual)) !== file.hash) throw new StorageError('startupVerification');
    }
    await verifySqlite(j.target.dataRoot, [], false);
    if (j.target.configRoot && !inside(j.target.configRoot, j.target.dataRoot))
      await verifySqlite(j.target.configRoot, [], false);
  }
  async confirmStartup() {
    const j = await this.journal();
    if (j?.phase === 'committed') {
      j.phase = 'verified';
      await atomic(this.journalFile, j);
    }
  }
  async rollback(quiesce: () => Promise<void> = async () => {}) {
    if (this.busy) throw new StorageError('migrationBusy');
    const j = await this.journal();
    if (!j || j.phase === 'cleaned') throw new StorageError('noRollback');
    if (j.phase === 'verified') {
      const choice = {
        useDefault: j.previous?.useDefault ?? !j.previous,
        customPath: j.previous?.selectedRoot ?? j.previous?.bulkRoot,
      };
      await this.transfer(choice, quiesce, j.previous ? j.source : defaultLayout(this.environment));
    } else {
      await quiesce();
      await this.restore(j);
      j.phase = 'rolledBack';
      await atomic(this.journalFile, j);
    }
  }

  async cleanup() {
    if (this.busy) throw new StorageError('migrationBusy');
    const j = await this.journal();
    if (j?.phase !== 'verified') throw new StorageError('notVerified');
    const full: Journal = JSON.parse(await fs.readFile(j.manifest, 'utf8'));
    // Do not delete historical, pre-GUI migration sources: their external receipts remain usable.
    const sourcePaths = paths(j.source),
      targetPaths = paths(configuredLayout(j.target));
    const roots = Object.entries(sourcePaths).filter(
      ([, root], i, all) =>
        all.findIndex(([, p]) => p === root) === i &&
        !all.some(([, p]) => p !== root && inside(root, p))
    );
    for (const [category, root] of roots) {
      if (Object.values(targetPaths).some((p) => inside(p, root))) continue;
      const stat = await fs.lstat(root).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) continue;
      const content = await fs.readFile(path.join(root, owner), 'utf8').catch(() => '');
      if (!content.startsWith(j.installationId + '\n')) continue;
      await this.assertNoWriters([root]);
      const copied = new Set(full.files.map((file) => file.source));
      await walk(root, async (file, _rel, stat) => {
        if (stat.isFile() && !copied.has(file)) throw new StorageError('sourceChanged');
      });
      for (const file of full.files.filter((f) => inside(f.source, root)))
        if ((await hash(file.source)) !== file.hash) throw new StorageError('sourceChanged');
      const destination = targetPaths[category as Category];
      // Keep former per-category paths resolving to their new equivalents for old receipts and launchers.
      for (const [child, childRoot] of Object.entries(sourcePaths))
        if (childRoot !== root && inside(childRoot, root)) {
          const alias = path.join(destination, path.relative(root, childRoot));
          const goal = targetPaths[child as Category];
          if (alias !== goal && !(await exists(alias))) {
            await fs.mkdir(path.dirname(alias), { recursive: true });
            await fs.symlink(goal, alias, 'dir');
          }
        }
      const retained = root + `.storage-cleanup-${j.id}`;
      await fs.rename(root, retained);
      try {
        await fs.symlink(destination, root, 'dir');
      } catch (error) {
        await fs.rename(retained, root);
        throw error;
      }
      await removeTree(retained);
    }
    for (const group of j.groups)
      if (group.existed && (await exists(group.retained))) await removeTree(group.retained);
    j.phase = 'cleaned';
    await atomic(this.journalFile, j);
  }
}

// Called before any app path is opened. Interrupted pre-commit copies never become a new empty state.
export function recoverInterruptedStorage(configHome: string, rollbackUnverified = false) {
  const file = path.join(configHome, 'local-ai-desktop-storage-transfer.json');
  if (!sync.existsSync(file)) return;
  const j: Journal = JSON.parse(sync.readFileSync(file, 'utf8'));
  if (['verified', 'cleaned', 'rolledBack', 'failed'].includes(j.phase)) {
    if (rollbackUnverified) throw new StorageError('noRollback');
    return;
  }
  const configFile =
    process.env.LOCAL_AI_DESKTOP_STORAGE_CONFIG ??
    path.join(configHome, 'local-ai-desktop-storage.json');
  const c = sync.existsSync(configFile)
    ? (JSON.parse(sync.readFileSync(configFile, 'utf8')) as StorageConfiguration)
    : undefined;
  if (!rollbackUnverified && c?.transferId === j.id) {
    // A crash may occur between the bootstrap rename and the journal update.
    j.phase = 'committed';
    const temp = file + '.tmp';
    sync.writeFileSync(temp, JSON.stringify(j, null, 2), { mode: 0o600 });
    sync.renameSync(temp, file);
    return; // Verified asynchronously before a backend starts.
  }
  for (const group of [...j.groups].reverse()) {
    const current = sync.existsSync(path.join(group.final, owner))
      ? sync.readFileSync(path.join(group.final, owner), 'utf8')
      : '';
    if (current === j.installationId + '\n' + j.id) {
      if (sync.existsSync(group.stage)) throw new StorageError('recoveryConflict');
      sync.renameSync(group.final, group.stage);
    }
    if (sync.existsSync(group.retained)) {
      if (sync.existsSync(group.final)) throw new StorageError('recoveryConflict');
      sync.renameSync(group.retained, group.final);
    }
  }
  if (j.previous) {
    const temp = configFile + '.tmp';
    sync.writeFileSync(temp, JSON.stringify(j.previous, null, 2), { mode: 0o600 });
    sync.renameSync(temp, configFile);
  } else if (sync.existsSync(configFile)) sync.unlinkSync(configFile);
  j.phase = 'failed';
  j.error = 'interrupted';
  const temp = file + '.tmp';
  sync.writeFileSync(temp, JSON.stringify(j, null, 2), { mode: 0o600 });
  sync.renameSync(temp, file);
}

// Must run before loading Electron sessions: Chromium legitimately changes its
// LevelDB files and may hold SQLite locks as soon as the default session opens.
export function verifyCommittedStorageSync(configHome: string) {
  const file = path.join(configHome, 'local-ai-desktop-storage-transfer.json');
  if (!sync.existsSync(file)) return;
  const j: Journal = JSON.parse(sync.readFileSync(file, 'utf8'));
  if (j.phase !== 'committed') return;
  const full: Journal = JSON.parse(sync.readFileSync(j.manifest, 'utf8'));
  for (const f of full.files) {
    const actual = path.join(f.root, f.relative);
    if (!inside(actual, j.target.dataRoot) && !inside(actual, j.target.configRoot ?? '')) continue;
    const digest = createHash('sha256'),
      buffer = Buffer.alloc(1024 * 1024),
      fd = sync.openSync(actual, 'r');
    try {
      let size;
      while ((size = sync.readSync(fd, buffer, 0, buffer.length, null)) > 0)
        digest.update(buffer.subarray(0, size));
    } finally {
      sync.closeSync(fd);
    }
    if (digest.digest('hex') !== f.hash) throw new StorageError('startupVerification', f.relative);
  }
  const check = (root: string) => {
    for (const entry of sync.readdirSync(root, { withFileTypes: true })) {
      const at = path.join(root, entry.name);
      if (entry.isDirectory()) {
        check(at);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue;
      const header = Buffer.alloc(16),
        fd = sync.openSync(at, 'r');
      try {
        sync.readSync(fd, header, 0, 16, 0);
      } finally {
        sync.closeSync(fd);
      }
      if (header.toString() !== 'SQLite format 3\u0000') continue;
      const db = new DatabaseSync(at, { readOnly: true });
      try {
        if (
          db
            .prepare('PRAGMA integrity_check')
            .all()
            .some((r) => r.integrity_check !== 'ok')
        )
          throw new StorageError('databaseBusyOrInvalid', entry.name);
      } finally {
        db.close();
      }
    }
  };
  check(j.target.dataRoot);
  if (j.target.configRoot && !inside(j.target.configRoot, j.target.dataRoot))
    check(j.target.configRoot);
}
