import { expect, it } from 'vitest';
import { ManagedSseObservation } from './managedSseObservation';
it('records actual fragmented output intervals and context errors without content', () => {
  const observer = new ManagedSseObservation();
  expect(observer.feed(Buffer.from('data: {"choices":[{"delta":{"content":"PRIVATE'))).toEqual([]);
  expect(observer.feed(Buffer.from(' TEXT"}}]}\n\n'))).toEqual([{ phase: 'first_output' }]);
  expect(
    observer.feed(
      Buffer.from(
        'data: {"choices":[{"delta":{"tool_calls":[{"arguments":"secret"}]},"finish_reason":"tool_calls"}]}\n'
      )
    )
  ).toEqual([{ phase: 'output_finished' }]);
  const event = observer.feed(
    Buffer.from(
      'data: {"error":{"message":"Context size has been exceeded.","n_ctx":28672,"n_prompt_tokens":30000}}\n'
    )
  );
  expect(event).toEqual([
    {
      phase: 'stream_error',
      kind: 'kvCapacityExceeded',
      effectiveLimit: 28672,
      promptTokens: 30000,
    },
  ]);
  expect(JSON.stringify(event)).not.toContain('PRIVATE');
});

it('records an OpenAI error object without treating its message as output', () => {
  const observer = new ManagedSseObservation();
  expect(
    observer.feed(
      Buffer.from('data: {"object":"error","message":"prompt exceeds context length"}\n')
    )
  ).toEqual([{ phase: 'stream_error', kind: 'contextExceeded' }]);
});
