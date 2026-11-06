import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {cachePrecisionMismatch,parseLlamaAllocationLog} from './contextEstimate';
const real=readFileSync('src/contextDiscovery/fixtures/qwen35-q8-mtp-f16.log','utf8');
describe('independent target and MTP cache precision from real d1d3c33 allocation lines',()=>{
 const evidence=parseLlamaAllocationLog(real,['--spec-type','draft-mtp']);
 it('accepts Q8 target with default F16 MTP while retaining both allocations',()=>{
  expect(evidence.kvTypeK).toBe('q8_0');expect(evidence.speculativeKvTypeK).toBe('f16');
  expect(cachePrecisionMismatch(evidence,'q8_0',['--cache-type-k','q8_0','--cache-type-v','q8_0','--spec-type','draft-mtp'])).toBe(false);
  expect(evidence.allocations.kv.device).toBe(544*1024**2);expect(evidence.allocations.speculativeKv.device).toBe(64*1024**2);
 });
 it('still rejects a wrong target precision',()=>expect(cachePrecisionMismatch(evidence,'f16',[])).toBe(true));
 it('still rejects a draft precision inconsistent with explicit draft flags',()=>expect(cachePrecisionMismatch(evidence,'q8_0',['--cache-type-k-draft','q8_0'])).toBe(true));
 it('rejects absent launch evidence for a speculative context',()=>expect(cachePrecisionMismatch(evidence,'q8_0')).toBe(true));
});
