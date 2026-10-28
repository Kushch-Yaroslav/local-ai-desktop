import type { AgentTelemetry, ToolActivity } from '../../shared/types';
import type { ToolCallingBackend, ToolMessage, ToolInferenceRequestContext } from '../backends/types';

type Usage = { inputTokens?: number; outputTokens?: number };
const measured = (n: number | undefined) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;

/** Per-run observer. It never estimates tokens, changes requests or owns cancellation. */
export class ChatTelemetry {
  private readonly requests: Usage[] = [];
  private readonly tools = new Set<string>();
  private readonly compactions = new Set<string>();
  private readonly startedAt = new Date().toISOString();
  private updatedAt = this.startedAt;
  private finishedAt?: string;
  private contextLimit?: number;
  private speed?: number;
  constructor(private readonly modelId: string, private readonly publish: (snapshot: AgentTelemetry) => void) {}

  snapshot(): AgentTelemetry {
    const last = this.requests.at(-1);
    return {
      source: 'chat', modelId: this.modelId, startedAt: this.startedAt, updatedAt: this.updatedAt, finishedAt: this.finishedAt,
      turn: this.requests.length, actions: this.tools.size, compactions: this.compactions.size,
      inputTokens: this.requests.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
      outputTokens: this.requests.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
      inputTokensKnown: this.requests.length > 0 && this.requests.every(r => r.inputTokens !== undefined),
      outputTokensKnown: this.requests.length > 0 && this.requests.every(r => r.outputTokens !== undefined),
      inputTokensReported: this.requests.some(r => r.inputTokens !== undefined),
      outputTokensReported: this.requests.some(r => r.outputTokens !== undefined),
      contextUsed: last?.inputTokens === undefined ? undefined : last.inputTokens + (last.outputTokens ?? 0),
      contextLimit: this.contextLimit, tokensPerSecond: this.speed,
    };
  }
  private emit() { this.updatedAt = new Date().toISOString(); try { this.publish(this.snapshot()); } catch { /* Observability cannot fail a run. */ } }
  start() { this.emit(); }
  finish() { if (!this.finishedAt) { this.finishedAt = new Date().toISOString(); this.emit(); } }
  activity(activity: ToolActivity) {
    if (activity.toolName && activity.state === 'running') this.tools.add(activity.id);
    else if (activity.kind === 'context' && activity.state === 'completed') this.compactions.add(activity.id);
    else return;
    this.emit();
  }
  private begin(limit: number): Usage {
    const request: Usage = {}; this.requests.push(request); this.contextLimit = limit; this.speed = undefined; this.emit(); return request;
  }
  private update(request: Usage, usage: Usage) {
    for (const key of ['inputTokens', 'outputTokens'] as const) {
      const value = measured(usage[key]); if (value !== undefined) request[key] = value;
    }
    this.emit();
  }
  private complete(request: Usage, response: ToolMessage) {
    this.speed = measured(response.inference?.tokensPerSecond);
    // inference.inputTokens can be a character-based fallback; only actual
    // prompt usage or the measured preflight callback is accepted here.
    this.update(request, { inputTokens: response.prompt_eval_count ?? response.inference?.promptEvalCount, outputTokens: response.inference?.evalCount });
  }
  observe<T extends ToolCallingBackend>(backend: T): T {
    const begin = this.begin.bind(this), complete = this.complete.bind(this);
    const metadata = (request: Usage, context?: ToolInferenceRequestContext): ToolInferenceRequestContext => ({
      ...context, onUsage: usage => { this.update(request, usage); try { context?.onUsage?.(usage); } catch { /* observational callback */ } },
    });
    return new Proxy(backend, { get(target, property) {
      if (property === 'chatWithTools') return async (...args: Parameters<ToolCallingBackend['chatWithTools']>) => {
        const request = begin(args[4]); args[6] = metadata(request, args[6]);
        const response = await target.chatWithTools(...args); complete(request, response); return response;
      };
      if (property === 'streamWithTools' && target.streamWithTools) return async function* (...args: Parameters<NonNullable<ToolCallingBackend['streamWithTools']>>) {
        const request = begin(args[4]); args[6] = metadata(request, args[6]);
        for await (const delta of target.streamWithTools!(...args)) {
          if (delta.type === 'response') complete(request, delta.response);
          yield delta;
        }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}
