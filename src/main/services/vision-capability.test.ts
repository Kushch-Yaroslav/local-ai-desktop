import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {visionCapability} from './vision-capability';
import {visionPreference,mtpPreference,permitsImages,withoutImagePayloads} from '../../shared/model-features';
import type {RuntimeModelConfiguration} from '../../shared/types';
const root=mkdtempSync(join(tmpdir(),'lad-vision-capability-'));
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},str=(s:string)=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
function gguf(name:string,fields:Record<string,string|number|boolean>,tensors:Array<[string,number[]]>=[]){
 let offset=0;const headers=tensors.flatMap(([key,shape])=>{const current=offset;offset+=shape.reduce((a,b)=>a*b,1)*4;return [str(key),u32(shape.length),...shape.map(u64),u32(0),u64(current)];});
 const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(tensors.length),u64(Object.keys(fields).length),...Object.entries(fields).flatMap(([k,v])=>[str(k),u32(typeof v==='string'?8:typeof v==='boolean'?7:4),typeof v==='string'?str(v):typeof v==='boolean'?Buffer.from([Number(v)]):u32(v)]),...headers]);
 const path=join(root,name);writeFileSync(path,Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(offset)]));return path;
}
try{
 const base:RuntimeModelConfiguration={id:'fixture',displayName:'Fixture',modelPath:gguf('text.gguf',{'general.architecture':'gpt-oss'}),mmprojPath:'',gpuLayers:0,supportsTools:true,speculative:'none',builtin:false};
 const backend={status:'supported' as const,flags:['--mmproj']};
 assert.equal(visionCapability(base,backend).state,'unsupported');
 const target={...base,modelPath:gguf('target.gguf',{'general.architecture':'qwen35','qwen35.embedding_length':4})};
 assert.equal(visionCapability(target,backend).state,'misconfigured');
 const projector=gguf('projector.gguf',{'general.architecture':'clip','clip.has_vision_encoder':true,'clip.projector_type':'qwen3vl_merger'},[['mm.2.weight',[4,4]]]);
 const paired={...target,mmprojPath:projector};const detected=visionCapability(paired,backend);
 assert.equal(detected.state,'supported');assert(!detected.active);assert(!detected.backendVerified);
 assert.equal(visionCapability({...base,mmprojPath:projector},backend).state,'misconfigured');
 assert.equal(visionCapability({...target,mmprojPath:target.modelPath},backend).state,'misconfigured');
 assert.equal(visionCapability(paired,{status:'error',flags:[],reason:'offline'}).state,'backend-unavailable');
 assert.equal(visionCapability(paired,{status:'supported',flags:[]}).state,'unsupported');
 assert.equal(visionCapability(paired,backend,{multimodal:false}).state,'initialization-failed');
 assert.equal(visionCapability(paired,backend,{multimodal:false,error:'connection refused'}).state,'backend-unavailable');
 const active=visionCapability(paired,backend,{multimodal:true});assert(active.active&&active.backendVerified);
 assert(!permitsImages('off',active,true));assert(permitsImages('auto',active,true));assert(!permitsImages('auto',active,false));assert(!permitsImages('on',detected,true));
 const embedded={...base,modelPath:gguf('embedded.gguf',{'general.architecture':'custom'},[['v.encoder.weight',[4]],['mm.proj.weight',[4,4]]])};
 assert.equal(visionCapability(embedded,backend).state,'unknown');assert.equal(visionCapability(embedded,backend,{multimodal:true}).source,'embedded');
 renameSync(projector,projector+'.offline');assert.equal(visionCapability(paired,backend).state,'misconfigured');renameSync(projector+'.offline',projector);assert.equal(visionCapability(paired,backend).state,'supported');
 const imageMessage={id:'image-turn',conversationId:'a',role:'user' as const,content:'image',createdAt:'now',images:['data:image/png;base64,AAAA']};
 assert.equal(withoutImagePayloads([imageMessage])[0].images,undefined);assert.equal(imageMessage.images.length,1,'routing cannot mutate stored history');
 assert.equal(visionPreference(undefined,{browserVision:'on'}),'on');assert.equal(visionPreference({visionMode:'off'},{browserVision:'on'}),'off');assert.equal(visionPreference({visionMode:'auto'},{browserVision:'off'}),'auto');
 assert.equal(mtpPreference({mtpMode:'off'},{...base,mtpMode:'on'}),'off');assert.equal(mtpPreference(undefined,{...base,mtpMode:'on'}),'on');
 console.log('PASS Vision detection, projector pairing/layout, embedded runtime proof, unknown/offline/init failure, preference inheritance and image policy');
}finally{rmSync(root,{recursive:true,force:true});}
