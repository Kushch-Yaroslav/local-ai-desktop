// Local AI Desktop: startup errors are not memory measurements.
export function classifyRuntimeFailure(log: string): string {
  if (
    /cudaMalloc failed: out of memory|CUDA(?: error)?:?\s+out of memory|cudaErrorMemoryAllocation|failed to allocate.*(?:CUDA|buffer)/i.test(
      log
    )
  )
    return 'cuda-oom';
  if (/runtime diagnostic limit reached|discoveryDiagnosticsTruncated/.test(log))
    return 'diagnostics-truncated';
  if (/flash.attention.*(?:not supported|unsupported|failed|requires)/i.test(log))
    return 'flash-attention';
  if (/(?:cache.type|KV cache).*(?:unsupported|not supported|invalid)/i.test(log)) return 'kv-type';
  if (/failed to (?:load|open).*gguf|invalid.*gguf/i.test(log)) return 'gguf-load';
  if (/unknown argument|unrecognized option|invalid argument/i.test(log)) return 'arguments';
  if (/error while loading shared libraries|ENOENT|not found/i.test(log)) return 'runtime';
  if (/timeout|timed out/i.test(log)) return 'timeout';
  return 'unexpected-exit';
}
