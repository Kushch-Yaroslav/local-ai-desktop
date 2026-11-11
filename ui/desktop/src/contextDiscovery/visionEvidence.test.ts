// Regression fixture uses sanitized real 5047748 startup allocation lines.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLlamaAllocationLog } from './contextEstimate';
import { buildArguments } from '../ggufConfig';
const fixturePath = 'src/contextDiscovery/fixtures/qwen35-text-mtp-5047748.log';
const hasLocalEvidence = existsSync(fixturePath);
const text = hasLocalEvidence ? readFileSync(fixturePath, 'utf8') : '';
const projector = '/models/mmproj.gguf';
const args = ['--spec-type', 'draft-mtp'];
const visionLines = `clip_model_loader: has vision encoder\nload_hparams: model size: 888.00 MiB\nreserve_compute_meta: CPU compute buffer size = 32.00 MiB\nsrv load_model: loaded multimodal model, '${projector}'\n`;
const vision = text.replace(/(?=^.*srv\s+load_model: initializing,)/m, visionLines);
// Sanitized host-run evidence logs are local-only and intentionally ignored by Git.
describe.skipIf(!hasLocalEvidence)('discovery Vision launch evidence', () => {
  it('accepts Vision Off without any projector mention and recognizes the renamed completion marker', () => {
    expect(text).not.toMatch(/mmproj|vision encoder/);
    const evidence = parseLlamaAllocationLog(text, args);
    expect(evidence.visionPresent).toBe(false);
    expect(evidence.unknownReasons).toEqual([]);
    expect(evidence.kvTypeK).toBe('q8_0');
    expect(evidence.speculativeKvTypeK).toBe('f16');
    expect(evidence.speculativeMode).toBe('mtp');
  });
  it('requires the correct loaded projector and completed startup for Vision On', () => {
    expect(parseLlamaAllocationLog(vision, [...args, '--mmproj', projector]).unknownReasons).toEqual([]);
    expect(parseLlamaAllocationLog(text, [...args, '--mmproj', projector]).unknownReasons.join(' ')).toContain('выбранного визуального проектора');
    expect(parseLlamaAllocationLog(vision, [...args, '--mmproj', '/wrong.gguf']).unknownReasons.join(' ')).toContain('выбранного визуального проектора');
    const failed = vision.replace(/^.*srv\s+server_run_i: model loaded.*$/m, 'CUDA allocation failed');
    expect(parseLlamaAllocationLog(failed, [...args, '--mmproj', projector]).unknownReasons.join(' ')).toContain('выбранного визуального проектора');
  });
  it('does not reuse Vision On evidence after switching to Off or another profile load', () => {
    const p = { name: 'model', model: '/models/target.gguf', executable: '/runtime/llama-server', context: 16384, gpuLayers: 999, projector };
    expect(buildArguments({ ...p, visionEnabled: true }, 0)).toContain('--mmproj');
    const off = buildArguments({ ...p, visionEnabled: false }, 0);
    expect(off).not.toContain('--mmproj');
    expect(p.projector).toBe(projector);
    const evidence = parseLlamaAllocationLog(vision + '\n' + text, off);
    expect(evidence.visionPresent).toBe(false);
    expect(evidence.unknownReasons).toEqual([]);
    expect(parseLlamaAllocationLog(vision, off).unknownReasons.join(' ')).toContain('Vision выключен');
  });
  it('does not certify incomplete allocation evidence just because Vision is Off', () => {
    const evidence = parseLlamaAllocationLog('srv server_run_i: model loaded', args);
    expect(evidence.visionPresent).toBe(false);
    expect(evidence.unknownReasons.length).toBeGreaterThan(0);
  });
});
