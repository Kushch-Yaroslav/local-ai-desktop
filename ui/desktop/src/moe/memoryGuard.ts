// Adapted from v0.3.2.0 launcher: 7 GiB reserve, owned model cgroup, no global swap changes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { modelCgroupLimitMiB } from './model-memory';
const execute = promisify(execFile);
export function placementMemorySafe(meminfo: string): boolean {
  const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1]);
  return Number.isFinite(available) && available >= 7 * 1024 * 1024;
}
export async function attachOwnedMemoryScope(pid: number): Promise<void> {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0)
    throw Error('GGUF:placement:Linux user cgroup v2 is required for selective placement/cache');
  const mem = await readFile('/proc/meminfo', 'utf8');
  const total = Number(/^MemTotal:\s+(\d+)/m.exec(mem)?.[1]) / 1024;
  if (!Number.isFinite(total) || !placementMemorySafe(mem))
    throw Error('GGUF:placement:7 GiB RAM reserve unavailable');
  const limit = modelCgroupLimitMiB(total) * 1024 ** 2;
  await execute(
    '/usr/bin/busctl',
    [
      '--user',
      'call',
      'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager',
      'StartTransientUnit',
      'ssa(sv)a(sa(sv))',
      `lad-gguf-${pid}-${Date.now()}.scope`,
      'fail',
      '3',
      'PIDs',
      'au',
      '1',
      String(pid),
      'MemoryMax',
      't',
      String(limit),
      'MemorySwapMax',
      't',
      '0',
      '0',
    ],
    { timeout: 5000, maxBuffer: 4096 }
  );
  let observed = '';
  // StartTransientUnit returns a job path before the PID has moved into the scope.
  for (let attempt = 0; attempt < 100; attempt++) {
    const relative = /^0::(.*)$/m.exec(await readFile(`/proc/${pid}/cgroup`, 'utf8'))?.[1];
    if (!relative?.startsWith('/') || relative.includes('..'))
      throw Error('GGUF:placement:Owned cgroup confirmation unavailable');
    const root = '/sys/fs/cgroup' + relative;
    const [max, swap] = await Promise.all([
      readFile(root + '/memory.max', 'utf8'),
      readFile(root + '/memory.swap.max', 'utf8'),
    ]);
    observed = `memory.max=${max.trim()}, memory.swap.max=${swap.trim()}`;
    if (Number(max) === limit && Number(swap) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('GGUF:placement:MemoryMax/MemorySwapMax confirmation failed: ' + observed);
}
export function watchOwnedMemory(onUnsafe: () => void): () => void {
  let stopped = false,
    inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void readFile('/proc/meminfo', 'utf8')
      .then((text) => {
        if (!stopped && !placementMemorySafe(text)) onUnsafe();
      })
      .catch(() => {
        if (!stopped) onUnsafe();
      })
      .finally(() => {
        inFlight = false;
      });
  }, 1000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
