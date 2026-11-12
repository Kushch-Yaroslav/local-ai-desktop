// Local AI Desktop: capacity reservations and safe numerical admission diagnostics.
export class GgufContextBudgetError extends Error {
  constructor(
    readonly effectiveLimit: number,
    readonly promptTokens: number
  ) {
    super(
      `GGUF:contextExceeded: effective limit: ${effectiveLimit}, templated prompt: ${promptTokens}, required output headroom: 1`
    );
  }
}

/** Reservations cover prompt + maximum generation, not just occupied KV tokens. */
export class GgufKvScheduler {
  private slots = 1;
  private tokens = 1;
  private used = new Map<number, number>();
  private waiting: Array<{
    budget: number;
    main: boolean;
    signal: AbortSignal;
    resolve: (lease: { slot: number; release: () => void }) => void;
    reject: (error: Error) => void;
    abort: () => void;
  }> = [];

  configure(slots: number, tokens: number) {
    if (!Number.isSafeInteger(slots) || slots < 1 || !Number.isSafeInteger(tokens) || tokens < 1)
      throw new RangeError('Invalid KV capacity');
    this.slots = slots;
    this.tokens = tokens;
    this.waiting = this.waiting.filter((waiter) => {
      if (waiter.budget <= tokens) return true;
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(new Error('GGUF:serverError: runtime KV capacity changed while waiting'));
      return false;
    });
    this.drain();
  }

  acquire(
    budget: number,
    main: boolean,
    signal: AbortSignal
  ): Promise<{ slot: number; release: () => void }> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > this.tokens)
      return Promise.reject(new Error('GGUF:contextExceeded: reservation exceeds KV pool'));
    return new Promise((resolve, reject) => {
      const waiter = { budget, main, signal, resolve, reject, abort: () => {} };
      waiter.abort = () => {
        this.waiting = this.waiting.filter((entry) => entry !== waiter);
        reject(new DOMException('Cancelled while waiting for KV capacity', 'AbortError'));
        this.drain();
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  snapshot() {
    return {
      capacity: this.slots,
      active: this.used.size,
      waiting: this.waiting.length,
      reservedTokens: [...this.used.values()].reduce((a, b) => a + b, 0),
      poolTokens: this.tokens,
    };
  }

  private drain() {
    // Once the main agent waits, new children cannot consume the resources it needs.
    while (this.waiting.length && this.used.size < this.slots) {
      const index = Math.max(
        0,
        this.waiting.findIndex((entry) => entry.main)
      );
      const next = this.waiting[index];
      const available = this.tokens - [...this.used.values()].reduce((a, b) => a + b, 0);
      if (next.budget > available) break;
      let slot = 0;
      while (this.used.has(slot)) slot++;
      this.waiting.splice(index, 1);
      next.signal.removeEventListener('abort', next.abort);
      if (next.signal.aborted) {
        next.reject(new DOMException('Cancelled', 'AbortError'));
        continue;
      }
      this.used.set(slot, next.budget);
      let released = false;
      next.resolve({
        slot,
        release: () => {
          if (released) return;
          released = true;
          this.used.delete(slot);
          this.drain();
        },
      });
    }
  }
}

/** llama-server enforces the output half through max_tokens; no per-request n_ctx exists. */
export function boundGgufGeneration(
  payload: Record<string, unknown>,
  promptTokens: number,
  budget: number
) {
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 || promptTokens + 1 >= budget)
    throw new GgufContextBudgetError(budget, promptTokens);
  if (payload.n !== undefined && payload.n !== 1)
    throw new Error('GGUF:unsupportedBudget: multiple completions require separate reservations');
  const requested = payload.max_completion_tokens ?? payload.max_tokens ?? payload.n_predict;
  if (
    requested !== undefined &&
    (!Number.isSafeInteger(requested) || ((requested as number) < 1 && requested !== -1))
  )
    throw new Error('GGUF:unsupportedBudget: invalid output limit');
  const maxTokens = Math.min(
    typeof requested === 'number' && requested > 0 ? requested : budget,
    budget - promptTokens - 1
  );
  const result = { ...payload, max_tokens: maxTokens, n_predict: maxTokens, cache_prompt: false };
  delete (result as Record<string, unknown>).max_completion_tokens;
  // Prevent caller-selected slots, context shifting or speculative fan-out from bypassing admission.
  delete (result as Record<string, unknown>).id_slot;
  return result;
}
