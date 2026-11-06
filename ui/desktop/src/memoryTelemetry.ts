// Local AI Desktop: bounded read-only system telemetry, separate from discovery budgets.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MemorySnapshot } from './memoryTelemetryTypes';
const execute = promisify(execFile);
export function parseRam(text: string) {
  const fields = Object.fromEntries(
    [...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB$/gm)].map(([, k, v]) => [
      k,
      Number(v) * 1024,
    ])
  );
  const total = fields.MemTotal,
    available = fields.MemAvailable;
  return Number.isFinite(total) &&
    total > 0 &&
    Number.isFinite(available) &&
    available >= 0 &&
    available <= total
    ? { used: total - available, total }
    : null;
}
export function parseGpus(text: string) {
  return text
    .trim()
    .split(/\r?\n/)
    .flatMap((row) => {
      const [id, usedText, totalText, utilizationText] = row.split(',').map((v) => v.trim());
      const used = Number(usedText),
        total = Number(totalText);
      const utilization = Number(utilizationText);
      return id &&
        usedText &&
        totalText &&
        Number.isFinite(used) &&
        Number.isFinite(total) &&
        used >= 0 &&
        total > 0 &&
        used <= total
        ? [{
            id,
            used: used * 1024 ** 2,
            total: total * 1024 ** 2,
            utilizationPercent:
              utilizationText && Number.isFinite(utilization) && utilization >= 0 && utilization <= 100
                ? utilization
                : null,
          }]
        : [];
    });
}
export async function sampleMemory(signal: AbortSignal): Promise<MemorySnapshot> {
  const [ram, gpus] = await Promise.all([
    process.platform === 'linux'
      ? readFile('/proc/meminfo', { encoding: 'utf8', signal })
          .then(parseRam)
          .catch(() => null)
      : Promise.resolve(null),
    execute(
      'nvidia-smi',
      [
        '--query-gpu=index,memory.used,memory.total,utilization.gpu',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 1200, signal }
    )
      .then((r) => parseGpus(r.stdout))
      .catch(() => []),
  ]);
  return { ram, gpus };
}
