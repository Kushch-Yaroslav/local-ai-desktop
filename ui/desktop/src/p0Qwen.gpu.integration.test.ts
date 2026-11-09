import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));
import { ManagedGguf } from './managedGguf';
it.skipIf(process.env.LAD_P0_QWEN !== '1')(
  'loads Qwen 32K FP16 with FA on and no MTP draft context',
  async () => {
    let running = '';
    try {
      running = execFileSync('pgrep', ['-x', 'llama-server'], { encoding: 'utf8' }).trim();
    } catch {
      /* no worker */
    }
    expect(running).toBe('');
    const profiles = JSON.parse(
      await readFile(
        '/media/yaroslav/DATA/Local-AI-Desktop/data/goose-dev/electron/gguf-profiles.json',
        'utf8'
      )
    );
    const source = profiles.find(
      (p: { id: string }) =>
        p.id === (process.env.LAD_P0_PROFILE_ID ?? 'fdf5e70b-0e52-4624-a733-925dbbe21af4')
    );
    const root = await mkdtemp(join(tmpdir(), 'lad-p0-qwen-'));
    const service = new ManagedGguf(root);
    try {
      await service.initialize();
      const profile = await service.save({
        ...source,
        id: undefined,
        context: 32768,
        cacheK: 'f16',
        cacheV: 'f16',
        flashAttention: 'on',
        speculativeMode: 'off',
      });
      await service.activate(profile.id!);
      const endpoint = await service.prepare(profile.id!);
      const response = await fetch(endpoint.url + '/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + endpoint.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'local-gguf',
          messages: [{ role: 'user', content: 'Reply OK.' }],
          max_tokens: 16,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(60000),
      });
      expect(response.ok).toBe(true);
      const answer = await response.json();
      expect(answer.choices?.[0]).toBeTruthy();
      await writeFile(
        join(root, 'result.json'),
        JSON.stringify({ args: service.state.args, answer: answer.choices[0] }, null, 2)
      );
      console.log('P0 evidence directory:', root);
      if (process.env.LAD_P0_BASELINE_ONLY === '1') return;
      const token = await service.acquireRuntimeLease({ id: 9902, once: () => {} } as never);
      const discovery = await service.runContextDiscovery(profile.id!, token);
      await writeFile(join(root, 'discovery.json'), JSON.stringify(discovery, null, 2));
      expect(discovery.result.probes?.length).toBeGreaterThan(0);
      console.log(
        'P0 discovery options:',
        JSON.stringify(
          discovery.result.options.map((o) => ({ kv: o.kvCacheType, context: o.contextWindow }))
        )
      );
    } finally {
      await service.shutdown();
    }
  },
  600000
);
