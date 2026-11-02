import assert from 'node:assert/strict';
import {parseLlamaPlacement} from '../services/llama-placement';
import {normalizeAdvanced} from '../../shared/model-configuration';
import {estimateHostMemory,modelCgroupLimitMiB,estimateModelMemory,parseLayerRanges,formatLayerRanges,profileRuntimePath} from '../../shared/model-memory';
import {resolvePlacement} from '../services/model-placement';
import {advancedPlacementArguments} from './advanced-placement';
import {placementArguments} from './llama-launch-config';
import type {ModelInspection,BackendFeatureProbe} from '../../shared/model-profiles';
import type {RuntimeModelConfiguration} from '../../shared/types';
const info:ModelInspection={status:'inspected',modelName:'Qwen3 Coder Next',architecture:'qwen3next',fileType:15,layers:48,experts:512,activeExperts:10,detectedFamily:'qwen',selectedFamily:'auto',effectiveFamily:'qwen',template:'jinja',reasoning:{thinkingToggle:false,efforts:[]},toolTemplate:true,structure:{complete:true,totalBytes:48*1024**3,tensors:Array.from({length:48},(_,block)=>({name:`blk.${block}.ffn_up_exps.weight`,bytes:1024**3,block,expert:true,type:12})),kvHeads:2,keyLength:256,valueLength:256,fullAttentionLayers:12,recurrentLayers:36}};
const features:BackendFeatureProbe={status:'supported',flags:['--fit','--override-tensor','--moe-cache-mib','--cpu-moe','--no-host','--no-repack','--lazy-mode','--threads','--threads-batch','--batch-size','--ubatch-size','--load-mode'],buffers:['CPU','CUDA0'],version:'5047748'};
const model:RuntimeModelConfiguration={id:'test',displayName:'test',modelPath:'/model',mmprojPath:'',gpuLayers:999,builtin:false,supportsTools:true,speculative:'none',advanced:{mode:'gpu-layers',cpuMoe:'all',moeAcceleration:'manual',expertCacheMiB:16384}};
assert.deepEqual(parseLayerRanges('3-12, 15, 16-20',48),[3,4,5,6,7,8,9,10,11,12,15,16,17,18,19,20]);
for(const input of ['1-0','48','-1','1,,2','1.5','a'])assert.throws(()=>parseLayerRanges(input,48));
assert.equal(formatLayerRanges([3,4,5,9]),'3-5, 9');
assert.equal(profileRuntimePath({...model.advanced!,moeAcceleration:'disabled'},'/standard'),'/standard');
assert.equal(profileRuntimePath(model.advanced,'/standard'),'/standard');
const estimate=estimateModelMemory(info,model.advanced,999,{contextWindow:65536,kvCacheType:'q8_0'},23000,24576);assert.equal(estimate.kvMiB,816);assert.equal(estimate.cpuWeightsMiB,49152);assert.equal(estimate.cacheMiB,16384);assert(estimate.fits);
const plan=resolvePlacement(model,{inspection:info,features,backendPath:'/experimental',availableMiB:23000,totalMiB:24576},999,{contextWindow:65536,kvCacheType:'q8_0'});assert(plan.args.includes('--moe-cache-mib'));assert(plan.args.includes('16384'));assert(plan.args.includes('--cpu-moe'));
assert.throws(()=>resolvePlacement(model,{inspection:info,features,backendPath:'/experimental',availableMiB:12000,totalMiB:24576},999));
const fallback=resolvePlacement({...model,advanced:{...model.advanced!,moeAcceleration:'automatic'}},{inspection:info,features:{status:'supported',flags:['--fit','--cpu-moe']},backendPath:'/old',availableMiB:23000,totalMiB:24576},999);assert(!fallback.args.includes('--moe-cache-mib'));assert(fallback.note);
const args=advancedPlacementArguments({mode:'gpu-layers',gpuLayerIds:[1,3]},info,features);const rules=args.filter((_,i)=>args[i-1]==='--override-tensor').flatMap(s=>s.split(','));const cpu=new RegExp(rules[0].replace(/=CPU$/,''));assert(cpu.test('blk.0.attn_q.weight'));assert(!cpu.test('blk.1.attn_q.weight'));assert(cpu.test('blk.4.ffn_up_exps.weight'));assert(cpu.test('blk.31.attn_q.weight'));assert(!cpu.test('blk.3.attn_q.weight'));
assert.throws(()=>advancedPlacementArguments({mode:'gpu-layers',gpuLayerIds:[48]},info,features));
assert.equal(normalizeAdvanced(undefined),undefined);assert.deepEqual(normalizeAdvanced({mode:'gpu-layers'}),{mode:'gpu-layers'});
assert.throws(()=>normalizeAdvanced({mode:'gpu-layers',gpuLayerIds:[-1]}));
const legacy={id:'legacy',maxContext:8192,speculative:'none' as const,vision:false,placement:{cpuMoeLayers:4,threads:8,threadsBatch:8,batchSize:512,ubatchSize:128,loadMode:'none' as const}};
assert.deepEqual(placementArguments({...legacy,advanced:{mode:'gpu-layers',inheritPlacement:true,moeAcceleration:'disabled'}}),placementArguments(legacy));
console.log('PASS placement ranges, exact tensor rules, joint hybrid KV/cache budget, fallback and legacy inheritance');

assert.equal(parseLlamaPlacement('I CPU_Mapped model buffer size = 288.00 MiB\nI CPU_Mapped model buffer size = 288.00 MiB')?.modelMiB.CPU_Mapped,576);

assert.equal('experimentalRuntimePath' in normalizeAdvanced({mode:'gpu-layers',experimentalRuntimePath:'/old/server',threads:8})!,false);

// Offline Qwen-like CPU experts, 16GiB GPU cache, 64K Q8 GPU KV.
const hostPreview={inspection:info,features,backendPath:'/bundled',availableMiB:23000,totalMiB:24576,availableRamMiB:56464150528/1024**2,totalRamMiB:67321835520/1024**2,modelCgroupMaxMiB:56320};
const mmapPlan=resolvePlacement(model,hostPreview,48,{contextWindow:65536,kvCacheType:'q8_0',kvOffload:true});
assert(mmapPlan.note.includes('mmap'));assert(mmapPlan.args.includes('16384'));assert(mmapPlan.args.includes('mmap'));assert(mmapPlan.args.includes('--no-repack'));
const host=estimateHostMemory(mmapPlan.estimate,mmapPlan.advanced,hostPreview.availableRamMiB,56320);
assert.equal(host.fileBackedWeightsMiB,mmapPlan.estimate.cpuWeightsMiB);
assert.equal(host.anonymousWeightsMiB,0);assert(host.fits);assert(!host.workingSetFits);
assert.equal(host.reserveMiB,7168);assert.equal(host.overheadMiB,2048);
assert.equal(host.requiredMiB,host.mandatoryMiB+7168);
assert.equal(host.cpuKvMiB,0);assert.equal(host.cgroupMaxMiB,56320);
// No GB/GiB confusion: the byte boundary is exact, not decimal GB interpreted as GiB.
assert.equal(hostPreview.availableRamMiB*1024**2,56464150528);
assert.equal(55.6e9/1024**3,51.781535148620605);
assert.equal(modelCgroupLimitMiB(hostPreview.totalRamMiB),56320);
assert.equal(modelCgroupLimitMiB(16384),9216);
// Anonymous loads must still fit in RAM, even if an identical mmap load can page.
const anon={...model,advanced:{...model.advanced!,loadMode:'none' as const}};
assert.throws(()=>resolvePlacement(anon,hostPreview,48,{contextWindow:65536,kvCacheType:'q8_0'}),/anonymous weights=.*GiB.*MemoryMax=/);
assert.throws(()=>resolvePlacement(model,{...hostPreview,availableRamMiB:8000},48),/required=.*file-backed mmap weights=/);
assert.throws(()=>resolvePlacement(model,{...hostPreview,modelCgroupMaxMiB:1024},48),/MemoryMax=1024/);
const largeKv={...mmapPlan.estimate,cpuKvMiB:60000};
assert(!estimateHostMemory(largeKv,model.advanced,hostPreview.availableRamMiB,56320).fits);
assert(!estimateHostMemory(mmapPlan.estimate,model.advanced,null,56320).fits);
// mmap with potential repacking must not be advertised as fully file-backed.
assert.equal(estimateHostMemory(mmapPlan.estimate,{mode:'gpu-layers',loadMode:'mmap'},hostPreview.availableRamMiB,56320).fileBackedWeightsMiB,0);
// Unload/retry always uses fresh available RAM, never cached rejection state.
assert.throws(()=>resolvePlacement(model,{...hostPreview,availableRamMiB:1000},48));
assert(resolvePlacement(model,hostPreview,48,{contextWindow:65536,kvCacheType:'q8_0'}).args.includes('16384'));
console.log('PASS host RAM: mmap vs anonymous, GPU cache/KV, GB/GiB, reserve, cgroup, unload/retry');

// The OS reserve is outside MemoryMax; do not subtract it a second time there.
assert(estimateHostMemory(mmapPlan.estimate,model.advanced,hostPreview.availableRamMiB,host.mandatoryMiB).fits);
assert(!estimateHostMemory(mmapPlan.estimate,model.advanced,hostPreview.availableRamMiB,host.mandatoryMiB-1).fits);
assert.equal(estimateHostMemory(mmapPlan.estimate,{...model.advanced!,loadMode:'auto'},hostPreview.availableRamMiB,56320).fileBackedWeightsMiB,0);
