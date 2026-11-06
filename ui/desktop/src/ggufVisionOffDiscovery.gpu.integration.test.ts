// Opt-in real discovery, capped at 16K in temporary data; no maximum-memory search.
import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('./ggufMetadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ggufMetadata')>();
  return { ...actual, inspectGguf: async (...args: Parameters<typeof actual.inspectGguf>) => {
    const metadata = await actual.inspectGguf(...args);
    return { ...metadata, ...(metadata.context ? { context: Math.min(metadata.context, 16384) } : {}) };
  } };
});
import { ManagedGguf } from './managedGguf';
it.skipIf(process.env.LAD_VISION_OFF_DISCOVERY !== '1' || !process.env.LAD_RUNTIME_TEST_PROFILE)('accepts real FP16 and Q8 allocation/inference probes with Vision Off and saved MTP', async () => {
  let existing = '';
  try { existing = execFileSync('pgrep', ['-x', 'llama-server'], { encoding: 'utf8' }).trim(); } catch { /* no server */ }
  expect(existing).toBe('');
  const root = await mkdtemp(join(tmpdir(), 'lad-vision-off-discovery-'));
  const service = new ManagedGguf(root, () => {}, resolve('../../runtime/llama/llama-server'));
  let report: unknown;
  try {
    const profiles = JSON.parse(await readFile(process.env.LAD_RUNTIME_TEST_PROFILE!, 'utf8'));
    const source = profiles.find((p: { name: string }) => p.name === 'Qwen27B-3.8');
    expect(source).toBeTruthy();
    const profile = await service.save({ ...source, id: undefined, providerId: undefined, visionEnabled: false, context: 16384, flashAttention: 'on' });
    const token = await service.acquireRuntimeLease({ id: 9901, once: () => {} } as never);
    const completed = await service.runContextDiscovery(profile.id!, token);
    report = completed;
    expect(completed.result.options.some(o => o.kvCacheType === 'f16')).toBe(true);
    // At a 16K test ceiling Q8 cannot demonstrate the donor's required 8K
    // gain over FP16. Its measured base probe must still be accepted.
    expect(completed.result.unsupported.every(o => o.kvCacheType === 'q8_0' && o.reason.includes('8K'))).toBe(true);
    expect(completed.result.options.every(o => o.contextWindow === 16384)).toBe(true);
    const successful = completed.result.probes!.filter(p => p.startup && p.health && p.inference && p.headroom);
    expect(successful.map(p => p.kvCacheType).sort()).toEqual(['f16', 'q8_0']);
    expect(successful.every(p => !p.reason)).toBe(true);
    const log = await readFile(join(root, `gguf-${profile.id}.log`), 'utf8');
    await writeFile('/tmp/lad-vision-off-allocation.log', log.split('\n').filter(l => /load_tensors:.*(?:offloaded|model buffer size)|llama_kv_cache|llama_memory_recurrent|llama_context:|sched_reserve:|common_speculative_init_result:|spec.*common_specu:|srv.*(?:initializing,|model loaded)/.test(l)).join('\n').replaceAll(profile.model, 'fixture.gguf'));
    expect(successful.every(p => p.args && !p.args.includes('--mmproj'))).toBe(true);
    expect(successful.every(p => p.args?.includes('--spec-type') === (source.speculativeMode !== 'off'))).toBe(true);
    expect(service.state.phase).toBe('idle');
  } finally {
    await service.shutdown();
    await writeFile('/tmp/lad-vision-off-discovery-report.json', JSON.stringify(report ?? { error: service.state.error }, null, 2));
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
