import { expect, it } from 'vitest';
import { withGpuLayerDefault } from './ggufConfig';
import type { GgufProfile } from './ggufTypes';
it('resolves only missing GPU-layer preferences and preserves explicit CPU values', () => {
  const missing = { name: 'legacy', backend: 'external' } as GgufProfile;
  expect(withGpuLayerDefault(missing).gpuLayers).toBe(999);
  expect(withGpuLayerDefault({ ...missing, gpuLayers: 0 }).gpuLayers).toBe(0);
  expect(withGpuLayerDefault({ ...missing, gpuLayers: 12 }).gpuLayers).toBe(12);
  expect(withGpuLayerDefault({ ...missing, backend: 'native' }).gpuLayers).toBe(0);
  expect(missing.gpuLayers).toBeUndefined();
});
