import { describe, expect, it } from 'vitest';
import { parseRam, parseGpus } from './memoryTelemetry';
describe('physical memory telemetry', () => {
  it('uses available rather than MemFree and keeps binary units', () => {
    expect(parseRam('MemTotal: 10000 kB\nMemFree: 100 kB\nMemAvailable: 4000 kB\n')).toEqual({
      used: 6000 * 1024,
      total: 10000 * 1024,
    });
    expect(parseRam('MemTotal: 1 kB\n')).toBeNull();
    expect(parseRam('MemTotal: 1 kB\nMemAvailable: 2 kB\n')).toBeNull();
  });
  it('keeps physical GPUs separate, rejects fake zeros and invalid readings', () => {
    expect(
      parseGpus('0, 1024, 24576, 83\n1, 2048, 49152, N/A').map((g) => [
        g.id,
        g.used / 1024 ** 3,
        g.total / 1024 ** 3,
        g.utilizationPercent,
      ])
    ).toEqual([
      ['0', 1, 24, 83],
      ['1', 2, 48, null],
    ]);
    expect(parseGpus('0, N/A, 24576\n1, 50, 40\n')).toEqual([]);
    expect(parseGpus('')).toEqual([]);
    expect(parseGpus('0, 1024, 24576, 101')).toEqual([
      { id: '0', used: 1024 * 1024 ** 2, total: 24576 * 1024 ** 2, utilizationPercent: null },
    ]);
  });
});
