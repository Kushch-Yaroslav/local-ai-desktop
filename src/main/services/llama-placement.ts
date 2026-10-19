import {open} from 'node:fs/promises';
export interface LlamaPlacementReport {offloadedLayers?:number;reportedLayers?:number;modelMiB:Record<string,number>;kvMiB:Record<string,number>;computeMiB:Record<string,number>;source:'owned-server-log';observedAt:string;}
export function parseLlamaPlacement(log:string):LlamaPlacementReport|undefined{
 const result:LlamaPlacementReport={modelMiB:{},kvMiB:{},computeMiB:{},source:'owned-server-log',observedAt:new Date().toISOString()};
 for(const line of new Set(log.split('\n'))){
  const offload=/load_tensors: offloaded (\d+)\/(\d+) layers to GPU/.exec(line);if(offload){result.offloadedLayers=Number(offload[1]);result.reportedLayers=Number(offload[2]);}
  const buffer=/\b(CUDA\d+|CPU_Mapped|CPU|CUDA_Host)\s+(model|KV|compute) buffer size\s*=\s*([\d.]+) MiB/.exec(line);if(!buffer)continue;
  const target=buffer[2]==='model'?result.modelMiB:buffer[2]==='KV'?result.kvMiB:result.computeMiB;
  const n=Number(buffer[3]);if(Number.isFinite(n)&&n>=0)target[buffer[1]]=(target[buffer[1]]??0)+n;
 }
 return Object.keys(result.modelMiB).length||result.offloadedLayers!==undefined?result:undefined;
}
const cache=new Map<string,LlamaPlacementReport>();
/** Bounded read, keyed by the owned live PID/start time; this is allocation evidence, not total/peak VRAM. */
export async function ownedPlacementReport(path:string,pid:number,startTime:string):Promise<LlamaPlacementReport|undefined>{
 const key=`${path}:${pid}:${startTime}`,old=cache.get(key);if(old)return old;
 let file;try{file=await open(path,'r');const {size}=await file.stat(),limit=1024*1024;const first=Buffer.alloc(Math.min(size,limit));await file.read(first,0,first.length,0);let log=first.toString('utf8');if(size>limit){const tail=Buffer.alloc(Math.min(size-limit,limit));await file.read(tail,0,tail.length,size-tail.length);log+='\n'+tail.toString('utf8');}const report=parseLlamaPlacement(log);if(report){cache.set(key,report);while(cache.size>16)cache.delete(cache.keys().next().value!);}return report;}catch{return undefined;}finally{await file?.close();}
}
