import { describe, expect, it } from 'vitest';
import { detectManagedReasoning } from './ggufReasoningCapabilities';
const runtime = { flags: ['--jinja', '--chat-template-kwargs'] };
describe('GGUF template and runtime reasoning capabilities', () => {
  it('supports native Qwen template controls on the integrated runtime without a revision pin or sampler budget', () => {
    expect(detectManagedReasoning({ thinkingToggle: true, nativeQwenEfforts: true }, runtime)).toEqual({
      thinkingSupported: true, thinkingToggleSupported: true, reasoningEffortSupported: true,
      supportedEfforts: ['low', 'medium', 'xhigh'], status: 'available',
    });
  });
  it('does not invent efforts for a toggle-only template', () => {
    expect(detectManagedReasoning({ thinkingToggle: true }, runtime)).toMatchObject({
      thinkingToggleSupported: true, reasoningEffortSupported: false, supportedEfforts: [],
    });
  });
  it('does not infer controls from reasoning tokens or model names', () => {
    expect(detectManagedReasoning({}, runtime)).toMatchObject({ status: 'unsupported', thinkingToggleSupported: false });
  });
  it('preserves unknown with a diagnosis when template/runtime support cannot be confirmed', () => {
    expect(detectManagedReasoning(undefined, runtime)).toMatchObject({ status: 'unknown', diagnostic: 'metadata' });
    expect(detectManagedReasoning({ thinkingToggle: true }, { flags: [] })).toMatchObject({ status: 'unknown', diagnostic: 'runtime' });
    expect(detectManagedReasoning({ thinkingToggle: true }, runtime, true)).toMatchObject({ status: 'unknown', diagnostic: 'template' });
  });
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { speculativeFixture } from './test/ggufFixtures';
import { readSpeculativeMetadata } from './ggufSpeculativeMetadata';
import { managedProviderHeaders } from './ggufProviderCapabilities';
it('derives metadata and provider serialization hints without loading weights or depending on Vision/MTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lad-template-capabilities-'));
  try {
    for (const [index, template] of [
      "{% if enable_thinking is defined %}{{ enable_thinking }}{% endif %}{% if resolved_reasoning_effort not in ('low', 'medium', 'xhigh') %}error{% endif %}",
      '{% if enable_thinking %}think{% endif %}',
      '<think>reasoning token alone</think>',
    ].entries()) {
      const file = join(root, `${index}.gguf`);
      await writeFile(file, speculativeFixture({ chatTemplate: template }));
      const metadata = await readSpeculativeMetadata(file);
      const reasoning = detectManagedReasoning(metadata, runtime);
      expect(reasoning.thinkingToggleSupported).toBe(index < 2);
      expect(reasoning.reasoningEffortSupported).toBe(index === 0);
      for (const vision of [false, true]) {
        const headers = managedProviderHeaders({ thinking: reasoning.thinkingToggleSupported, reasoning, vision });
        if (index < 2) expect(headers['X-Local-AI-Managed-Qwen']).toBe(index === 0 ? 'qwen35-v1' : 'qwen35-toggle-v1');
        else expect(headers).toEqual({});
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
