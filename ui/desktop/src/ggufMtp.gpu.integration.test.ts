// Opt-in bounded local GPU comparison. Only synthetic prompts; no chat text or credentials logged.
import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: {} }));
import { ManagedGguf } from './managedGguf';
const execute = promisify(execFile);
it.skipIf(process.env.LAD_MTP_GPU_SMOKE !== '1' || !process.env.LAD_GGUF_TEST_MODEL || !process.env.LAD_RUNTIME_TEST_PATH)(
  'compares unchanged Qwen3.8 baseline with embedded MTP on the host GPU',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lad-mtp-gpu-'));
    const service = new ManagedGguf(dir);
    const rows: unknown[] = [];
    let baselineHash: string | undefined;
    const hardware = (
      await execute('nvidia-smi', [
        '--query-gpu=name,driver_version,memory.free',
        '--format=csv,noheader',
      ])
    ).stdout.trim();
    const model = process.env.LAD_GGUF_TEST_MODEL!,
      executable = process.env.LAD_RUNTIME_TEST_PATH!;
    const build = await execute(executable, ['--version']);
    const version = (build.stdout + build.stderr).trim();
    const freeMiB = Number(
      hardware
        .split(',')
        .at(-1)
        ?.replace(/[^0-9]/g, '')
    );
    expect(freeMiB).toBeGreaterThan(5000);
    try {
      for (const mode of ['off', 'mtp-embedded'] as const) {
        const profile = await service.save({
          name: 'bounded GPU smoke',
          model,
          executable,
          gpuLayers: 8,
          context: 8192,
          threads: 8,
          batch: 256,
          ubatch: 128,
          cacheK: 'q8_0',
          cacheV: 'f16',
          flashAttention: 'on',
          speculativeMode: mode,
          draftTokens: 2,
        });
        let endpoint;
        try {
          endpoint = await service.activate(profile.id!);
        } catch (error) {
          const log = await readFile(join(dir, `gguf-${profile.id}.log`), 'utf8').catch(() => '');
          await writeFile('/tmp/lad-mtp-gpu-failure.log', log.slice(-12000));
          throw error;
        }
        const port = new URL(endpoint.url).port;
        const ps = (await execute('ps', ['-eo', 'pid,ppid,args'])).stdout.split('\n');
        const own = ps.find((line) => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
          return (
            match &&
            Number(match[2]) === process.pid &&
            match[3].startsWith(executable + ' ') &&
            match[3].includes('--port ' + port)
          );
        });
        const pid = own?.trim().split(/\s+/)[0];
        expect(pid).toBeTruthy();
        const samples = [];
        for (let run = 0; run < 3; run++) {
          const started = performance.now();
          const response = await fetch(endpoint.url + '/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + endpoint.key,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'local-gguf',
              messages: [
                {
                  role: 'user',
                  content:
                    'Write a short factual description of a sunrise over a quiet lake. Use plain English sentences.',
                },
              ],
              stream: false,
              temperature: 0,
              seed: 42,
              max_tokens: run === 0 ? 4 : 32,
              cache_prompt: false,
              chat_template_kwargs: { enable_thinking: false },
            }),
            signal: AbortSignal.timeout(120000),
          });
          const result = await response.json();
          expect(response.ok).toBe(true);
          expect(result.choices?.[0]).toBeTruthy();
          const message = result.choices[0].message;
          const hash = createHash('sha256')
            .update(
              JSON.stringify({ content: message.content, reasoning: message.reasoning_content })
            )
            .digest('hex');
          if (mode === 'off' && run === 1) baselineHash = hash;
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          const memory = (
            await execute('nvidia-smi', [
              '--query-compute-apps=pid,used_memory',
              '--format=csv,noheader,nounits',
            ])
          ).stdout
            .split('\n')
            .find((line) => line.trim().startsWith(pid + ','));
          if (run > 0)
            samples.push({
              run,
              timings: result.timings ?? null,
              wallMs: Math.round(performance.now() - started),
              rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0),
              peakRssKiB: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0),
              vramMiB: Number(memory?.split(',')[1]?.trim() ?? 0),
              matchesGreedyBaseline: hash === baselineHash,
              finishReason: result.choices[0].finish_reason,
              usage: result.usage,
            });
        }
        rows.push({ mode, args: service.state.args, samples });
        await service.unload();
      }
      const output = {
        hardware,
        version,
        method:
          'Same target/settings/prompt/seed. One 4-token warmup and two 32-token runs per mode; no output text retained. VRAM is sampled, RAM HWM is process lifetime.',
        rows,
      };
      await writeFile('/tmp/lad-mtp-gpu-results.json', JSON.stringify(output, null, 2));
    } finally {
      await service.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  },
  360000
);
