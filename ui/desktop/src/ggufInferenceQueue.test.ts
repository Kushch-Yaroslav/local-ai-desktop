import { describe, expect, it } from 'vitest';
import { GgufInferenceQueue } from './ggufInferenceQueue';

describe('GgufInferenceQueue', () => {
  it('admits no more requests than the measured server capacity', async () => {
    const queue = new GgufInferenceQueue();
    queue.setCapacity(2);
    const first = await queue.acquire(new AbortController().signal);
    const second = await queue.acquire(new AbortController().signal);
    let thirdAdmitted = false;
    const thirdPromise = queue.acquire(new AbortController().signal).then((release) => {
      thirdAdmitted = true;
      return release;
    });

    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    first();
    const third = await thirdPromise;
    expect(thirdAdmitted).toBe(true);
    second();
    third();
  });

  it('removes an aborted waiter and admits the next request', async () => {
    const queue = new GgufInferenceQueue();
    const active = await queue.acquire(new AbortController().signal);
    const cancelled = new AbortController();
    const waiting = queue.acquire(cancelled.signal);
    const next = queue.acquire(new AbortController().signal);

    cancelled.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    active();
    const releaseNext = await next;
    releaseNext();
  });

  it('serializes unified-cache requests while preserving single request access', async () => {
    const queue = new GgufInferenceQueue();
    queue.setCapacity(1);
    const first = await queue.acquire(new AbortController().signal);
    let admitted = false;
    const waiting = queue.acquire(new AbortController().signal).then((release) => {
      admitted = true;
      return release;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);
    first();
    (await waiting)();
    expect(admitted).toBe(true);
  });
});
