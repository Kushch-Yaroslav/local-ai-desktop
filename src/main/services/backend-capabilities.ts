import {execFile} from 'node:child_process';
import {realpathSync,statSync} from 'node:fs';
import type {BackendFeatureProbe} from '../../shared/model-profiles';
import {executablePath} from './runtime-settings';
const cache=new Map<string,Promise<BackendFeatureProbe>>();
export async function probeBackendFeatures(input:string|null):Promise<BackendFeatureProbe>{
 try{
  const path=realpathSync(executablePath(input??'llama-server')),s=statSync(path),key=`${path}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  let result=cache.get(key);if(!result){result=new Promise(resolve=>execFile(path,['--help'],{timeout:10000,maxBuffer:1024*1024,env:{...process.env,LC_ALL:'C'}},(error,out,err)=>resolve(error?{status:'error',path,flags:[],reason:error.message}:{status:'supported',path,flags:[...new Set((out+'\n'+err).match(/--[a-z][a-z0-9-]+/g)??[])]})));cache.set(key,result);if(cache.size>16)cache.delete(cache.keys().next().value!);void result.then(r=>{if(r.status==='error')cache.delete(key);});}return await result;
 }catch(error){return {status:'error',flags:[],reason:String(error)};}
}
export function validateBackendArguments(args:string[],probe:BackendFeatureProbe):void{
 if(probe.status!=='supported')throw Error(`Backend capabilities could not be checked: ${probe.reason}`);
 for(const arg of args.filter(arg=>arg.startsWith('--')))if(!probe.flags.includes(arg))throw Error(`Configured llama-server does not advertise ${arg}; this setting cannot be applied.`);
}
