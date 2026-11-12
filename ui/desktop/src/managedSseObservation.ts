// Local AI Desktop: bounded SSE diagnostics; never emits response text or tool arguments.
import { StringDecoder } from 'node:string_decoder';
export class ManagedSseObservation {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private dropping = false;
  private started = false;
  private finished = false;
  feed(chunk: Uint8Array): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    this.pending += this.decoder.write(Buffer.from(chunk));
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).trim();
      this.pending = this.pending.slice(end + 1);
      if (this.dropping) {
        this.dropping = false;
        continue;
      }
      if (!line.startsWith('data:') || line.length > 262144) continue;
      try {
        const frame = JSON.parse(line.slice(5));
        const error = frame.error ?? (frame.object === 'error' ? frame : undefined);
        if (error) {
          const message = String(error.message ?? '');
          const kind = /context size has been exceeded/i.test(message)
            ? 'kvCapacityExceeded'
            : /context.{0,40}(exceed|limit|length|size)|contextexceeded/i.test(message)
              ? 'contextExceeded'
              : /cuda|vram/i.test(message) && /alloc|memory|out of/i.test(message)
                ? 'deviceMemory'
                : /out of memory|bad_alloc/i.test(message)
                  ? 'hostMemory'
                  : 'serverError';
          events.push({
            phase: 'stream_error',
            kind,
            ...(Number.isSafeInteger(error.n_ctx) ? { effectiveLimit: error.n_ctx } : {}),
            ...(Number.isSafeInteger(error.n_prompt_tokens)
              ? { promptTokens: error.n_prompt_tokens }
              : {}),
          });
        }
        for (const choice of frame.choices ?? []) {
          const delta = choice.delta ?? {};
          if (
            !this.started &&
            (delta.content || delta.reasoning_content || delta.tool_calls?.length)
          ) {
            this.started = true;
            events.push({ phase: 'first_output' });
          }
          if (!this.finished && choice.finish_reason != null) {
            this.finished = true;
            events.push({ phase: 'output_finished' });
          }
        }
      } catch {
        /* DONE, metadata, or an incomplete/unsupported frame carries no token diagnostic. */
      }
    }
    if (this.pending.length > 262144) {
      this.pending = '';
      this.dropping = true;
    }
    return events;
  }
}
