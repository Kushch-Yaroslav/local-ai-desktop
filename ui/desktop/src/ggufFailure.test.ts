import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRuntimeFailure } from './ggufFailure';
it('classifies CUDA allocation failure without returning any raw log text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lad-failure-'));
  try {
    const file = join(dir, 'log');
    await writeFile(
      file,
      'private synthetic content\ncudaMalloc failed: out of memory\nGGML_ASSERT(buffer) failed'
    );
    expect(await classifyRuntimeFailure(file)).toBe('deviceMemory');
    expect(await classifyRuntimeFailure(join(dir, 'missing'))).toBe('processExit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
