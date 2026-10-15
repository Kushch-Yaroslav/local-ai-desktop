import assert from 'node:assert/strict';
import { DiscoveryConditionTracker, discoveryConditionSample } from './context-discovery-conditions';
import type { ContextDiscoveryOption, RuntimeContextEstimate } from '../../shared/context-estimator';
import { createVramBudget } from '../../shared/vram-budget';

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const budget = (background = 1024, llm = 20 * 1024) => createVramBudget(24 * GiB, (llm + background) * MiB, (24 * 1024 - llm - background) * MiB, llm * MiB);
const option: ContextDiscoveryOption = { modelId: 'fixture', contextWindow: 102400, kvCacheType: 'f16', kvOffload: true,
  discoveredAt: '2026-10-15T00:00:00Z', memoryBaseline: { hostAvailableBytes: 40 * GiB, deviceAvailableBytes: 3 * GiB },
  measuredHeadroom: { hostBytes: 30 * GiB, deviceBytes: 3 * GiB }, vramBudget: budget() };
const estimate = (background = 1024) => ({ status: 'estimated', memoryBaseline: option.memoryBaseline, vramBudget: budget(background) } as RuntimeContextEstimate);
const sample = (background = 1024, measured = option) => discoveryConditionSample(measured, estimate(background), true, 8 * GiB);

// Reproduce independent per-KV baseline comparisons crossing on idle desktop redraws.
const tracker = new DiscoveryConditionTracker();
const q8 = { ...option, kvCacheType: 'q8_0' as const, vramBudget: budget(1152) };
assert.equal(sample(1290), 'drift');
assert.equal(sample(1290, q8), 'comparable');
assert.equal(tracker.assess('fp16', sample(), 0), 'comparable');
assert.equal(tracker.assess('q8', sample(1024, q8), 0), 'comparable');
for (let i = 1; i <= 20; i++) {
  const background = i % 2 ? 1290 : 1270;
  assert.equal(tracker.assess('fp16', sample(background), i * 2000), 'comparable');
  assert.equal(tracker.assess('q8', sample(background, q8), i * 2000), 'comparable');
}
// Sustained drift still invalidates; a flapping recovery cannot remove a real warning.
for (const now of [42000, 44000]) assert.equal(tracker.assess('fp16', sample(1350), now), 'comparable');
assert.equal(tracker.assess('fp16', sample(1350), 46000), 'changed');
assert.equal(tracker.assess('q8', sample(1350, q8), 46000), 'comparable');
for (let i = 0; i < 8; i++) assert.equal(tracker.assess('fp16', i % 2 ? sample(1350) : sample(), 48000 + i * 2000), 'changed');
for (const now of [64000, 66000]) assert.equal(tracker.assess('fp16', sample(), now), 'changed');
assert.equal(tracker.assess('fp16', sample(), 68000), 'comparable');
// Brief unavailable samples preserve a recent assessment; prolonged loss warns.
assert.equal(tracker.assess('fp16', 'missing', 70000), 'comparable');
assert.equal(tracker.assess('fp16', 'missing', 77999), 'comparable');
assert.equal(tracker.assess('fp16', 'missing', 78000), 'unknown');
assert.equal(tracker.assess('unseen-measurement', 'missing', 78000), 'unknown');
assert.equal(tracker.assess('fp16', 'comparable', 80000), 'comparable');
assert.equal(tracker.assess('fp16', 'unknown', 80001), 'unknown', 'unconfirmed identity has no grace');
assert.equal(tracker.assess('fp16', 'identity-changed', 80002), 'changed');
assert.equal(tracker.assess('new-model-or-measurement', 'drift', 80003), 'changed', 'never inherit validity across measurements');
// A brief margin dip is stabilized, not accepted as a new fit measurement.
const nearCapacity = { ...option, vramBudget: budget(1000, 22650) };
assert.equal(discoveryConditionSample(nearCapacity, estimate(1100), true, 8 * GiB), 'drift');
// Reproduce the persisted 108K FP16 / 160K Q8 measurements: only 39/49 MiB
// remain beyond the validation margin. A 45 MiB redraw crosses only FP16.
const recordedBudget = (background: number, llm: number) => createVramBudget(24576 * MiB, (background + llm) * MiB, (24576 - background - llm - 457) * MiB, llm * MiB);
const recorded = { ...option, vramBudget: recordedBudget(1142, 22554) };
const recordedQ8 = { ...q8, vramBudget: recordedBudget(1142, 22544) };
const redraw = (extra: number) => ({ ...estimate(), vramBudget: recordedBudget(1142 + extra, 20480) });
assert.equal(discoveryConditionSample(recorded, redraw(45), true, 8 * GiB), 'drift');
assert.equal(discoveryConditionSample(recordedQ8, redraw(45), true, 8 * GiB), 'comparable');
const recordedTracker = new DiscoveryConditionTracker();
for (let i = 0; i < 20; i++) {
  for (const [key, measured] of [['recorded-fp16', recorded], ['recorded-q8', recordedQ8]] as const) {
    const current = redraw(i % 2 ? 45 : 35);
    assert.equal(recordedTracker.assess(key, discoveryConditionSample(measured, current, true, 8 * GiB), i * 2000), 'comparable');
  }
}
// Critical capacity loss and changed runtime/model/device identity are immediate.
assert.equal(discoveryConditionSample(option, { ...estimate(), vramBudget: budget(4096) }, true, 8 * GiB), 'unsafe');
assert.equal(tracker.assess('q8', 'unsafe', 80004), 'changed');
assert.equal(discoveryConditionSample(option, estimate(), false, 8 * GiB), 'identity-changed');
assert.equal(discoveryConditionSample(option, { ...estimate(), memoryBaseline: null }, true, 8 * GiB), 'missing');
assert.equal(discoveryConditionSample(option, { ...estimate(), memoryBaseline: { hostAvailableBytes: 0, deviceAvailableBytes: 3 * GiB } }, true, 8 * GiB), 'unsafe');
assert.equal(discoveryConditionSample(option, { ...estimate(), vramBudget: { ...budget(), totalBytes: 23 * GiB } }, true, 8 * GiB), 'unsafe');
console.log('Discovery display assessments: per-KV jitter, sustained changes/recovery, bounded telemetry grace, identity and immediate capacity invalidation passed.');
