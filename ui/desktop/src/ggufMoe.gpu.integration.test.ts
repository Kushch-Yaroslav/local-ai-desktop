// Bounded real Qwen80B pairwise benchmark. Temporary profiles; only test-owned processes.
import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));
import { ManagedGguf } from './managedGguf';
import { inspectPlacement, placementPreview } from './moe/placement';
import { probeRuntime } from './ggufConfig';
import type { GgufProfile, GgufEndpoint } from './ggufTypes';
const execute = promisify(execFile);
it.skipIf(process.env.LAD_MOE_GPU !== '1' || !process.env.LAD_GGUF_TEST_MODEL)(
  'benchmarks one integrated CUDA runtime with fixed placement/context and donor preflight',
  async () => {
    expect(
      await execute('pgrep', ['-x', 'llama-server']).then(
        (r) => r.stdout.trim(),
        () => ''
      )
    ).toBe('');
    const dir = await mkdtemp(join(tmpdir(), 'lad-integrated-moe-'));
    const executable = process.env.LAD_RUNTIME_TEST_PATH ?? resolve('../../runtime/llama/llama-server');
    const service = new ManagedGguf(dir, () => {}, executable);
    const internal = service as unknown as {
      start: (p: GgufProfile, s: AbortSignal, v?: boolean) => Promise<GgufEndpoint>;
    };
    const start = internal.start.bind(service);
    internal.start = (p, s) => start(p, s, true);
    const model = process.env.LAD_GGUF_TEST_MODEL!;
    const inspection = await inspectPlacement(model);
    expect(inspection.layers).toBe(48);
    const probe = await probeRuntime(executable);
    const rows: unknown[] = [];
    try {
      for (const size of process.env.LAD_MOE_AUTO_ONLY === '1' ? [16384] : process.env.LAD_MOE_PLACEMENT_ONLY === '1' ? [8192] : [0, 8192, 12288, 16384]) {
        const profile = {
          name: 'isolated MoE benchmark',
          model,
          executable,
          gpuLayers: 999,
          context: 4096,
          threads: 8,
          batch: 512,
          ubatch: 128,
          flashAttention: 'on' as const,
          cacheK: 'q8_0',
          cacheV: 'q8_0',
          cpuMoe: true,
          gpuBlockIds: Array.from({ length: inspection.layers! }, (_, n) => n).filter(n => process.env.LAD_MOE_PLACEMENT_ONLY !== '1' || n !== 3),
          placementIdentity: inspection.identity,
          moeCacheMode: process.env.LAD_MOE_AUTO_ONLY === '1' ? ('automatic' as const) : size ? ('manual' as const) : ('standard' as const),
          moeCacheMiB: process.env.LAD_MOE_AUTO_ONLY === '1' ? undefined : size || undefined,
          speculativeMode: 'off' as const,
        };
        const preflight = await placementPreview(profile, probe);
        if (
          !preflight.estimate.fits ||
          !preflight.host.fits ||
          (size && !preflight.sizes.includes(size))
        ) {
          rows.push({ cacheMiB: size, skipped: true, preflight });
          continue;
        }
        const p = await service.save(profile);
        const endpoint = await service.activate(p.id!);
        const gateway = await service.prepare(p.id!);
        const pid = (service as unknown as { owned: { pid: number } }).owned.pid;
        const relative = /^0::(.*)$/m.exec(await readFile(`/proc/${pid}/cgroup`, 'utf8'))?.[1];
        const scope = {
          max: (await readFile('/sys/fs/cgroup' + relative + '/memory.max', 'utf8')).trim(),
          swapMax: (
            await readFile('/sys/fs/cgroup' + relative + '/memory.swap.max', 'utf8')
          ).trim(),
        };
        expect(scope.swapMax).toBe('0');
        const samples = [];
        for (const max of process.env.LAD_MOE_AUTO_ONLY === '1' ? [16] : [16, 64, 64]) {
          const response = await fetch(gateway.url + '/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + gateway.key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'local-gguf',
              messages: [
                {
                  role: 'user',
                  content:
                    'Write a short Python function that returns the first n Fibonacci numbers. Include brief comments.',
                },
              ],
              temperature: 0,
              seed: 42,
              max_tokens: max,
              stream: false,
              cache_prompt: false,
              chat_template_kwargs: { enable_thinking: false },
            }),
            signal: AbortSignal.timeout(90000),
          });
          expect(response.ok).toBe(true);
          const answer = await response.json();
          expect(answer.choices[0].message.content.length).toBeGreaterThan(0);
          const gpu = (
            await execute('nvidia-smi', [
              '--query-gpu=memory.used,memory.total',
              '--format=csv,noheader,nounits',
            ])
          ).stdout.trim();
          const ram = await readFile('/proc/meminfo', 'utf8');
          const total = Number(/^MemTotal:\s+(\d+)/m.exec(ram)?.[1]),
            available = Number(/^MemAvailable:\s+(\d+)/m.exec(ram)?.[1]);
          samples.push({
            warmup: max === 16,
            timings: answer.timings,
            usage: answer.usage,
            gpuMiB: gpu,
            ramUsedMiB: (total - available) / 1024,
          });
        }
        await service.unload();
        const log = await readFile(endpoint.logPath!, 'utf8');
        const evidence = log
          .split('\n')
          .filter(
            (l) =>
              /llama_moe_cache|buffer size|offloaded|expert.*cache|cache.*expert|overrid/i.test(
                l
              ) && !l.includes('prompt')
          )
          .slice(-120);
        if (size) expect(log).toMatch(/MoE cache size\s*=/);
        rows.push({
          cacheMiB: size,
          preflight,
          args: endpoint.args,
          scope,
          samples,
          evidence,
      placementEvidence: log.split('\n').filter(l => /blk\.(3|4)\./.test(l) && /CPU|CUDA/.test(l)).slice(0,100),
        });
        await service.unload();
      }
    } finally {
      for (const f of await readdir(dir)) {
        if (f.endsWith('.log')) {
          const log = await readFile(join(dir, f), 'utf8');
          await writeFile(
            '/tmp/lad-moe-last-allocation.log',
            log
              .split('\n')
              .filter(
                (l) =>
                  /error|fail|invalid|assert|buffer|cache|override|loading/i.test(l) &&
                  !l.includes('prompt')
              )
              .slice(-120)
              .join('\n')
          );
        }
      }
      await service.shutdown();
      await writeFile(
        process.env.LAD_MOE_AUTO_ONLY === '1' ? '/tmp/lad-integrated-moe-auto.json' : process.env.LAD_MOE_PLACEMENT_ONLY === '1' ? '/tmp/lad-integrated-moe-placement.json' : '/tmp/lad-integrated-moe-benchmark.json',
        JSON.stringify(
          {
            version: probe.version,
            inspection: {
              architecture: inspection.architecture,
              layers: inspection.layers,
              experts: inspection.experts,
              fileType: inspection.fileType,
            },
            rows,
          },
          null,
          2
        )
      );
      await rm(dir, { recursive: true, force: true });
    }
  },
  600000
);
