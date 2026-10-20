import type {ModelInspection} from './model-profiles';
import type {RuntimeModelConfiguration} from './types';
export interface AuthorConfiguration {id:string;name:string;gpuLayers:number|null;weights:string;context:string;kv:string;status:'author-tested'|'experimental'|'unknown';contextWindow?:number;kvCacheType?:'q8_0'|'f16';noteRu:string;noteEn:string;}
export const authorConfigurations:AuthorConfiguration[]=[
 {id:'qwen38',name:'Qwen3.8-27B Q4',gpuLayers:999,weights:'Q4',context:'~64K / ~108K',kv:'FP16 / FP8 (historical)',status:'author-tested',noteRu:'999 — запрос максимального offload, без гарантии размещения.',noteEn:'999 requests maximum offload; placement is not guaranteed.'},
 {id:'qwen36',name:'Qwen3.6-35B-A3B Q4',gpuLayers:999,weights:'Q4',context:'~75K',kv:'Q8',status:'author-tested',noteRu:'Название текущего каталога; не создаёт отдельный Qwen3.5 профиль.',noteEn:'Current catalog name; does not create a separate Qwen3.5 profile.'},
 {id:'gpt20',name:'GPT-OSS-20B MXFP4',gpuLayers:999,weights:'MXFP4',context:'128K / 131 072 (architecture maximum)',kv:'FP16',contextWindow:131072,kvCacheType:'f16',status:'author-tested',noteRu:'128K — архитектурный максимум модели, не результат загрузки или benchmark на текущем оборудовании. FP16 относится к KV-cache, не к весам.',noteEn:'128K is the model architecture maximum, not a successful load or benchmark on this hardware. FP16 describes the KV cache, not the weights.'},
 {id:'glm',name:'GLM-4.7-Flash Q4',gpuLayers:999,weights:'Q4',context:'~64K',kv:'—',status:'author-tested',noteRu:'Тип KV не записан.',noteEn:'KV type was not recorded.'},
 {id:'gemma',name:'Gemma 4 31B',gpuLayers:999,weights:'Q4',context:'~64K',kv:'FP16',status:'author-tested',noteRu:'Квантование весов Q4; применимость зависит от точной GGUF и контекста.',noteEn:'Q4 weight quantization; applicability depends on the exact GGUF and context.'},
 {id:'devstral',name:'Devstral Small 2 24B Q4',gpuLayers:999,weights:'Q4',context:'~56K',kv:'FP16',status:'author-tested',noteRu:'Исторический Chat не подтверждает надёжность Agent.',noteEn:'Historical Chat use does not establish Agent reliability.'},
 {id:'coder80',name:'Qwen3-Coder-Next 80B MoE',gpuLayers:48,weights:'Q4',context:'64K / 65 536',kv:'Q8 (K/V q8_0)',contextWindow:65536,kvCacheType:'q8_0',status:'author-tested',noteRu:'Подтверждён smoke test через runtime controller и launcher приложения: 48 GPU layers вместе с 32 CPU MoE layers, Flash Attention On; OOM устранён; MTP Off и On проверены, On использовал внешний проверенный MTP-only GGUF. Не полноценный benchmark; полная загрузка кнопкой Load в Electron отдельно не проверялась. 48 слоёв без 32 CPU MoE не подтверждены как рабочая конфигурация.',noteEn:'Smoke-tested through the application runtime controller and launcher: 48 GPU layers together with 32 CPU MoE layers, Flash Attention On; OOM resolved; MTP Off and On tested, with On using the verified external MTP-only GGUF. Not a full benchmark; loading with the Electron Load button was not separately tested. 48 layers without 32 CPU MoE are not confirmed as a working configuration.'},
 {id:'gpt120',name:'GPT-OSS-120B Q4_K_M',gpuLayers:12,weights:'Q4_K_M (2-part GGUF)',context:'32K (one successful run)',kv:'Q8',contextWindow:32768,kvCacheType:'q8_0',status:'author-tested',noteRu:'12 — загрузка подтверждена; 13 — экспериментально; 14 — CUDA OOM. Около 11 ток/с, не benchmark.',noteEn:'12 loaded; 13 experimental; 14 caused CUDA OOM. About 11 tok/s, not a benchmark.'},
];
/** Metadata, shape and quantization gate applicability; filenames never select a preset. */
export function compatibleAuthorConfiguration(row:AuthorConfiguration,m:ModelInspection|undefined,profileId=''):boolean{
 if(!m||m.status!=='inspected'||row.gpuLayers===null)return false;
 const q4=m.fileType===15||m.fileType===14;
 if(row.id==='gpt120')return m.architecture==='gpt-oss'&&m.fileType===15&&m.layers===36&&m.experts===128;
 if(row.id==='gpt20')return m.architecture==='gpt-oss'&&m.fileType===38&&m.layers===24&&m.experts===32;
 if(row.id==='qwen38')return m.architecture==='qwen35'&&q4&&(profileId==='qwen3.8:27b-q4_K_M'||profileId==='huihui-qwen3.8:27b-ud-dw-q4_k_m'||/^27B$/i.test(m.sizeLabel??''));
 if(row.id==='qwen36')return m.architecture==='qwen35moe'&&q4&&(profileId==='qwen3.6:35b-a3b-ud-q4_k_m'||/^35B/i.test(m.sizeLabel??''));
 if(row.id==='glm')return /^glm/i.test(m.architecture??'')&&q4&&/4\.7.*flash/i.test(m.modelName??'');
 if(row.id==='gemma')return /^gemma4/i.test(m.architecture??'')&&(/^31B$/i.test(m.sizeLabel??'')||/31b/i.test(m.modelName??''));
 if(row.id==='devstral')return ['llama','mistral'].includes(m.architecture??'')&&q4&&/devstral.*small.*2/i.test(m.modelName??'')&&(/^24B$/i.test(m.sizeLabel??'')||/24b/i.test(m.modelName??''));
 if(row.id==='coder80')return m.architecture==='qwen3next'&&q4&&m.layers===48&&m.experts===512&&m.activeExperts===10;
 return false;
}

/** Build a draft-only patch. Unknown observation values intentionally leave profile fields untouched. */
export function authorConfigurationPatch(row:AuthorConfiguration,profile:RuntimeModelConfiguration,inspection:ModelInspection|undefined):Partial<RuntimeModelConfiguration>|undefined{
 if(!compatibleAuthorConfiguration(row,inspection,profile.id))return undefined;
 return {
  ...(row.gpuLayers!==null?{gpuLayers:row.gpuLayers}:{}),
  ...(profile.advanced?.mode==='automatic'?{advanced:{...profile.advanced,mode:'gpu-layers' as const}}:{}),
  ...(row.contextWindow||row.kvCacheType?{defaults:{...profile.defaults,...(row.contextWindow?{contextWindow:row.contextWindow}:{}),...(row.kvCacheType?{kvCacheType:row.kvCacheType}:{})}}:{}),
 };
}
