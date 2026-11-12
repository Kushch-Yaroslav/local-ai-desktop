import { describe, expect, it } from 'vitest';
import { GgufKvScheduler, boundGgufGeneration } from './ggufKvScheduler';

const signal = () => new AbortController().signal;
describe('managed shared KV reservations', () => {
  it('runs three children simultaneously, waits for a full pool, then admits the full main context', async () => {
    const queue = new GgufKvScheduler();
    const pool = 170 * 1024;
    const child = Math.floor(pool / 4 / 256) * 256;
    queue.configure(4, pool);
    const children = await Promise.all(
      Array.from({ length: 3 }, () => queue.acquire(child, false, signal()))
    );
    expect(new Set(children.map((entry) => entry.slot)).size).toBe(3);
    expect(queue.snapshot()).toMatchObject({ active: 3, reservedTokens: 3 * child });
    let mainStarted = false,
      laterChildStarted = false;
    const main = queue.acquire(pool, true, signal()).then((lease) => {
      mainStarted = true;
      return lease;
    });
    const laterChild = queue.acquire(child, false, signal()).then((lease) => {
      laterChildStarted = true;
      return lease;
    });
    children[0].release();
    await Promise.resolve();
    expect(mainStarted).toBe(false);
    expect(laterChildStarted).toBe(false);
    children[1].release();
    children[2].release();
    const root = await main;
    expect(queue.snapshot().reservedTokens).toBe(pool);
    expect(laterChildStarted).toBe(false);
    root.release();
    (await laterChild).release();
    expect(queue.snapshot()).toMatchObject({ active: 0, reservedTokens: 0 });
  });
  it('cancels a waiting main reservation without blocking children and releases idempotently', async () => {
    const queue = new GgufKvScheduler();
    queue.configure(4, 170000);
    const child = await queue.acquire(40000, false, signal());
    const abort = new AbortController();
    const main = queue.acquire(170000, true, abort.signal);
    const next = queue.acquire(40000, false, signal());
    abort.abort();
    await expect(main).rejects.toMatchObject({ name: 'AbortError' });
    const second = await next;
    child.release();
    child.release();
    second.release();
    expect(queue.snapshot().reservedTokens).toBe(0);
  });
  it('does not overcommit a full KV pool and invalidates stale queued budgets after restart', async () => {
    const queue = new GgufKvScheduler();
    queue.configure(4, 174080);
    const children = await Promise.all(
      Array.from({ length: 4 }, () => queue.acquire(43520, false, signal()))
    );
    expect(queue.snapshot().reservedTokens).toBe(174080);
    const cancelled = new AbortController();
    const fifth = queue.acquire(43520, false, cancelled.signal);
    expect(queue.snapshot().waiting).toBe(1);
    cancelled.abort();
    await expect(fifth).rejects.toMatchObject({ name: 'AbortError' });
    const staleMain = queue.acquire(174080, true, signal());
    queue.configure(4, 70000);
    await expect(staleMain).rejects.toThrow('capacity changed');
    children.forEach((child) => child.release());
    expect(queue.snapshot().reservedTokens).toBe(0);
  });
  it('rejects a reservation larger than the actual pool', async () => {
    const queue = new GgufKvScheduler();
    queue.configure(4, 170000);
    await expect(queue.acquire(170001, false, signal())).rejects.toThrow('contextExceeded');
  });
  it('enforces prompt plus generation budget, including llama n_predict override and tools', () => {
    const tools = [{ type: 'function', function: { name: 'read' } }];
    const request = boundGgufGeneration(
      { tools, max_tokens: 99999, n_predict: -1, id_slot: 99 },
      12000,
      40000
    );
    expect(request).toMatchObject({
      tools,
      max_tokens: 27999,
      n_predict: 27999,
      cache_prompt: false,
    });
    expect(request).not.toHaveProperty('id_slot');
    expect(() => boundGgufGeneration({}, 40000, 40000)).toThrow('contextExceeded');
    expect(() => boundGgufGeneration({ n: 3 }, 10, 40000)).toThrow('unsupportedBudget');
  });
});
