import type { AdvancedModelParameters,ModelProfileDefaults } from './model-profiles';
import { isReasoningEffort } from './reasoning-controls';
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Model configuration must be an object');return value as Record<string,unknown>;};
export function normalizeAdvanced(value:unknown):AdvancedModelParameters|undefined {
 if(value===undefined)return undefined;const v=record(value),out:Record<string,unknown>={};
 const enums:Record<string,string[]>={mode:['automatic','gpu-layers','moe'],cpuMoe:['none','all','first'],flashAttention:['auto','on','off'],loadMode:['auto','mmap','none']};
 if(!enums.mode.includes(String(v.mode)))throw Error('Select automatic, gpu-layers or moe placement');
 for(const [key,choices] of Object.entries(enums))if(v[key]!==undefined){if(!choices.includes(String(v[key])))throw Error(`Invalid ${key}`);out[key]=v[key];}
 for(const [key,min,max] of [['cpuMoeLayers',0,1024],['cpuFfnLayers',0,1024],['threads',1,256],['threadsBatch',1,256],['batchSize',1,65536],['ubatchSize',1,65536],['fitTargetMiB',1024,65536]] as const){if(v[key]!==undefined){if(!Number.isInteger(v[key])||Number(v[key])<min||Number(v[key])>max)throw Error(`Invalid ${key}: ${min}..${max}`);out[key]=v[key];}}
 if(Number(out.ubatchSize??0)>Number(out.batchSize??65536))throw Error('Microbatch must not exceed batch size');
 if(out.cpuMoe==='first'&&out.cpuMoeLayers===undefined)throw Error('First-layer CPU MoE requires a layer count');
 if(v.tensorOverrides!==undefined){if(!Array.isArray(v.tensorOverrides)||v.tensorOverrides.length>16)throw Error('At most 16 tensor placement rules are supported');out.tensorOverrides=v.tensorOverrides.map(raw=>{const r=record(raw);if(typeof r.pattern!=='string'||!r.pattern||r.pattern.length>256||[...r.pattern].some(c=>c.charCodeAt(0)<32||c==='='||c===',')||typeof r.buffer!=='string'||!/^(CPU|CUDA[0-9]{1,2})$/.test(r.buffer))throw Error('Tensor rules require a bounded pattern and CPU or CUDA device buffer');try{new RegExp(r.pattern);}catch{throw Error('Invalid tensor pattern');}return {pattern:r.pattern,buffer:r.buffer};});}
 return out as unknown as AdvancedModelParameters;
}
export function normalizeModelDefaults(value:unknown):ModelProfileDefaults|undefined {
 if(value===undefined)return undefined;const v=record(value),out:ModelProfileDefaults={};
 if(v.thinkingEnabled!==undefined){if(v.thinkingEnabled!==null&&typeof v.thinkingEnabled!=='boolean')throw Error('Invalid Thinking setting');out.thinkingEnabled=v.thinkingEnabled as boolean|null;}
 if(v.reasoningEffort!==undefined){if(v.reasoningEffort!==null&&!isReasoningEffort(v.reasoningEffort))throw Error('Invalid reasoning effort');out.reasoningEffort=v.reasoningEffort as ModelProfileDefaults['reasoningEffort'];}
 if(v.contextWindow!==undefined){if(!Number.isSafeInteger(v.contextWindow)||Number(v.contextWindow)<4096||Number(v.contextWindow)%4096)throw Error('Context must be a multiple of 4096');out.contextWindow=Number(v.contextWindow);}
 if(v.kvCacheType!==undefined){if(v.kvCacheType!=='f16'&&v.kvCacheType!=='q8_0')throw Error('Unsupported KV precision');out.kvCacheType=v.kvCacheType;}
 if(v.kvOffload!==undefined){if(typeof v.kvOffload!=='boolean')throw Error('Invalid KV placement');out.kvOffload=v.kvOffload;}
 return out;
}
