import {normalizeAdvanced} from '../../shared/model-configuration';
import type {AdvancedModelParameters,BackendFeatureProbe,ModelInspection} from '../../shared/model-profiles';
import {validateBackendArguments} from '../services/backend-capabilities';
export function advancedPlacementArguments(value:AdvancedModelParameters,inspection?:ModelInspection,backend?:BackendFeatureProbe):string[]{
 const p=normalizeAdvanced(value)!;const args:string[]=[];
 const option=(flag:string,value?:string|number)=>{if(value!==undefined)args.push(flag,String(value));};
 if(p.mode==='automatic'){option('--fit','on');option('--fit-target',p.fitTargetMiB??1536);}else option('--fit','off');
 if(inspection?.layers&&[p.cpuMoeLayers,p.cpuFfnLayers].some(n=>n!==undefined&&n>inspection.layers!))throw Error('CPU layer count exceeds the GGUF block count');
 if(p.mode==='moe'){
  if(!(Number(inspection?.experts)>1))throw Error('The GGUF does not confirm a MoE architecture');
  if(p.cpuMoe&&p.cpuMoe!=='none'&&!(Number(inspection?.experts)>1))throw Error('The GGUF does not confirm MoE expert weights; CPU MoE placement is unavailable.');
  if(p.cpuMoe==='all')args.push('--cpu-moe');else if(p.cpuMoe==='first')option('--n-cpu-moe',p.cpuMoeLayers);
 }
 if(p.cpuFfnLayers!==undefined){if(Number(inspection?.experts)>1)throw Error('Dense FFN placement is not MoE expert placement; use CPU MoE controls.');option('--n-cpu-ffn',p.cpuFfnLayers);}
 option('--threads',p.threads);option('--threads-batch',p.threadsBatch);option('--batch-size',p.batchSize);option('--ubatch-size',p.ubatchSize);option('--flash-attn',p.flashAttention);
 if(p.loadMode!==undefined){if(!backend||backend.flags.includes('--load-mode'))option('--load-mode',p.loadMode);else if(p.loadMode!=='auto'){if(!['mmap','none'].includes(p.loadMode))throw Error('This backend does not advertise --load-mode; the requested mapping/locking mode cannot be represented safely.');args.push(p.loadMode==='mmap'?'--mmap':'--no-mmap');}}
 for(const rule of p.tensorOverrides??[])option('--override-tensor',`${rule.pattern}=${rule.buffer}`);
 if(backend)validateBackendArguments(args,backend);return args;
}
