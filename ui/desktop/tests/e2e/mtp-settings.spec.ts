// Local AI Desktop: real packaged settings; GPU acceptance is opt-in and sequential.
import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeWindowShot, resizeNativeWindow } from './native-window-shot';
process.env.LAD_E2E_ISOLATE = '1';
test('packaged MTP preset and optional real GPU discovery', async ({ goosePage: page }) => {
  test.setTimeout(process.env.LAD_E2E_MTP_GPU === '1' ? 300000 : 120000);
  await resizeNativeWindow(page, 1600, 1000);
  const id = await page.evaluate(async () => {
    const executable = await window.electron.ggufRuntime();
    return (
      await window.electron.ggufSave({
        name: 'MTP packaged QA',
        model:
          '/media/yaroslav/DATA/llama-models/Qwen3.6-35B-A3B-Q4_K_M/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
        executable,
        gpuLayers: 999,
        context: 32768,
        speculativeMode: 'mtp-embedded',
        draftTokens: 2,
        flashAttention: 'on',
        cacheK: 'f16',
        cacheV: 'f16',
      })
    ).id!;
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-local-inference-tab').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByRole('textbox', { name: 'Profile name' })).toHaveValue('MTP packaged QA');
  await page.getByRole('button', { name: 'Advanced mode', exact: true }).click();
  await page.getByRole('button', { name: /Prepare MTP preset/ }).click();
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(
    page.getByText('Profile saved. Model weights have not been loaded.', { exact: true })
  ).toBeVisible();
  const saved = await page.evaluate(
    async (id) => (await window.electron.ggufList()).find((e) => e.profile.id === id)!.profile,
    id
  );
  expect(saved).toMatchObject({
    speculativeMode: 'mtp-embedded',
    draftTokens: 1,
    parallel: 1,
    batch: 512,
    ubatch: 128,
    draftUbatch: 128,
    context: 32768,
    cacheK: 'f16',
    cacheV: 'f16',
    gpuLayers: 999,
  });
  expect(saved.nCpuMoe).toBeUndefined();
  expect((await page.evaluate(() => window.electron.ggufState())).phase).toBe('idle');
  if (process.env.LAD_E2E_MTP_GPU === '1') {
    let resident = '';
    try {
      resident = execFileSync('pgrep', ['-x', 'llama-server'], { encoding: 'utf8' }).trim();
    } catch {
      /* No resident worker. */
    }
    expect(resident).toBe('');
    try {
      if (process.env.LAD_E2E_MTP_SATURATED_LOG === '1') {
        const initial = await page.evaluate((id) => window.electron.ggufStart(id), id);
        await page.evaluate(() => window.electron.ggufStop());
        // Seed only this fixture's own log, never the ordinary profile's history.
        expect(initial.logPath?.startsWith(join(tmpdir(), 'lad-e2e-'))).toBe(true);
        writeFileSync(initial.logPath!, Buffer.alloc(16 * 1024 ** 2 - 64, '.'));
      }
      const discovery = await page.evaluate(async (id) => {
        const token = await window.electron.ggufDiscoveryAcquire();
        return await window.electron.ggufDiscoveryRun(id, token);
      }, id);
      writeFileSync(
        test.info().outputPath('packaged-mtp-discovery.json'),
        JSON.stringify(discovery, null, 2)
      );
      expect(discovery.result.options.map((o) => o.kvCacheType).sort()).toEqual(['f16', 'q8_0']);
      expect(
        discovery.result
          .probes!.filter((p) => p.inference)
          .every((p) => (p.speculativeEvidence?.drafted ?? 0) > 0)
      ).toBe(true);
      const runs = [];
      for (const option of discovery.result.options) {
        await page.evaluate(() => window.electron.ggufStop());
        await page.evaluate(
          async ({ saved, option }) => {
            await window.electron.ggufSave({
              ...saved,
              context: option.contextWindow,
              cacheK: option.kvCacheType,
              cacheV: option.kvCacheType,
            });
          },
          { saved, option }
        );
        const endpoint = await page.evaluate((id) => window.electron.ggufStart(id), id);
        const response = await fetch(endpoint.url + '/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + endpoint.key, 'Content-Type': 'application/json' },
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
        runs.push({
          kv: option.kvCacheType,
          context: option.contextWindow,
          args: endpoint.args,
          timings: completion.timings,
          answer: completion.choices[0],
        });
      }
      writeFileSync(
        test.info().outputPath('packaged-mtp-ordinary-runs.json'),
        JSON.stringify(runs, null, 2)
      );
    } finally {
      await page.evaluate(() => window.electron.ggufStop());
    }
  }

  await page.getByText('CPU threads and batch', { exact: true }).click();
  await page.getByText('Context, KV cache and memory', { exact: true }).click();
  await page
    .getByLabel('Parallel chat slots (1 uses less MTP memory)', { exact: true })
    .scrollIntoViewIfNeeded();
  await nativeWindowShot(page, test.info().outputPath('native-mtp-preset.png'));
});
