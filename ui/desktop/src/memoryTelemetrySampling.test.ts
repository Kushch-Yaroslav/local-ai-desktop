import { vi, it, expect } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), read: vi.fn() }));
vi.mock('node:child_process', () => {
  const exec = Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: mocks.execute,
  });
  return { execFile: exec, default: { execFile: exec } };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, default: { ...actual, readFile: mocks.read }, readFile: mocks.read };
});
import { sampleMemory } from './memoryTelemetry';
it('uses a bounded cancellable query and returns unavailable GPUs on timeout/missing utility', async () => {
  mocks.read.mockResolvedValue('MemTotal: 10000 kB\nMemAvailable: 4000 kB\n');
  mocks.execute.mockRejectedValue(Error('timeout'));
  const controller = new AbortController();
  expect(await sampleMemory(controller.signal)).toEqual({
    ram: { used: 6000 * 1024, total: 10000 * 1024 },
    gpus: [],
  });
  expect(mocks.execute).toHaveBeenCalledWith(
    'nvidia-smi',
    [
      '--query-gpu=index,memory.used,memory.total,utilization.gpu',
      '--format=csv,noheader,nounits',
    ],
    { timeout: 1200, signal: controller.signal }
  );
  mocks.read.mockRejectedValue(Error('unsupported platform'));
  mocks.execute.mockRejectedValue(Error('ENOENT'));
  expect(await sampleMemory(controller.signal)).toEqual({ ram: null, gpus: [] });
});
