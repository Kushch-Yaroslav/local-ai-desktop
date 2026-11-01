import {readFile} from 'node:fs/promises';
import {inspectModel} from '../models/gguf-profile';
import {probeBackendFeatures} from './backend-capabilities';
import {getHardwareStats,getOwnedServerVramBudget} from './hardware';
import type {RuntimeModelConfiguration} from '../../shared/types';
import type {AdvancedModelParameters,ModelProfileDefaults,PlacementPreview} from '../../shared/model-profiles';
import {estimateModelMemory,experimentalPlacement,placementSupport,profileRuntimePath,verifiedMoe} from '../../shared/model-memory';
import {advancedPlacementArguments} from '../models/advanced-placement';
export async function placementPreview(model:RuntimeModelConfiguration,standard:string|null,ownedPid?:number):Promise<PlacementPreview>{
 const path=profileRuntimePath(model.advanced,standard),inspection=inspectModel(model.modelPath,model.family),features=await probeBackendFeatures(path),hardware=await getHardwareStats();
 let available=hardware.vramAvailableBytes,ram=hardware.ramTotalBytes-hardware.ramUsedBytes;
 if(ownedPid&&ownedPid>0){try{const owned=await getOwnedServerVramBudget(ownedPid);available=owned.freeBytes+owned.llmBytes;const status=await readFile(`/proc/${ownedPid}/status`,'utf8');ram+=Number(/^RssAnon:\s+(\d+)/m.exec(status)?.[1]??0)*1024;}catch{/* No reclaim credit without owned-process accounting. */}}
 return {inspection,features,backendPath:path,availableMiB:available===null?null:available/1024**2,totalMiB:hardware.vramTotalBytes===null?null:hardware.vramTotalBytes/1024**2,availableRamMiB:ram/1024**2};
}
export function resolvePlacement(model:RuntimeModelConfiguration,preview:PlacementPreview,gpuLayers:number,defaults:ModelProfileDefaults=model.defaults??{}){
 const original=model.advanced;let p:AdvancedModelParameters|undefined=original?{...original}:undefined,note='';
 if(p?.moeAcceleration==='automatic'&&(!verifiedMoe(preview.inspection)||!preview.features.flags.includes('--moe-cache-mib')||!preview.features.buffers?.includes('CUDA0')||!preview.features.version?.includes('5047748')||gpuLayers===0)){
  p={...p,moeAcceleration:'disabled'};note='Автоматическое ускорение недоступно для этой модели/backend: используется стандартный режим.';
 }
 if(p?.gpuLayerIds!==undefined&&!placementSupport(preview.inspection,preview.features))throw Error('Manual placement requires complete GGUF tensor metadata and a CUDA backend advertising --override-tensor.');
 const estimate=estimateModelMemory(preview.inspection,p,gpuLayers,defaults,preview.availableMiB,preview.totalMiB);
 if(p?.moeAcceleration&&p.moeAcceleration!=='disabled'){
  if(!verifiedMoe(preview.inspection))throw Error('Experimental expert cache is validated only for Qwen3-Coder-Next48 Q4_K_M with512experts.');
  if(gpuLayers===0)throw Error('Expert cache requires GPU-assigned layers; choose GPU layers or Standard mode.');
  if((defaults.contextWindow??32768)>65536)throw Error('Expert cache above64K context has not been validated.');
  if(p.moeAcceleration==='automatic'&&estimate.cacheMiB<2048){p={...p,moeAcceleration:'disabled'};note='Недостаточно безопасной VRAM для ускорения: стандартный режим.';}
  else p={...p,expertCacheMiB:estimate.cacheMiB};
 }
 const effective=estimateModelMemory(preview.inspection,p,gpuLayers,defaults,preview.availableMiB,preview.totalMiB);
 if(experimentalPlacement(p)||(experimentalPlacement(original)&&effective.known&&preview.availableMiB!==null&&!effective.fits)){
  if(model.mmprojPath)throw Error('Experimental placement memory budgeting does not yet include vision projectors; remove the projector or use Standard.');
  if(!effective.known||preview.availableMiB===null)throw Error('GPU telemetry or tensor metadata unavailable; safe memory budget cannot be checked.');
  if(!effective.fits)throw Error('Выбранные настройки могут превысить доступную видеопамять. Уменьшите кэш экспертов или количество слоёв на GPU.');
  if(preview.availableRamMiB!==undefined&&effective.cpuWeightsMiB+effective.cpuKvMiB+9216>preview.availableRamMiB)throw Error('CPU weights and runtime reserve exceed available RAM. Unload the active model or reduce CPU placement.');
 }
 const args=p?advancedPlacementArguments(p,preview.inspection,preview.features):[];
 return {advanced:p,estimate:effective,args,note,backendPath:preview.backendPath};
}
