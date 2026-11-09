import { expect, it } from 'vitest';
import { classifyRuntimeFailure } from './runtimeFailure';
it.each([
  ['cudaMalloc failed: out of memory', 'cuda-oom'],
  ['unknown argument --flash-attn', 'arguments'],
  ['Flash Attention not supported', 'flash-attention'],
  ['KV cache unsupported', 'kv-type'],
  ['failed to open model.gguf', 'gguf-load'],
  ['error while loading shared libraries', 'runtime'],
  ['readiness timeout', 'timeout'],
  ['process exited code=1', 'unexpected-exit'],
])('classifies %s as %s', (log, kind) => expect(classifyRuntimeFailure(log)).toBe(kind));
