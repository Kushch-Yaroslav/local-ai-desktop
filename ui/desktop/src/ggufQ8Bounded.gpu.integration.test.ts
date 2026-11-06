// Opt-in bounded current-configuration probe; no user settings or discovery registry writes.
import {it,expect,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
vi.mock('electron',()=>({app:{},ipcMain:{},BrowserWindow:{getAllWindows:()=>[]}}));
import {ManagedGguf} from './managedGguf';
import {parseLlamaAllocationLog} from './contextDiscovery/contextEstimate';
it.skipIf(process.env.LAD_Q8_BOUNDED!=='1' || !process.env.LAD_RUNTIME_TEST_PROFILE)('probes Q8 with current saved Vision/MTP at 16K only',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lad-q8-bounded-'));const service=new ManagedGguf(root);
 try{
 const profiles=JSON.parse(await readFile(process.env.LAD_RUNTIME_TEST_PROFILE!,'utf8'));
 const original=profiles.find((p:{name:string})=>p.name==='Qwen27B-3.8');expect(original).toBeTruthy();
 const profile=await service.save({...original,id:undefined,providerId:undefined,context:16384,cacheK:'q8_0',cacheV:'q8_0',flashAttention:'on'});
 const internals=service as unknown as {start:(p:typeof profile,s:AbortSignal,verbose?:boolean)=>Promise<unknown>};const start=internals.start.bind(service);internals.start=(p,s)=>start(p,s,true);
 await service.activate(profile.id!);const ep=await service.prepare(profile.id!);
 const response=await fetch(ep.url+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+ep.key,'Content-Type':'application/json'},body:JSON.stringify({model:'local-gguf',messages:[{role:'user',content:'Reply OK.'}],max_tokens:2,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(60000)});
 await response.arrayBuffer();expect(response.ok).toBe(true);
 const log=await readFile(join(root,`gguf-${profile.id}.log`),'utf8');const parsed=parseLlamaAllocationLog(log,service.state.args);
 await writeFile('/tmp/lad-q8-bounded-report.json',JSON.stringify({phase:service.state.phase,args:service.state.args,context:parsed.contextTokens,unknownReasons:parsed.unknownReasons,allocations:parsed.allocations},null,2));
 }finally{await service.shutdown();await rm(root,{recursive:true,force:true});}
},120000);
