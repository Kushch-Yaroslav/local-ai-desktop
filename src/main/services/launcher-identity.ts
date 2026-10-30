import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
type Files={stateFile:string;launcherPidFile:string};
const read=(path:string)=>readFile(path,'utf8');
export async function liveLauncherPid(files:Files,readText=read,parentPid=process.ppid):Promise<number|undefined> {
  let state:{launcherPid?:number;launcherStartTime?:string}={};
  try{const value=JSON.parse(await readText(files.stateFile));if(value&&typeof value==='object'&&!Array.isArray(value))state=value;}catch{/* stale/missing state */}
  const valid=async(pid:number,expected?:string)=>{
    if(!Number.isSafeInteger(pid)||pid<=0)return false;
    const args=(await readText(`/proc/${pid}/cmdline`).catch(()=>'' )).split('\0');
    if(!args.some(arg=>basename(arg)==='run-local-ai-desktop-llama-cpp-mtp.sh'))return false;
    if(expected){const stat=await readText(`/proc/${pid}/stat`).catch(()=>'' );if(stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/)[19]!==expected)return false;}
    return true;
  };
  const recorded=Number((await readText(files.launcherPidFile).catch(()=>'' )).trim());
  if(await valid(recorded,state.launcherPid===recorded?state.launcherStartTime:undefined))return recorded;
  if(state.launcherPid&&await valid(state.launcherPid,state.launcherStartTime))return state.launcherPid;
  // Recover a source-launched Electron whose parent's registration was erased by
  // an older launcher's cleanup. Never scan or signal arbitrary system processes.
  for(let depth=0,pid=parentPid;depth<8&&pid>1;depth++) {
    if(await valid(pid))return pid;
    const stat=await readText(`/proc/${pid}/stat`).catch(()=>'' );
    const next=Number(stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/)[1]);
    if(!next||next===pid)break;pid=next;
  }
  return undefined;
}
