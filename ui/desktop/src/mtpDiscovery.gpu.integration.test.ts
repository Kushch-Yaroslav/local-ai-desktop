// Opt-in real, sequential MTP probes; profiles and outputs are disposable.
import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, readlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));
import { ManagedGguf } from './managedGguf';
it.skipIf(process.env.LAD_MTP_DISCOVERY !== '1')(
  'measures actual MTP memory and generation without changing user profiles',
  async () => {
    let resident = '';
    try {
      resident = execFileSync('pgrep', ['-x', 'llama-server'], { encoding: 'utf8' }).trim();
    } catch {
      /* No resident worker. */
    }
    expect(resident).toBe('');
    const profiles = JSON.parse(
      await readFile(
        '/media/yaroslav/DATA/Local-AI-Desktop/data/goose-dev/electron/gguf-profiles.json',
        'utf8'
      )
    );
    const source = profiles.find(
      (p: { id: string }) => p.id === 'fdf5e70b-0e52-4624-a733-925dbbe21af4'
    );
    expect(source).toBeTruthy();
    const root = await mkdtemp(join(tmpdir(), 'lad-mtp-discovery-'));
    let service = new ManagedGguf(root);
    const rows: unknown[] = [];
    const matrix = JSON.parse(
      process.env.LAD_MTP_MATRIX ?? '[{"context":4096},{"context":8192},{"context":16384}]'
    );
    try {
      await service.initialize();
      for (const change of matrix) {
        const profile = await service.save({
          ...source,
          id: undefined,
          providerId: undefined,
          context: 4096,
          cacheK: 'f16',
          cacheV: 'f16',
          flashAttention: 'on',
          speculativeMode: 'mtp-embedded',
          ...change,
        });
        if (process.env.LAD_MTP_RESTART === '1') {
          await service.shutdown();
          service = new ManagedGguf(root);
          await service.initialize();
        }
        const started = Date.now();
        const row: Record<string, unknown> = {
          configuration: {
            context: profile.context,
            gpuLayers: profile.gpuLayers,
            cacheK: profile.cacheK,
            cacheV: profile.cacheV,
            mode: profile.speculativeMode,
            parallel: profile.parallel,
            batch: profile.batch,
            ubatch: profile.ubatch,
            draftUbatch: profile.draftUbatch,
            draftCacheK: profile.draftCacheK,
            draftCacheV: profile.draftCacheV,
            nCpuMoe: profile.nCpuMoe,
            draftTokens: profile.draftTokens,
          },
          log: join(root, `gguf-${profile.id}.log`),
        };
        try {
          await service.activate(profile.id!);
          const endpoint = await service.prepare(profile.id!);
          row.args = endpoint.args;
          row.gpu = execFileSync(
            'nvidia-smi',
            ['--query-gpu=memory.used,memory.free', '--format=csv,noheader,nounits'],
            { encoding: 'utf8' }
          ).trim();
          for (const pid of await readdir('/proc')) {
            try {
              const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
              if (
                (await readlink(`/proc/${pid}/exe`)) === (await realpath(profile.executable)) &&
                args.includes(profile.model)
              )
                row.rss = /^VmRSS:.*$/m.exec(await readFile(`/proc/${pid}/status`, 'utf8'))?.[0];
            } catch {
              /* No resident worker. */
            }
          }
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
                    'Describe a sunrise over a lake in simple English. Write several sentences.',
                },
              ],
              max_tokens: 128,
              temperature: 0,
              seed: 42,
              cache_prompt: false,
              stream: false,
              chat_template_kwargs: { enable_thinking: false },
            }),
            signal: AbortSignal.timeout(180000),
          });
          const answer = await response.json();
          expect(response.ok).toBe(true);
          expect(answer.choices?.[0]).toBeTruthy();
          row.answer = answer;
          row.ok = true;
          row.benchmark = [answer.timings];
          for (let repeat = 1; repeat < Number(process.env.LAD_MTP_REPEATS ?? 1); repeat++) {
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
                      'Describe a sunrise over a lake in simple English. Write several sentences.',
                  },
                ],
                max_tokens: 128,
                temperature: 0,
                seed: 42,
                cache_prompt: false,
                stream: false,
                chat_template_kwargs: { enable_thinking: false },
              }),
              signal: AbortSignal.timeout(180000),
            });
            const repeatResult = await response.json();
            expect(response.ok).toBe(true);
            (row.benchmark as unknown[]).push(repeatResult.timings);
          }
          if (profile.speculativeMode === 'mtp-embedded')
            expect(answer.timings?.draft_n).toBeGreaterThan(0);
          if (process.env.LAD_MTP_RUN_DISCOVERY === '1') {
            const token = await service.acquireRuntimeLease({ id: 9909, once: () => {} } as never);
            const discovery = await service.runContextDiscovery(profile.id!, token);
            await writeFile(
              join(root, `discovery-${profile.id}.json`),
              JSON.stringify(discovery, null, 2)
            );
            row.discovery = discovery;
            if (process.env.LAD_MTP_VERIFY_CATALOG === '1') {
              await service.shutdown();
              service = new ManagedGguf(root);
              await service.initialize();
              const restored = await service.getDiscoveryCatalog(profile.id!);
              row.restoredOptions = restored.options.map((o) => ({
                kv: o.kvCacheType,
                context: o.contextWindow,
              }));
              expect(restored.options.map((o) => o.contextWindow).sort((a, b) => a - b)).toEqual(
                discovery.result.options.map((o) => o.contextWindow).sort((a, b) => a - b)
              );
            }
            for (const option of discovery.result.options) {
              await service.unload();
              const applied = await service.save({
                ...profile,
                context: option.contextWindow,
                cacheK: option.kvCacheType,
                cacheV: option.kvCacheType,
              });
              const selected = await service.activate(applied.id!);
              const response = await fetch(selected.url + '/v1/chat/completions', {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + selected.key,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: 'local-gguf',
                  messages: [
                    {
                      role: 'user',
                      content:
                        'Describe a sunrise over a lake in simple English. Write several sentences.',
                    },
                  ],
                  max_tokens: 128,
                  temperature: 0,
                  seed: 42,
                  cache_prompt: false,
                  stream: false,
                  chat_template_kwargs: { enable_thinking: false },
                }),
                signal: AbortSignal.timeout(180000),
              });
              const completion = await response.json();
              expect(response.ok).toBe(true);
              expect(completion.timings?.draft_n).toBeGreaterThan(0);
              const verification = {
                kv: option.kvCacheType,
                context: option.contextWindow,
                args: selected.args,
                timings: completion.timings,
                answer: completion.choices?.[0],
              };
              ((row.ordinaryMaxRuns ??= []) as unknown[]).push(verification);
            }
            const stored = JSON.parse(
              await readFile(join(root, 'gguf-profiles.json'), 'utf8')
            ).find((p: { id: string }) => p.id === profile.id);
            expect(stored.speculativeMode).toBe('mtp-embedded');
            expect(stored.parallel).toBe(profile.parallel);
            expect(stored.draftUbatch).toBe(profile.draftUbatch);
          }
        } catch (error) {
          row.ok = false;
          row.error = String(error);
        } finally {
          row.elapsedMs = Date.now() - started;
          await service.unload();
          const log = await readFile(String(row.log), 'utf8').catch(() => '');
          row.evidence = log
            .split('\n')
            .filter((l) =>
              /buffer size|cache.*size|flash_attn|n_ctx |n_seq|max|MTP|draft-mtp|statistics.*draft|n_drafted|accepted|n_parallel|out of memory|failed to create|model loaded/.test(
                l
              )
            )
            .filter((l) => !l.includes('llama_graph'))
            .slice(-100);
          rows.push(row);
          await writeFile(join(root, 'results.json'), JSON.stringify(rows, null, 2));
          console.log('MTP probe', JSON.stringify(row.configuration), row.ok);
        }
      }
      if (process.env.LAD_MTP_ALLOW_FAILURES !== '1') {
        expect(rows.every((row) => (row as { ok: boolean }).ok)).toBe(true);
      }
    } finally {
      await service.shutdown();
      console.log('MTP evidence:', root);
    }
  },
  600000
);
