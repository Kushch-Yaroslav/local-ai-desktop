import type {AdvancedModelParameters,BackendFeatureProbe,ModelInspection,ModelMemoryEstimate,ModelProfileDefaults} from './model-profiles';
export function parseLayerRanges(text:string,count:number):number[]{
 if(!Number.isInteger(count)||count<1||count>4096)throw Error('GGUF block count unavailable');
 const ids=new Set<number>();if(!text.trim())return [];
 for(const part of text.split(',')){const m=/^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);if(!m)throw Error('Use ranges such as 3-12, 15, 16-20');const a=Number(m[1]),b=Number(m[2]??m[1]);if(a>b||b>=count)throw Error(`Layer IDs must be 0..${count-1}`);for(let n=a;n<=b;n++)ids.add(n);}
 return [...ids].sort((a,b)=>a-b);
}
export const experimentalPlacement=(p?:AdvancedModelParameters)=>p?.gpuLayerIds!==undefined||Boolean(p?.moeAcceleration&&p.moeAcceleration!=='disabled');
export const profileRuntimePath=(p:AdvancedModelParameters|undefined,standard:string|null)=>(void p,standard);
export function estimateModelMemory(inspection:ModelInspection,p:AdvancedModelParameters|undefined,gpuLayers:number,defaults:ModelProfileDefaults,availableMiB:number|null,totalMiB:number|null):ModelMemoryEstimate{
 const s=inspection.structure,count=inspection.layers??0,cacheActive=Boolean(p?.moeAcceleration&&p.moeAcceleration!=='disabled'),ids=p?.gpuLayerIds?new Set(p.gpuLayerIds):undefined;
 let gpu=0;for(const t of s?.tensors??[]){let on=t.block===undefined?gpuLayers>=count&&/^output/.test(t.name):ids?ids.has(t.block):t.block>=Math.max(0,count-Math.min(count,gpuLayers));
  if(ids&&t.block===undefined)on=false;
  if(t.expert&&(cacheActive||p?.cpuMoe==='all'||p?.cpuMoe==='first'&&t.block!==undefined&&t.block<(p.cpuMoeLayers??0)))on=false;
  if(on)gpu+=t.bytes;
 }
 const context=defaults.contextWindow??32768,precision=defaults.kvCacheType==='q8_0'?34/32:2;
 const kv=s?.kvHeads&&s.keyLength&&s.valueLength&&s.fullAttentionLayers!==undefined?s.kvHeads*(s.keyLength+s.valueLength)*s.fullAttentionLayers*context*precision/1024**2:0;
 const recurrent=inspection.architecture==='qwen3next'?(s?.recurrentLayers??0)*2.094:0;
 const compute=1536,reserve=2048,weights=gpu/1024**2,gpuKv=defaults.kvOffload===false?0:kv;
 const known=Boolean(s?.complete&&count&&kv>0&&(!p?.tensorOverrides?.length));
 const safe=Math.max(0,Math.floor(((availableMiB??0)-weights-gpuKv-recurrent-compute-reserve)/1024)*1024);
 const cache=cacheActive?(p?.moeAcceleration==='automatic'?Math.min(16384,safe):p?.expertCacheMiB??8192):0;
 const required=weights+gpuKv+recurrent+compute+reserve+cache;
 return {weightsMiB:weights,cpuWeightsMiB:Math.max(0,(s?.totalBytes??0)-gpu)/1024**2,kvMiB:gpuKv,cpuKvMiB:defaults.kvOffload===false?kv:0,recurrentMiB:recurrent,computeMiB:compute,reserveMiB:reserve,cacheMiB:cache,availableMiB,totalMiB,requiredMiB:required,safeCacheMiB:safe,fits:known&&availableMiB!==null&&required<=availableMiB,known,notes:['Estimated weights use GGUF tensor byte counts, not average layer size.','Compute includes conservative workspace headroom; runtime logs remain authoritative.',...(inspection.architecture==='qwen3next'?['Hybrid KV uses full-attention blocks; recurrent state is conservatively calibrated from Qwen48 measurements.']:[]),...(!known?['Insufficient metadata or arbitrary tensor overrides: memory cannot be certified.']:[])]};
}
export function placementSupport(i:ModelInspection,features?:BackendFeatureProbe){return Boolean(['qwen3next','llama'].includes(i.architecture??'')&&i.layers&&i.layers<=4096&&i.structure?.complete&&i.structure.tensors.length&&Array.from({length:i.layers},(_,n)=>n).every(n=>i.structure!.tensors.some(t=>t.block===n))&&features?.status==='supported'&&features.flags.includes('--override-tensor')&&features.buffers?.includes('CUDA0'));}
export function verifiedMoe(i:ModelInspection){return i.architecture==='qwen3next'&&/qwen3[ _-]*coder[ _-]*next/i.test(i.modelName??'')&&i.layers===48&&i.experts===512&&i.fileType===15;}

export function formatLayerRanges(ids:number[]):string{const sorted=[...new Set(ids)].sort((a,b)=>a-b),parts:string[]=[];for(let i=0;i<sorted.length;i++){let end=sorted[i];const start=end;while(sorted[i+1]===end+1){end=sorted[++i];}parts.push(start===end?String(start):`${start}-${end}`);}return parts.join(', ');}

/** Same limit as the launcher's model scope; the OS reserve lives outside it. */
export function modelCgroupLimitMiB(totalRamMiB:number):number {return Math.min(56320,Math.floor(totalRamMiB)-7168);}
export interface HostMemoryBudget {
 fileBackedWeightsMiB:number;anonymousWeightsMiB:number;cpuKvMiB:number;stateMiB:number;overheadMiB:number;
 reserveMiB:number;mandatoryMiB:number;requiredMiB:number;fullWorkingSetMiB:number;
 availableMiB:number|null;cgroupMaxMiB:number|null;fits:boolean;workingSetFits:boolean;
}
/** mmap weights consume physical pages on access, but are reclaimable file
 * pages, not mandatory anonymous allocations. Keep the full working-set target
 * visible; its shortfall warns about paging instead of falsely certifying OOM.
 * No cache discount: dynamic GPU copies do not remove CPU expert weights. */
export function estimateHostMemory(memory:ModelMemoryEstimate,p:AdvancedModelParameters|undefined,availableMiB:number|null,cgroupMaxMiB:number|null):HostMemoryBudget {
 // Bounded placement emits --no-repack and --no-host. Without that guarantee,
 // mmap may be repacked into anonymous buffers: keep the conservative check.
 const cache=Boolean(p?.moeAcceleration&&p.moeAcceleration!=='disabled');
 const loadMode=p?.loadMode??(cache?'mmap':undefined);
 const mapped=loadMode==='mmap'&&experimentalPlacement(p),fileBackedWeightsMiB=mapped?memory.cpuWeightsMiB:0,anonymousWeightsMiB=mapped?0:memory.cpuWeightsMiB;
 const cpuKvMiB=memory.cpuKvMiB,stateMiB=memory.recurrentMiB,overheadMiB=2048,reserveMiB=7168;
 // The full recurrent estimate is deliberately counted on the host as an upper bound.
 const mandatoryMiB=anonymousWeightsMiB+cpuKvMiB+stateMiB+overheadMiB,requiredMiB=mandatoryMiB+reserveMiB;
 const fullWorkingSetMiB=mandatoryMiB+fileBackedWeightsMiB;
 const valid=availableMiB!==null&&Number.isFinite(availableMiB)&&availableMiB>=0;
 return {fileBackedWeightsMiB,anonymousWeightsMiB,cpuKvMiB,stateMiB,overheadMiB,reserveMiB,mandatoryMiB,requiredMiB,fullWorkingSetMiB,availableMiB,cgroupMaxMiB,
 fits:valid&&requiredMiB<=availableMiB&&(cgroupMaxMiB===null||mandatoryMiB<=cgroupMaxMiB),
 workingSetFits:valid&&fullWorkingSetMiB+reserveMiB<=availableMiB&&(cgroupMaxMiB===null||fullWorkingSetMiB<=cgroupMaxMiB)};
}
export function hostMemoryBreakdown(b:HostMemoryBudget):string {
 const n=(x:number|null)=>x===null?'unknown':`${x.toFixed(2)} MiB (${(x/1024).toFixed(2)} GiB)`;
 return `RAM available=${n(b.availableMiB)}; mandatory allocations=${n(b.mandatoryMiB)} (anonymous weights=${n(b.anonymousWeightsMiB)}, CPU KV=${n(b.cpuKvMiB)}, state upper bound=${n(b.stateMiB)}, runtime headroom=${n(b.overheadMiB)}); OS reserve=${n(b.reserveMiB)}; required=${n(b.requiredMiB)}; file-backed mmap weights=${n(b.fileBackedWeightsMiB)}; full resident working set=${n(b.fullWorkingSetMiB)}; model cgroup MemoryMax=${n(b.cgroupMaxMiB)}.`;
}
