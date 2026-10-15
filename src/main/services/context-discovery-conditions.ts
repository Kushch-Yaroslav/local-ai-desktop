import type { ContextDiscoveryOption, RuntimeContextEstimate } from '../../shared/context-estimator';
import { vramBudgetStillFits, vramProbeGuardBytes } from '../../shared/vram-budget';

type Conditions = NonNullable<ContextDiscoveryOption['conditions']>;
type Sample = 'comparable' | 'drift' | 'unsafe' | 'identity-changed' | 'missing' | 'unknown';

/** Display assessments only. Activation/probing continue to use their immediate live checks. */
export function discoveryConditionSample(option: ContextDiscoveryOption, current: RuntimeContextEstimate, sameIdentity: boolean, hostReserveBytes: number): Sample {
  if (!sameIdentity) return 'identity-changed';
  if (current.status !== 'estimated' || !current.memoryBaseline || !current.vramBudget || !option.vramBudget) return 'missing';
  const hostHeadroom = option.measuredHeadroom.hostBytes + current.memoryBaseline.hostAvailableBytes - option.memoryBaseline.hostAvailableBytes;
  // A desktop redraw can briefly consume a few MiB of the 384 MiB validation
  // margin. Stabilize that display change, but never debounce critical capacity
  // loss below the existing emergency guard. Activation still checks the FULL
  // margin immediately using currentDiscoveryHeadroomFits, not this display sample.
  if (current.vramBudget.totalBytes !== option.vramBudget.totalBytes || hostHeadroom < hostReserveBytes
    || current.vramBudget.llmBytes + current.vramBudget.freeBytes - option.vramBudget.llmBytes < vramProbeGuardBytes) return 'unsafe';
  return option.memoryBaseline.hostAvailableBytes - current.memoryBaseline.hostAvailableBytes <= 2 * 1024 ** 3
    && vramBudgetStillFits(option.vramBudget, current.vramBudget) ? 'comparable' : 'drift';
}

/** Raw desktop VRAM readings can straddle the baseline tolerance when Chromium redraws.
 * Require sustained drift/recovery rather than letting each poll flip the catalog.
 * Missing telemetry is not evidence of changed configuration; retain a recent assessment
 * for at most 10 seconds, and never borrow an assessment from another measurement/KV mode. */
export class DiscoveryConditionTracker {
  private readonly states = new Map<string, { conditions: Conditions; completedAt?: number; pending?: Conditions; since: number; samples: number }>();

  assess(key: string, sample: Sample, now = performance.now()): Conditions {
    let state = this.states.get(key);
    if (!state) {
      state = { conditions: 'unknown', since: now, samples: 0 };
      this.states.set(key, state);
      if (this.states.size > 32) this.states.delete(this.states.keys().next().value!);
    }
    if (sample === 'missing' || sample === 'unknown') {
      state.pending = undefined;
      if (sample === 'unknown' || state.completedAt === undefined || now - state.completedAt >= 10_000) state.conditions = 'unknown';
      return state.conditions;
    }
    state.completedAt = now;
    const next = sample === 'comparable' ? 'comparable' : 'changed';
    if (sample === 'unsafe' || sample === 'identity-changed' || state.conditions === 'unknown' || state.conditions === next) {
      state.conditions = next;
      state.pending = undefined;
    } else {
      if (state.pending !== next) { state.pending = next; state.since = now; state.samples = 0; }
      state.samples += 1;
      if (state.samples >= 3 && now - state.since >= 4_000) { state.conditions = next; state.pending = undefined; }
    }
    return state.conditions;
  }
}
