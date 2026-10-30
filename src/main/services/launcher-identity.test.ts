import assert from 'node:assert/strict';
import {liveLauncherPid} from './launcher-identity';
async function main(){
 const files={stateFile:'state',launcherPidFile:'pid'};const data=new Map<string,string>();
 const read=async(path:string)=>{if(!data.has(path))throw Error('missing');return data.get(path)!;};
 const stat=(parent:number,start:string)=>`42 (bash) S ${parent} `+Array(17).fill('0').join(' ')+` ${start}`;
 data.set('state',JSON.stringify({launcherPid:10,launcherStartTime:'old'}));
 data.set('/proc/20/cmdline','bash\0/project/run-local-ai-desktop-llama-cpp-mtp.sh\0');data.set('/proc/20/stat',stat(1,'new'));
 assert.equal(await liveLauncherPid(files,read,20),20,'Live parent survives erased registration and stale state');
 assert.equal(await liveLauncherPid(files,read,1),undefined);
 data.set('pid','20');assert.equal(await liveLauncherPid(files,read,1),20);
 data.set('state',JSON.stringify({launcherPid:20,launcherStartTime:'wrong'}));assert.equal(await liveLauncherPid(files,read,1),undefined,'PID reuse must not adopt a different process');
 data.set('pid','30');data.set('/proc/30/cmdline','bash\0-c\0echo run-local-ai-desktop-llama-cpp-mtp.sh\0');assert.equal(await liveLauncherPid(files,read,1),undefined,'A command string containing the name is not an owned launcher');
 data.set('pid','20');data.set('state','null');assert.equal(await liveLauncherPid(files,read,1),20,'Malformed state must not prevent discovery of a validated PID');
 console.log('PASS launcher identity: erased PID, stale state, live parent, PID reuse and unrelated process rejection');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
