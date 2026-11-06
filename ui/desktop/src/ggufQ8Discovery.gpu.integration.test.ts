// Opt-in full discovery with a test-only 64K ceiling. Real model files are never modified.
import {it,expect,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
vi.mock('electron',()=>({app:{},ipcMain:{},BrowserWindow:{getAllWindows:()=>[]}}));
vi.mock('./ggufMetadata',async(importOriginal)=>{
 const original=await importOriginal<typeof import('./ggufMetadata')>();
 return {...original,inspectGguf:async(...args:Parameters<typeof original.inspectGguf>)=>{const result=await original.inspectGguf(...args);return {...result,...(result.context?{context:Math.min(result.context,65536)}:{})};}};
});
import {ManagedGguf} from './managedGguf';
it.skipIf(process.env.LAD_Q8_DISCOVERY!=='1' || !process.env.LAD_RUNTIME_TEST_PROFILE)('validates both precisions through real bounded discovery and reopens isolated results',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lad-q8-discovery-'));let service=new ManagedGguf(root);let report:unknown={};
 try{
 const profiles=JSON.parse(await readFile(process.env.LAD_RUNTIME_TEST_PROFILE!,'utf8'));
 const current=profiles.find((p:{name:string})=>p.name==='Qwen27B-3.8');expect(current).toBeTruthy();
 const profile=await service.save({...current,id:undefined,providerId:undefined,context:16384,flashAttention:'on'});
 const token=await service.acquireRuntimeLease({id:401,once:()=>{}} as never);
 const completed=await service.runContextDiscovery(profile.id!,token);
 report={ceiling:65536,savedMtp:profile.speculativeMode,vision:profile.visionEnabled!==false&&!!profile.projector,result:completed};
 expect(JSON.stringify(completed.result.unsupported)).not.toContain('точность');
 expect(completed.result.probes?.some(p=>p.kvCacheType==='q8_0'&&p.startup&&p.health&&p.inference&&p.headroom)).toBe(true);
 await service.shutdown();service=new ManagedGguf(root);await service.list();
 const catalog=await service.getDiscoveryCatalog(profile.id!);
 expect(catalog.options.map(o=>[o.kvCacheType,o.contextWindow])).toEqual(completed.result.options.map(o=>[o.kvCacheType,o.contextWindow]).sort((a,b)=>Number(a[1])-Number(b[1])));
 expect((await service.list())[0].profile.context).toBe(16384);
 }finally{await service.shutdown();await writeFile('/tmp/lad-q8-discovery-report.json',JSON.stringify(report,null,2));await rm(root,{recursive:true,force:true});}
},240000);
