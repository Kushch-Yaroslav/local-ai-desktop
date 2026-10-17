import assert from 'node:assert/strict';
import { buildContextChoices, contextChoiceId, normalContextForModel, normalContextPatch, resolveLlamaKvSelection } from './context-options';
import type { ContextDiscoveryOption } from './context-estimator';
import { llamaContextPresets } from '../main/models/llama-runtime-policy';

const qwen = 'qwen3.8:27b-q4_K_M';
const qwen36 = 'qwen3.6:35b-a3b-ud-q4_k_m';
const glm = 'glm-4.7-flash:q4_k';
const option = (modelId: string, contextWindow: number, kvCacheType: 'f16' | 'q8_0'): ContextDiscoveryOption => ({
  modelId, contextWindow, kvCacheType, kvOffload: true, discoveredAt: new Date().toISOString(),
  memoryBaseline: { hostAvailableBytes: 50, deviceAvailableBytes: 24 }, measuredHeadroom: { hostBytes: 10, deviceBytes: 3 },
});

export function runContextOptionsRegression() {
  assert.deepEqual(llamaContextPresets(qwen), [16384, 32768, 65536, 131072, 262144]);
  assert.deepEqual(llamaContextPresets(qwen36), [16384, 32768, 65536, 131072, 262144]);
  assert.deepEqual(llamaContextPresets(glm), [16384, 32768, 65536, 131072]);
  assert.deepEqual(llamaContextPresets(qwen, 65536), [16384, 32768, 65536], 'only trained/backend capability may reduce normal presets');
  for (const model of [qwen, glm]) {
    const normal = llamaContextPresets(model);
    const limit = normal.at(-1)!;
    const before = buildContextChoices(model, normal, limit, []);
    const after = buildContextChoices(model, normal, limit, [option(model, 24576, 'f16'), option(model, 57344, 'q8_0')]);
    for (const choice of before) assert(after.some((candidate) => contextChoiceId(candidate) === contextChoiceId(choice)), 'hardware discovery truncated a normal choice');
    assert.equal(after.length, before.length + 2, 'only exact discovered sizes supplement the compact defaults; each KV column has its own maximum');
    const equal = buildContextChoices(model, normal, limit, [option(model, 65536, 'f16')]);
    assert.equal(equal.length, before.length, 'identical configuration/context must be annotated, not duplicated');
    assert.match(equal.find((candidate) => candidate.contextWindow === 65536)!.label, /FP16/);
    assert.deepEqual(buildContextChoices(model, normal, limit, [option('other-model', 24576, 'q8_0'), option(model, limit + 4096, 'f16')]), before, 'wrong-model and above-capability evidence was reused');
    assert.deepEqual(buildContextChoices(model, normal, limit, []), before, 'failed discovery must preserve all normal options');
  }
  const measured = { ...option(qwen,102400,'f16'), conditions: 'comparable' as const };
  const choices = buildContextChoices(qwen, [],262144,[measured]);
  assert.equal(choices.length,11);
  assert.equal(new Set(choices.map(contextChoiceId)).size,choices.length);
  assert.equal(choices.find(o => o.contextWindow===65536 && o.kvCacheType==='f16')?.status,'fit');
  assert.equal(choices.find(o => o.contextWindow===102400 && o.kvCacheType==='f16')?.status,'maximum');
  assert.equal(choices.find(o => o.contextWindow===131072 && o.kvCacheType==='f16')?.status,'above');
  assert.equal(choices.find(o => o.contextWindow===65536 && o.kvCacheType==='q8_0')?.status,'unevaluated','FP16 validation cannot transfer to Q8');
  const changed = buildContextChoices(qwen, [],262144,[{...measured,conditions:'changed'}]);
  assert(changed.filter(o => o.contextWindow<=102400).every(o => o.status==='unevaluated'));
  assert(changed.find(o => o.contextWindow===65536 && o.kvCacheType==='f16')?.warning);
  assert(buildContextChoices('other',[],65536,[measured]).every(o=>o.contextWindow<=65536 && o.status==='unevaluated'));
  assert(buildContextChoices(qwen,[],262144,[measured],'f16',['f16']).every(o=>o.kvCacheType==='f16'));
  const independent = buildContextChoices(qwen,[],262144,[measured,{...option(qwen,131072,'q8_0'),conditions:'comparable'}]);
  assert.equal(independent.find(o=>o.contextWindow===131072&&o.kvCacheType==='q8_0')?.status,'maximum');
  assert.equal(independent.find(o=>o.contextWindow===131072&&o.kvCacheType==='f16')?.status,'above');
  const restored = buildContextChoices(qwen, llamaContextPresets(qwen), 262144, [option(qwen, 73728, 'f16'), option(qwen, 110592, 'q8_0')]);
  assert(restored.some(o => o.label === '72K (FP16)' && contextChoiceId(o) === '73728:f16:gpu'));
  assert(restored.some(o => o.label === '108K (Q8)' && contextChoiceId(o) === '110592:q8_0:gpu'));
  const unknown = buildContextChoices(qwen, [], 262144, [{ ...measured, conditions: 'unknown', restored: true }]);
  assert(unknown.every(choice => !choice.warning), 'missing telemetry alone must not fabricate a yellow warning');
  assert.match(unknown.find(choice => choice.contextWindow === 65536 && choice.kvCacheType === 'f16')!.explanation!, /предыдущему измерению/);
  const previous = buildContextChoices(qwen, [], 262144, [{ ...measured, restored: true }]);
  assert.equal(previous.find(choice => choice.contextWindow === 65536 && choice.kvCacheType === 'f16')?.status, 'fit');
  assert.match(previous.find(choice => choice.contextWindow === 65536 && choice.kvCacheType === 'f16')!.explanation!, /текущие условия сопоставимы/);
  const current = { llamaKvCacheType: 'q8_0' as const, llamaKvOffload: false };
  assert.deepEqual(resolveLlamaKvSelection(current, { contextWindow: 65536 }, false), current);
  assert.deepEqual(resolveLlamaKvSelection(current, {}, true), { llamaKvCacheType: 'f16', llamaKvOffload: true }, 'model change must discard the previous cache override');
  assert.deepEqual(resolveLlamaKvSelection(current, {}, false), current, 'non-runtime edits must preserve the selected configuration');
  assert.deepEqual(normalContextPatch(65536), { contextWindow: 65536, llamaKvCacheType: 'f16', llamaKvOffload: true });
  const normalQ8 = { llamaKvCacheType: 'q8_0' as const, llamaKvOffload: true };
  assert.deepEqual(resolveLlamaKvSelection({ llamaKvCacheType: 'f16', llamaKvOffload: false }, {}, true, normalQ8), normalQ8, 'a newly selected CPU-offloaded runtime uses its own validated normal cache mode');
  assert.deepEqual(resolveLlamaKvSelection(current, { contextWindow: 65536 }, false, normalQ8), current);
  const q8Choices = buildContextChoices('future-moe', [16384, 32768, 65536], 262144, [option('future-moe', 53248, 'f16'), option('future-moe', 98304, 'q8_0')], 'q8_0');
  assert(q8Choices.some((choice) => choice.contextWindow === 65536 && choice.kvCacheType === 'q8_0' && choice.label === '64K (Q8)'), 'normal 64K/Q8 must be selectable without fabricating a Max result');
  assert(q8Choices.some((choice) => choice.contextWindow === 53248 && choice.kvCacheType === 'f16'), 'measured FP16 remains independent of normal Q8');
  assert.equal(normalContextForModel(106496, llamaContextPresets(glm)), 65536, 'model change must replace an unverified custom context with a normal target-model preset');
  assert.equal(normalContextForModel(262144, llamaContextPresets(glm)), 131072, 'model change must respect the new model capability');
  assert.equal(normalContextForModel(16384, llamaContextPresets(qwen)), 16384);
  const qwen36Choices = buildContextChoices(qwen36, llamaContextPresets(qwen36), 262144, [], 'q8_0');
  assert(qwen36Choices.some((choice) => choice.contextWindow === 65536 && choice.kvCacheType === 'q8_0' && choice.label === '64K (Q8)'));
}

if (require.main === module) runContextOptionsRegression();
