import { describe, expect, it } from 'vitest';
import { classifyManagedGatewayFailure } from './managedGguf';

describe('managed llama-server failure classification', () => {
  it.each([
    ['prompt exceeds the context length limit', 'GGUF:contextExceeded:'],
    ['GGUF:contextUnavailable: /props did not report a context', 'GGUF:contextUnavailable:'],
    ['cudaMalloc failed: out of memory', 'GGUF:deviceMemory:'],
    ['std::bad_alloc: not enough memory', 'GGUF:hostMemory:'],
    ['request timed out', 'GGUF:timeout:'],
    ['ECONNREFUSED 127.0.0.1', 'GGUF:serverUnavailable:'],
  ])('classifies %s', (detail, expected) => {
    expect(
      classifyManagedGatewayFailure(new Error(detail), new AbortController().signal, false)
    ).toBe(expected);
  });

  it('distinguishes cancellation and a broken response stream', () => {
    const cancelled = new AbortController();
    cancelled.abort();
    expect(classifyManagedGatewayFailure(new Error('abort'), cancelled.signal, false)).toBe(
      'GGUF:cancelled:'
    );
    expect(
      classifyManagedGatewayFailure(new Error('socket closed'), new AbortController().signal, true)
    ).toBe('GGUF:streamAborted:');
  });
});
