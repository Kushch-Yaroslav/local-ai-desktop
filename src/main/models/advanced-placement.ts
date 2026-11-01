import {normalizeAdvanced} from '../../shared/model-configuration';
import type {AdvancedModelParameters,BackendFeatureProbe,ModelInspection} from '../../shared/model-profiles';
import {validateBackendArguments} from '../services/backend-capabilities';
export function advancedPlacementArguments(value:AdvancedModelParameters,inspection?:ModelInspection,backend?:BackendFeatureProbe):string[]{
 const p=normalizeAdvanced(value)!;const cache=Boolean(p.moeAcceleration&&p.moeAcceleration!=='disabled');const bounded=cache||p.gpuLayerIds!==undefined;if(bounded&&((p.batchSize??512)>512||(p.ubatchSize??128)>128))throw Error('Experimental placement supports batch up to512 and microbatch up to128');const args:string[]=[];const tensorRules:string[]=[];
 const option=(flag:string,value?:string|number)=>{if(value!==undefined){if(flag==='--override-tensor')tensorRules.push(String(value));else args.push(flag,String(value));}};
 if(p.mode==='automatic'&&p.gpuLayerIds===undefined&&!cache){option('--fit','on');option('--fit-target',p.fitTargetMiB??1536);}else option('--fit','off');
 if(inspection?.layers&&[p.cpuMoeLayers,p.cpuFfnLayers].some(n=>n!==undefined&&n>inspection.layers!))throw Error('CPU layer count exceeds the GGUF block count');
 if(p.gpuLayerIds!==undefined){if(p.cpuFfnLayers!==undefined)throw Error('Manual block selection cannot combine first-N dense FFN rules; clear the FFN override first.');if(!inspection?.layers||p.gpuLayerIds.some(n=>n>=inspection.layers!))throw Error('Selected layer IDs exceed the inspected GGUF structure');if(p.tensorOverrides?.length)throw Error('Manual layers cannot be combined with arbitrary tensor overrides');const selected=new Set(p.gpuLayerIds),cpu=Array.from({length:inspection.layers},(_,n)=>n).filter(n=>!selected.has(n));if(cpu.length)option('--override-tensor',`^blk[.](?:${cpu.join('|')})[.]=CPU`);if(selected.size)option('--override-tensor',`^blk[.](?:${[...selected].join('|')})[.]${cache||p.cpuMoe&&p.cpuMoe!=='none'?'(?!ffn_(?:gate|up|down|gate_up)_exps[.])':''}=CUDA0`);option('--override-tensor','^(?!blk[.]).*=CPU');}
 if(p.gpuLayerIds!==undefined&&!cache)args.push('--no-host','--no-repack','--lazy-mode','off');
 if(cache){if(!inspection?.experts||inspection.experts<2)throw Error('GPU expert cache requires inspected MoE weights');if(p.tensorOverrides?.length)throw Error('Expert cache cannot use arbitrary tensor overrides');if(!p.expertCacheMiB)throw Error('Cache budget has not been resolved');if((p.ubatchSize??128)>128||(p.batchSize??512)>512)throw Error('Experimental cache supports batch up to512 and microbatch up to128; larger compute budgets are unverified');args.push('--cpu-moe','--moe-cache-mib',String(p.expertCacheMiB),'--no-host','--no-repack','--lazy-mode','off');}
 if(!cache&&p.cpuMoe&&p.cpuMoe!=='none'&&!(Number(inspection?.experts)>1))throw Error('The GGUF does not confirm MoE expert weights; CPU MoE placement is unavailable.');
 // CPU MoE expert placement is independent from the Automatic/GPU-layer fit policy.
 if(!cache&&p.cpuMoe&&p.cpuMoe!=='none'&&p.loadMode==='dio'&&backend?.flags.includes('--no-host'))args.push('--no-host');
 if(!cache&&p.cpuMoe==='all')args.push('--cpu-moe');else if(!cache&&p.cpuMoe==='first')option('--n-cpu-moe',p.cpuMoeLayers);
 if(p.cpuFfnLayers!==undefined){if(Number(inspection?.experts)>1)throw Error('Dense FFN placement is not MoE expert placement; use CPU MoE controls.');option('--n-cpu-ffn',p.cpuFfnLayers);}
 option('--threads',p.threads??(cache?8:undefined));option('--threads-batch',p.threadsBatch??(cache?8:undefined));option('--batch-size',p.batchSize??(bounded?512:undefined));option('--ubatch-size',p.ubatchSize??(bounded?128:undefined));option('--flash-attn',p.flashAttention);
 if(cache&&p.loadMode===undefined)p.loadMode='mmap';
 if(p.loadMode!==undefined){if(!backend||backend.flags.includes('--load-mode'))option('--load-mode',p.loadMode);else if(p.loadMode!=='auto'){if(!['mmap','none'].includes(p.loadMode))throw Error('This backend does not advertise --load-mode; the requested mapping/locking mode cannot be represented safely.');args.push(p.loadMode==='mmap'?'--mmap':'--no-mmap');}}
 for(const rule of p.tensorOverrides??[])option('--override-tensor',`${rule.pattern}=${rule.buffer}`);
 if(tensorRules.length)args.push('--override-tensor',tensorRules.join(','));if(backend)validateBackendArguments(args,backend);return args;
}
