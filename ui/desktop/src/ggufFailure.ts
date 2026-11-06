// Local AI Desktop: classify bounded backend diagnostics without retaining request text.
import { open } from 'node:fs/promises';
export async function classifyRuntimeFailure(logPath?: string, since = 0) {
  if (!logPath) return 'processExit';
  const file = await open(logPath, 'r').catch(() => null);
  if (!file) return 'processExit';
  try {
    const size = (await file.stat()).size;
    const data = Buffer.alloc(Math.min(Math.max(0, size - since), 16384));
    await file.read(data, 0, data.length, Math.max(0, size - data.length));
    return /cudaMalloc failed: out of memory|failed to allocate CUDA\d* buffer/i.test(
      data.toString()
    )
      ? 'deviceMemory'
      : 'processExit';
  } finally {
    await file.close();
  }
}
