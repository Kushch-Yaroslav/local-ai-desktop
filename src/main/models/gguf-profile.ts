import type { ModelFamily, ModelInspection } from '../../shared/model-profiles';
import { readGgufSpeculativeMetadata, type GgufSpeculativeMetadata } from '../services/gguf-speculative';
const quantizations:Record<number,string>={0:'F32',1:'F16',2:'Q4_0',3:'Q4_1',7:'Q8_0',14:'Q4_K_S',15:'Q4_K_M',16:'Q5_K_S',17:'Q5_K_M',18:'Q6_K',32:'BF16',38:'MXFP4'};
/** Family is descriptive. Only the inspected template grants request controls. */
export function inspectMetadata(metadata:GgufSpeculativeMetadata,selectedFamily:ModelFamily='auto'):ModelInspection {
 const v=metadata.values,a=String(v['general.architecture']??''),template=String(v['tokenizer.chat_template']??'');
 let detectedFamily:ModelFamily=/^qwen/i.test(a)?'qwen':/^gpt[-_]?oss/i.test(a)?'gpt-oss':/^gemma/i.test(a)?'gemma':/^glm/i.test(a)?'glm':/^mistral|devstral/i.test(a)?'mistral':a==='llama'?'llama':'custom';
 const harmony=template.includes('<|start|>')&&template.includes('<|message|>');
 if(detectedFamily==='custom'){if(harmony)detectedFamily='gpt-oss';else if(template.includes('enable_thinking')&&/qwen/i.test(String(v['general.name']??'')))detectedFamily='qwen';}
 // Mistral/Devstral use llama architecture in some conversions; the template is the stronger family clue here.
 if(detectedFamily==='llama'&&template.includes('[INST]')&&/mistral|devstral/i.test(String(v['general.name']??'')))detectedFamily='mistral';
 const thinkingToggle=/\benable_thinking\b/.test(template)&&/{%-?\s*(?:if|set)[\s\S]{0,160}\benable_thinking\b/.test(template);
 const supportsEffort=/{[{%]-?[^{}]{0,240}\breasoning_effort\b/.test(template);
 const declared=[...template.matchAll(/\b(?:resolved_)?reasoning_effort\s+(?:not\s+)?in\s*[[(]([^\])]+)[\])]/g)].flatMap(match=>[...match[1].matchAll(/['"](low|medium|high|xhigh)['"]/g)].map(value=>value[1]));
 const efforts:ModelInspection['reasoning']['efforts']=!supportsEffort?[]:harmony?['low','medium','high']:detectedFamily==='qwen'?['low','medium',...(template.includes('xhigh')?['max' as const]:[])]:(['low','medium','high','max'] as const).filter(value=>declared.includes(value==='max'?'xhigh':value));
 const positive=(key:string)=>{const n=Number(v[key]);return Number.isSafeInteger(n)&&n>0?n:undefined;};
 const fileType=typeof v['general.file_type']==='number'?v['general.file_type']:undefined;
 return {status:'inspected',detectedFamily,selectedFamily,effectiveFamily:selectedFamily==='auto'?detectedFamily:selectedFamily,architecture:a,modelName:typeof v['general.name']==='string'?v['general.name']:undefined,template:harmony?'harmony':template?'jinja':'unknown',fileType,quantization:fileType===undefined?undefined:quantizations[fileType]??`GGUF type ${fileType}`,trainedContext:positive(`${a}.context_length`),layers:positive(`${a}.block_count`),experts:positive(`${a}.expert_count`),activeExperts:positive(`${a}.expert_used_count`),sizeLabel:typeof v['general.size_label']==='string'?v['general.size_label']:undefined,reasoning:{thinkingToggle,efforts},toolTemplate:/\btools\b/.test(template),...(selectedFamily!=='auto'&&selectedFamily!==detectedFamily?{reason:'Manual family override changes classification; technical capabilities still come from the GGUF/template and backend.'}:{})};
}
export function inspectModel(path:string,family:ModelFamily='auto'):ModelInspection {
 try{return inspectMetadata(readGgufSpeculativeMetadata(path),family);}catch(error){return {status:'error',detectedFamily:'custom',selectedFamily:family,effectiveFamily:family==='auto'?'custom':family,template:'unknown',reasoning:{thinkingToggle:false,efforts:[]},toolTemplate:false,reason:error instanceof Error?error.message:String(error)};}
}
