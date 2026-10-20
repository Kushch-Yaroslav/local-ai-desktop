import assert from 'node:assert/strict';
import { authorConfigurations, authorConfigurationPatch, compatibleAuthorConfiguration } from './author-configurations';
import type { ModelInspection } from './model-profiles';
import type { RuntimeModelConfiguration } from './types';

const qwen = authorConfigurations.find(row => row.id === 'coder80')!;
const gpt20 = authorConfigurations.find(row => row.id === 'gpt20')!;
const gemma = authorConfigurations.find(row => row.id === 'gemma')!;
const inspection: ModelInspection = {
  status: 'inspected', detectedFamily: 'qwen', selectedFamily: 'auto', effectiveFamily: 'qwen',
  architecture: 'qwen3next', template: 'jinja', quantization: 'Q4_K_M', fileType: 15,
  layers: 48, experts: 512, activeExperts: 10, reasoning: { thinkingToggle: false, efforts: [] }, toolTemplate: true,
};
const profile: RuntimeModelConfiguration = {
  id: 'custom:qwen-coder-next', displayName: 'Qwen Coder Next', modelPath: '/models/model.gguf', mmprojPath: '',
  gpuLayers: 24, supportsTools: true, speculative: 'none', builtin: false,
  advanced: { mode: 'automatic', cpuMoe: 'first', cpuMoeLayers: 32, threads: 8 },
  defaults: { contextWindow: 32768, kvCacheType: 'f16', kvOffload: false },
};

assert.equal(qwen.gpuLayers, 48);
assert.equal(qwen.contextWindow, 65536);
assert.equal(qwen.kvCacheType, 'q8_0');
assert.equal(qwen.status, 'author-tested');
assert.match(qwen.noteEn, /32 CPU MoE layers/);
assert.equal(gpt20.contextWindow, 131072);
assert.equal(gpt20.kvCacheType, 'f16');
assert.equal(gpt20.weights, 'MXFP4');
assert.equal(gemma.weights, 'Q4');
assert.equal(compatibleAuthorConfiguration(qwen, inspection, profile.id), true);

const patch = authorConfigurationPatch(qwen, profile, inspection)!;
assert.equal(patch.gpuLayers, 48);
assert.deepEqual(patch.defaults, { contextWindow: 65536, kvCacheType: 'q8_0', kvOffload: false });
assert.deepEqual(patch.advanced, { mode: 'gpu-layers', cpuMoe: 'first', cpuMoeLayers: 32, threads: 8 });
assert.equal(profile.gpuLayers, 24, 'applying a suggestion must not mutate or save the current profile');
assert.equal(authorConfigurationPatch(qwen, profile, { ...inspection, experts: 4 }), undefined, 'an incompatible GGUF is never modified');
console.log('PASS author model observations and draft-only starting-point application');
