export const LLAMA_SERVER_STARTUP_TIMEOUT_MS = 150_000;
export const LLAMA_SERVER_HEALTH_POLL_INTERVAL_MS = 250;
export const LLAMA_SERVER_HEALTH_REQUEST_TIMEOUT_MS = 800;

export class LlamaServerReadinessTimeout extends Error {
  constructor() {
    super('llama-server readiness deadline exceeded');
    this.name = 'LlamaServerReadinessTimeout';
  }
}

export interface WaitForLlamaServerReadinessOptions {
  signal: AbortSignal;
  assertRunning: () => void;
  probe: (timeoutMs: number) => Promise<boolean>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Model startup cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Poll health until ready or one bounded wall-clock deadline expires. */
export async function waitForLlamaServerReadiness({
  signal,
  assertRunning,
  probe,
  timeoutMs = LLAMA_SERVER_STARTUP_TIMEOUT_MS,
  pollIntervalMs = LLAMA_SERVER_HEALTH_POLL_INTERVAL_MS,
  requestTimeoutMs = LLAMA_SERVER_HEALTH_REQUEST_TIMEOUT_MS,
  now = Date.now,
  delay = abortableDelay,
}: WaitForLlamaServerReadinessOptions): Promise<void> {
  const deadline = now() + timeoutMs;
  while (true) {
    signal.throwIfAborted();
    assertRunning();
    const remaining = deadline - now();
    if (remaining <= 0) throw new LlamaServerReadinessTimeout();

    const ready = await probe(Math.max(1, Math.min(requestTimeoutMs, remaining)));
    signal.throwIfAborted();
    assertRunning();
    if (ready) return;

    const afterProbe = deadline - now();
    if (afterProbe <= 0) throw new LlamaServerReadinessTimeout();
    await delay(Math.min(pollIntervalMs, afterProbe), signal);
  }
}
