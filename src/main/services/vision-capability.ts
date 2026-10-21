import type { RuntimeModelConfiguration } from '../../shared/types';
import type { BackendFeatureProbe } from '../../shared/model-profiles';
import type { VisionCapability } from '../../shared/model-features';
import { readGgufSpeculativeMetadata } from './gguf-speculative';
import { ggufFileAvailability } from './gguf-artifacts';

/** Offline inspection is deliberately conservative; a live multimodal declaration confirms initialization. */
export function visionCapability(model: RuntimeModelConfiguration, backend: BackendFeatureProbe, live?: { multimodal: boolean; error?: string }): VisionCapability {
 const result = (state:VisionCapability['state'],reason:string,detected=false,source?:VisionCapability['source']):VisionCapability => ({state,reason,detected,source,backendVerified:false,active:false});
 // Actual initialized capability is authoritative, including embedded implementations without a projector path.
 if(live?.multimodal)return {state:'supported',source:model.mmprojPath?'projector':'embedded',reason:'The active backend advertises multimodal image input.',detected:true,backendVerified:true,active:true};
 let target:ReturnType<typeof readGgufSpeculativeMetadata>;
 try{target=readGgufSpeculativeMetadata(model.modelPath);}catch(error){return result('unknown',`Cannot inspect model metadata: ${String(error)}`);}
 const architecture=String(target.values['general.architecture']??'');
 const embedded=Object.keys(target.tensors??{}).some(key=>/^(?:v\.|vision\.)/.test(key))&&Object.keys(target.tensors??{}).some(key=>/^mm\./.test(key));
 if(!model.mmprojPath){
  if(embedded)return result('unknown','Embedded visual tensors detected; this backend path requires initialization evidence.',true,'embedded');
  if(['gpt-oss','qwen3next'].includes(architecture))return result('unsupported','This GGUF has no confirmed visual encoder; the inspected architecture uses text input.');
  if(/qwen.*vl|qwen35|gemma3|gemma4|mllama|pixtral/.test(architecture))return result('misconfigured','A compatible image projector is required but its path is empty.');
  return result('unknown','No visual encoder or compatible projector is confirmed by the available metadata.');
 }
 const file=ggufFileAvailability(model.mmprojPath);
 if(file.status!=='ready')return result('misconfigured',`Projector unavailable: ${file.issue}`);
 let projector:ReturnType<typeof readGgufSpeculativeMetadata>;
 try{projector=readGgufSpeculativeMetadata(model.mmprojPath);}catch(error){return result('misconfigured',`Cannot inspect projector: ${String(error)}`);}
 const type=String(projector.values['clip.projector_type']??''),tensors=projector.tensors??{};
 if(projector.values['general.architecture']!=='clip'||projector.values['clip.has_vision_encoder']!==true)return result('misconfigured','The selected GGUF does not declare a CLIP image encoder.');
 const families:Record<string,RegExp>={qwen2vl:/^qwen2vl$/,qwen2_5_vl:/^qwen2vl$/,qwen3vl:/^qwen3vl$/,qwen3vl_merger:/^qwen35(?:moe)?$/,gemma3:/^gemma3/,gemma4:/^gemma4/,mllama:/^mllama/,pixtral:/^(?:llama|mistral)/};
 if(families[type]&&!families[type].test(architecture))return result('misconfigured','Projector type is incompatible with the target GGUF architecture.');
 // Shapes follow the pinned mtmd clip_n_mmproj_embd() path; other layouts stay Unknown.
 const output=type==='qwen3vl_merger'?tensors['mm.2.weight']?.[1]:/^qwen/.test(type)?tensors['mm.1.bias']?.[0]:['mlp','pixtral'].includes(type)?tensors['mm.2.weight']?.[1]:undefined;
 const embedding=Number(target.values[`${architecture}.embedding_length`]);
 if(output&&embedding&&output!==embedding)return result('misconfigured','Projector output dimension differs from the model embedding dimension.');
 if(!families[type]||!output||!embedding)return result('unknown','Projector metadata exists, but its pairing/layout cannot be confirmed offline.',false,'projector');
 if(backend.status!=='supported')return result('backend-unavailable',backend.reason??'Backend CLI capabilities unavailable.',true,'projector');
 if(!backend.flags.includes('--mmproj'))return result('unsupported','The configured backend does not advertise --mmproj.',true,'projector');
 if(live?.error)return result('backend-unavailable',live.error,true,'projector');
 if(live&&!live.multimodal)return result('initialization-failed',live.error??'The active backend did not initialize multimodal image input.',true,'projector');
 return result('supported','Compatible projector architecture and dimensions detected; activation requires successful backend initialization.',true,'projector');
}
