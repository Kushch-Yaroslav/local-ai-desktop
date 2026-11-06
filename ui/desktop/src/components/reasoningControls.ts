import type { ManagedReasoningCapabilities } from '../ggufReasoningCapabilities';
import type { ThinkingEffort } from '../types/providers';

export interface ReasoningControlCapabilities {
  thinkingToggle: boolean;
  effortOptions: ThinkingEffort[];
  status: 'available' | 'unsupported' | 'unknown';
}

const VALID_EFFORTS = new Set<ThinkingEffort>(['off', 'low', 'medium', 'high', 'max']);

/** Resolve only controls that the active provider/model explicitly advertises. */
export function resolveReasoningControls(options: {
  reasoning?: boolean | null;
  advertisedEfforts?: readonly string[];
  managed?: { thinking: boolean; nativeEfforts: boolean; reasoning?: ManagedReasoningCapabilities } | null;
}): ReasoningControlCapabilities {
  if (options.managed) {
    const detected = options.managed.reasoning;
    if (detected) return {
      thinkingToggle: detected.thinkingToggleSupported,
      effortOptions: detected.reasoningEffortSupported
        ? detected.supportedEfforts.map(value => value === 'xhigh' ? 'high' : value) : [],
      status: detected.status,
    };
    if (!options.managed.thinking) {
      return { thinkingToggle: false, effortOptions: [], status: 'unsupported' };
    }
    return {
      thinkingToggle: true,
      effortOptions: options.managed.nativeEfforts ? ['low', 'medium', 'high'] : [],
      status: 'available',
    };
  }

  if (options.advertisedEfforts !== undefined) {
    const values = options.advertisedEfforts.filter(
      (value): value is ThinkingEffort => VALID_EFFORTS.has(value as ThinkingEffort)
    );
    const effortOptions = values.filter((value) => value !== 'off');
    const thinkingToggle = values.includes('off') && effortOptions.length > 0;
    if (thinkingToggle || effortOptions.length > 0) {
      return { thinkingToggle, effortOptions, status: 'available' };
    }
    return {
      thinkingToggle: false,
      effortOptions: [],
      status: options.reasoning === false ? 'unsupported' : 'unknown',
    };
  }

  return {
    thinkingToggle: false,
    effortOptions: [],
    status: options.reasoning === false ? 'unsupported' : 'unknown',
  };
}
