import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LLAMA_SERVER_HEALTH_POLL_INTERVAL_MS,
  LLAMA_SERVER_STARTUP_TIMEOUT_MS,
  LlamaServerReadinessTimeout,
  waitForLlamaServerReadiness,
} from './managedGgufStartup';

afterEach(() => vi.useRealTimers());

describe('managed llama-server readiness deadline', () => {
  it('extends the old 60-second health window by exactly 2.5x', () => {
    expect(240 * LLAMA_SERVER_HEALTH_POLL_INTERVAL_MS).toBe(60_000);
    expect(LLAMA_SERVER_STARTUP_TIMEOUT_MS).toBe(150_000);
    expect(LLAMA_SERVER_STARTUP_TIMEOUT_MS / 60_000).toBe(2.5);
  });

  it('accepts readiness near the extended deadline', async () => {
    let clock = 0;
    const readyAtMs = 14_500;
    let probes = 0;
    await waitForLlamaServerReadiness({
      signal: new AbortController().signal,
      timeoutMs: 15_000,
      pollIntervalMs: 250,
      requestTimeoutMs: 500,
      now: () => clock,
      assertRunning: () => undefined,
      probe: async () => {
        probes += 1;
        clock += 500;
        return clock >= readyAtMs;
      },
      delay: async (ms) => {
        clock += ms;
      },
    });
    expect(clock).toBeGreaterThanOrEqual(readyAtMs);
    expect(clock).toBeLessThan(15_000);
    expect(probes).toBeGreaterThan(1);
  });

  it('reports a real child exit before waiting for the full deadline', async () => {
    const probe = vi.fn(async () => false);
    await expect(
      waitForLlamaServerReadiness({
        signal: new AbortController().signal,
        assertRunning: () => {
          throw new Error('GGUF:processExit:1');
        },
        probe,
      })
    ).rejects.toThrow('GGUF:processExit:1');
    expect(probe).not.toHaveBeenCalled();
  });

  it('times out at the total deadline, without multiplying per-request timeouts', async () => {
    let clock = 0;
    const timeouts: number[] = [];
    await expect(
      waitForLlamaServerReadiness({
        signal: new AbortController().signal,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        requestTimeoutMs: 800,
        now: () => clock,
        assertRunning: () => undefined,
        probe: async (timeout) => {
          timeouts.push(timeout);
          clock += timeout === 800 ? 700 : timeout;
          return false;
        },
        delay: async (ms) => {
          clock += ms;
        },
      })
    ).rejects.toBeInstanceOf(LlamaServerReadinessTimeout);
    expect(clock).toBe(2_000);
    expect(timeouts.at(-1)).toBe(100);
  });

  it('cancels promptly while sleeping between health probes', async () => {
    const controller = new AbortController();
    let enteredDelay!: () => void;
    const waiting = new Promise<void>((resolve) => {
      enteredDelay = resolve;
    });
    const readiness = waitForLlamaServerReadiness({
      signal: controller.signal,
      assertRunning: () => undefined,
      probe: async () => false,
      delay: (_ms, signal) =>
        new Promise<void>((_, reject) => {
          enteredDelay();
          if (signal.aborted) reject(new DOMException('cancelled', 'AbortError'));
          else
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('cancelled', 'AbortError')),
              { once: true }
            );
        }),
    });
    await waiting;
    controller.abort();
    await expect(readiness).rejects.toMatchObject({ name: 'AbortError' });
  });
});
