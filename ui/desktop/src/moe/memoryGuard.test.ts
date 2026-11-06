import { it, expect } from 'vitest';
import { placementMemorySafe } from './memoryGuard';
it('retains the donor exact 7 GiB runtime reserve and rejects unavailable telemetry', () => {
  expect(placementMemorySafe('MemAvailable: 7340032 kB')).toBe(true);
  expect(placementMemorySafe('MemAvailable: 7340031 kB')).toBe(false);
  expect(placementMemorySafe('')).toBe(false);
});
