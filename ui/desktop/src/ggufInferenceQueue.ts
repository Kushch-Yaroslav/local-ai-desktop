type Waiter = {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
};

/** FIFO admission for requests sharing a managed llama-server. */
export class GgufInferenceQueue {
  private capacity = 1;
  private active = 0;
  private waiters: Waiter[] = [];

  setCapacity(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Inference capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.drain();
  }

  snapshot(): { capacity: number; active: number; waiting: number } {
    return { capacity: this.capacity, active: this.active, waiting: this.waiters.length };
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new DOMException(
              'Inference request cancelled while waiting for a server slot',
              'AbortError'
            )
          );
          this.drain();
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.capacity && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(
          new DOMException(
            'Inference request cancelled while waiting for a server slot',
            'AbortError'
          )
        );
        continue;
      }

      this.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.drain();
      });
    }
  }
}
