// Modified for Local AI Desktop: fail closed before opening relocated application state.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { StorageLayout } from './storageTypes';
export const ELECTRON_CACHE_PATHS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'Dictionaries',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
].flatMap((name) => [name, path.join('Partitions', 'goose', name)]);
export interface StorageConfiguration {
  version: 1;
  dataRoot: string;
  bulkRoot: string;
  useDefault?: boolean;
  selectedRoot?: string;
  installationId?: string;
  transferId?: string;
  configRoot?: string;
  cacheRoot?: string;
  logsRoot?: string;
  artifactsRoot?: string;
  backupsRoot?: string;
  volumes: Array<{ mountpoint: string; uuid: string }>;
}
export function validateStorage(
  config: StorageConfiguration,
  mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8')
) {
  if (
    config.version !== 1 ||
    !path.isAbsolute(config.dataRoot) ||
    !path.isAbsolute(config.bulkRoot)
  )
    throw new Error('Invalid storage configuration');
  for (const volume of config.volumes) {
    const mounted = mounts.split('\n').some((line) => {
      const [before, after] = line.split(' - ');
      const mountpoint = before
        .split(' ')[4]
        ?.replace(/\\(040|011|012|134)/g, (_match, octal) =>
          String.fromCharCode(parseInt(octal, 8))
        );
      if (mountpoint !== volume.mountpoint || !after) return false;
      return (
        fs.realpathSync(`/dev/disk/by-uuid/${volume.uuid}`) === fs.realpathSync(after.split(' ')[1])
      );
    });
    if (!mounted) throw new Error(`Storage volume is not mounted: ${volume.mountpoint}`);
  }
  for (const root of [config.dataRoot, config.bulkRoot]) {
    if (!fs.existsSync(path.join(root, '.local-ai-desktop-storage')))
      throw new Error(`Storage marker missing: ${root}`);
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  }
  return config;
}
export function readStorageConfiguration(configHome: string): StorageConfiguration | undefined {
  const file =
    process.env.LOCAL_AI_DESKTOP_STORAGE_CONFIG ??
    path.join(configHome, 'local-ai-desktop-storage.json');
  if (fs.existsSync(file)) return validateStorage(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (process.env.LOCAL_AI_DESKTOP_STORAGE_CONFIG)
    throw new Error(`Storage configuration missing: ${file}`);
  const root = process.env.LOCAL_AI_DESKTOP_DATA_DIR;
  if (root) {
    if (!path.isAbsolute(root) || !fs.existsSync(path.join(root, '.local-ai-desktop-storage')))
      throw new Error(
        'LOCAL_AI_DESKTOP_DATA_DIR must be an existing initialized absolute directory'
      );
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
    return { version: 1, dataRoot: root, bulkRoot: root, volumes: [] };
  }
  return undefined;
}

// Only an empty installation is initialized automatically. Existing installations are
// presented as-is; moving them requires the explicit Apply action.
export function initializeDefaultStorage(
  configHome: string,
  layout: StorageLayout,
  legacyRoots: string[]
): StorageConfiguration | undefined {
  if (process.platform !== 'linux') return;
  if (legacyRoots.some((root) => fs.existsSync(root) && fs.readdirSync(root).length > 0)) return;
  const volumes: StorageConfiguration['volumes'] = [];
  for (const root of [layout.dataRoot, layout.configRoot, layout.cacheRoot, layout.logsRoot]) {
    let parent = root;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const v = JSON.parse(
      execFileSync('findmnt', ['--json', '--target', parent, '--output', 'TARGET,UUID,FSTYPE'], {
        encoding: 'utf8',
      })
    ).filesystems[0];
    if (!['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs'].includes(v.fstype))
      throw new Error('Default storage requires a compatible filesystem');
    if (v.target !== '/' && !v.uuid) throw new Error('Default storage volume cannot be identified');
    if (v.uuid && !volumes.some((p) => p.mountpoint === v.target))
      volumes.push({ mountpoint: v.target, uuid: v.uuid });
  }
  for (const root of [
    layout.dataRoot,
    layout.configRoot,
    layout.cacheRoot,
    layout.logsRoot,
    layout.artifactsRoot,
    layout.backupsRoot,
    layout.electronRoot,
    layout.backendRoot,
  ])
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const link = (at: string, to: string) => {
    if (at === to) return;
    fs.mkdirSync(path.dirname(at), { recursive: true });
    if (!fs.existsSync(at)) fs.symlinkSync(to, at, 'dir');
  };
  link(path.join(layout.backendRoot, 'config'), layout.configRoot);
  for (const kind of ['goose', 'electron', 'runtime'])
    fs.mkdirSync(path.join(layout.logsRoot, kind), { recursive: true });
  fs.mkdirSync(path.join(layout.cacheRoot, 'mcp-hermit'), { recursive: true });
  link(path.join(layout.backendRoot, 'state', 'logs'), path.join(layout.logsRoot, 'goose'));
  link(
    path.join(layout.configRoot, 'mcp-hermit', 'cache'),
    path.join(layout.cacheRoot, 'mcp-hermit')
  );
  link(path.join(layout.electronRoot, 'logs'), path.join(layout.logsRoot, 'electron'));
  for (const name of ELECTRON_CACHE_PATHS) {
    const to = path.join(layout.cacheRoot, 'electron', name);
    fs.mkdirSync(to, { recursive: true });
    link(path.join(layout.electronRoot, name), to);
  }
  fs.writeFileSync(
    path.join(layout.dataRoot, '.local-ai-desktop-storage'),
    'Local AI Desktop storage v1\n'
  );
  const configuration: StorageConfiguration = { version: 1, ...layout, useDefault: true, volumes };
  fs.mkdirSync(configHome, { recursive: true });
  const file = path.join(configHome, 'local-ai-desktop-storage.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(configuration, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return configuration;
}
