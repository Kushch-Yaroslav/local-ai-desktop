import type { ManagedReasoningCapabilities } from './ggufReasoningCapabilities';
/** Existing Goose transport IDs; capabilities are detected from template/runtime, not names. */
export function managedProviderHeaders(capabilities: {
  thinking: boolean;
  nativeEfforts?: boolean;
  vision: boolean;
  reasoning?: ManagedReasoningCapabilities;
}): Record<string, string> {
  const toggle = capabilities.reasoning?.thinkingToggleSupported ?? capabilities.thinking;
  const efforts = capabilities.reasoning?.reasoningEffortSupported ?? capabilities.nativeEfforts;
  return {
    'X-Local-AI-Managed-GGUF': '1',
    ...(toggle
      ? {
          'X-Local-AI-Managed-Qwen': efforts ? 'qwen35-v1' : 'qwen35-toggle-v1',
          'X-Local-AI-Vision': capabilities.vision ? '1' : '0',
        }
      : {}),
  };
}
