import assert from 'node:assert/strict';
import { LiveBrowserHub } from './live-browser';
import type { LiveBrowserState } from '../../shared/live-browser';

async function main(){
  const hub=new LiveBrowserHub();
  const owner={id:91,isDestroyed:()=>false} as never;
  const projectRoot='/selected/project';let reads=0;
  const entry={owner,state:{conversationId:'chat-a',generationId:'run',sessionId:'session',ownership:'user',status:'live',url:'http://project-preview.invalid/index.html'} as LiveBrowserState,ended:false,page:{isClosed:()=>false},controls:{projectRoot,diagnosticRead:async(args:Record<string,unknown>)=>{reads++;return {action:args.action,content:'DOM only'};}}};
  (hub as unknown as {entries:Map<string,typeof entry>}).entries.set('91:chat-a',entry);
  assert.equal(hub.chatDiagnosticReader(owner,'chat-a',[]),undefined,'no selected root grants no Browser reader');
  assert.equal(hub.chatDiagnosticReader(owner,'chat-a',['/another/project']),undefined,'Browser reader is bound to the selected project root');
  const read=hub.chatDiagnosticReader(owner,'chat-a',[projectRoot]);assert(read);
  assert.deepEqual(await read({action:'read'},new AbortController().signal),{action:'read',content:'DOM only'});
  await assert.rejects(read({action:'navigate'},new AbortController().signal),/read-only/);
  assert.equal(reads,1,'invalid navigation never reaches the Browser executor');
  entry.state={...entry.state,ownership:'agent'};
  await assert.rejects(read({action:'read'},new AbortController().signal),/unavailable/,'Agent-owned Browser pages are not exposed to Chat');
  entry.state={...entry.state,ownership:'user'};entry.ended=true;
  await assert.rejects(read({action:'read'},new AbortController().signal),/unavailable/,'closed Browser sessions are not exposed to Chat');
  console.log('PASS Chat Browser capability: selected-project binding, DOM-only read, navigation rejection, Agent ownership and closed-session refusal.');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
