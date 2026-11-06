// Local AI Desktop: metadata + selected runtime, without loading model weights.
import type { RuntimeProbe } from './ggufTypes';
import type { SpeculativeMetadata } from './ggufSpeculativeMetadata';
export interface ManagedReasoningCapabilities {
  thinkingSupported: boolean;
  thinkingToggleSupported: boolean;
  reasoningEffortSupported: boolean;
  supportedEfforts: Array<'low' | 'medium' | 'xhigh'>;
  status: 'available' | 'unsupported' | 'unknown';
  diagnostic?: 'runtime' | 'template' | 'metadata';
}
export function detectManagedReasoning(
  metadata: Pick<SpeculativeMetadata, 'thinkingToggle' | 'nativeQwenEfforts' | 'reasoningControlsPresent'> | undefined,
  runtime: Pick<RuntimeProbe, 'flags'>,
  customTemplate = false
): ManagedReasoningCapabilities {
  const base: ManagedReasoningCapabilities = { thinkingSupported: false, thinkingToggleSupported: false,
    reasoningEffortSupported: false, supportedEfforts: [], status: 'unknown' };
  if (customTemplate) return { ...base, diagnostic: 'template' };
  if (!metadata) return { ...base, diagnostic: 'metadata' };
  const thinkingSupported = metadata.thinkingToggle === true || metadata.nativeQwenEfforts === true;
  if (!thinkingSupported) return metadata.reasoningControlsPresent
    ? { ...base, diagnostic: 'template' } : { ...base, status: 'unsupported' };
  // Both flags identify the llama.cpp Jinja argument transport used by Goose's
  // managed template adapter. A numeric sampler budget is independent of this.
  if (!runtime.flags.includes('--jinja') || !runtime.flags.includes('--chat-template-kwargs'))
    return { ...base, thinkingSupported, diagnostic: 'runtime' };
  if (!metadata.thinkingToggle) return { ...base, thinkingSupported, diagnostic: 'template' };
  const reasoningEffortSupported = metadata.nativeQwenEfforts === true;
  return { thinkingSupported, thinkingToggleSupported: true, reasoningEffortSupported,
    supportedEfforts: reasoningEffortSupported ? ['low', 'medium', 'xhigh'] : [], status: 'available' };
}
