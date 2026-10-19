import type { ReasoningCapability, ReasoningEffort } from './reasoning-controls';
export const modelFamilies=['auto','qwen','gpt-oss','gemma','glm','mistral','llama','custom'] as const;
export type ModelFamily=typeof modelFamilies[number];
export interface ModelInspection {
  status:'inspected'|'unknown'|'error'; detectedFamily:ModelFamily; selectedFamily:ModelFamily; effectiveFamily:ModelFamily;
  modelName?:string; architecture?:string; template:'harmony'|'jinja'|'unknown'; quantization?:string; fileType?:number; trainedContext?:number;
  layers?:number; experts?:number; activeExperts?:number; sizeLabel?:string; reasoning:ReasoningCapability; toolTemplate:boolean; reason?:string;
}
export interface AdvancedModelParameters {
  mode:'automatic'|'gpu-layers'|'moe'; cpuMoe?:'none'|'all'|'first'; cpuMoeLayers?:number; cpuFfnLayers?:number;
  threads?:number; threadsBatch?:number; batchSize?:number; ubatchSize?:number; flashAttention?:'auto'|'on'|'off';
  loadMode?:'auto'|'mmap'|'none'; fitTargetMiB?:number; tensorOverrides?:Array<{pattern:string;buffer:string}>;
}
export interface ModelProfileDefaults {thinkingEnabled?:boolean|null;reasoningEffort?:ReasoningEffort|null;contextWindow?:number;kvCacheType?:'f16'|'q8_0';kvOffload?:boolean;}
export interface BackendFeatureProbe {status:'supported'|'error';path?:string;flags:string[];reason?:string;}
