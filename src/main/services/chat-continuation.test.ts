import './test-runtime-isolation';
import assert from 'node:assert/strict';
import {WebChatService} from './web-chat';
import {CHAT_OUTPUT_TOKEN_LIMIT,ChatContinuationBoundary} from './chat-continuation';
import type {ToolCallingBackend,LlmBackend,ToolMessage,ToolInferenceRequestContext} from '../backends/types';
import type {ChatMessage} from '../../shared/types';
const history=[{id:'u',conversationId:'c',role:'user',content:'Explain in detail',createdAt:''}] as ChatMessage[];
const web={openSession:async()=>{throw Error('No browser needed');}};
async function fixture(parts:Array<{text:string;tokens:number;reason:'length'|'stop';error?:boolean}>,abort?:AbortController){
 const caps:number[]=[],messages:ToolMessage[][]=[];
 const backend={async *streamWithTools(_model:string,history:ToolMessage[],_tools:unknown,_signal:AbortSignal,_ctx:number,_reasoning:unknown,meta:ToolInferenceRequestContext){caps.push(meta.maxOutputTokens!);messages.push(structuredClone(history));const p=parts.shift()!;yield {type:'token' as const,content:p.text};if(p.error)throw Error('backend disconnected');yield {type:'response' as const,response:{role:'assistant' as const,content:p.text,finish_reason:p.reason,inference:{evalCount:p.tokens}}};},getModels:async()=>[],getStatus:async()=>({available:true}),async *streamChat(){}} as unknown as ToolCallingBackend&LlmBackend;
 const service=new WebChatService(backend,web as never);const events=[];
 for await(const e of service.stream('fixture',history,(abort??new AbortController()).signal,131072,'fast',false)){events.push(e);if(abort&&e.type==='token')abort.abort();}
 return {caps,messages,text:events.filter(e=>e.type==='token').map(e=>e.content).join(''),events};
}
async function main(){
 assert.equal(CHAT_OUTPUT_TOKEN_LIMIT,50000);
 const short=await fixture([{text:'Short natural answer.',tokens:5,reason:'stop'}]);assert.equal(short.caps.length,1);
 const long=await fixture([{text:'First part.\n',tokens:16000,reason:'length'},{text:'First part.\nSecond part.\n',tokens:16000,reason:'length'},{text:'Third part.',tokens:18000,reason:'length'}]);assert.deepEqual(long.caps,[32768,32768,18000]);assert.equal(long.text,'First part.\nSecond part.\nThird part.');assert.equal(long.events.at(-1)?.type,'done');assert.equal(long.messages[1].at(-1)?.role,'user');assert.equal(history.length,1,'Continuation is inference-only, never a persisted user turn');
 const repeated=await fixture([{text:'Same response.',tokens:10,reason:'length'},{text:'Same response.',tokens:10,reason:'length'}]);assert.equal(repeated.caps.length,2);assert.equal(repeated.text,'Same response.');
 const empty=await fixture([{text:'',tokens:10,reason:'length'}]);assert.equal(empty.caps.length,1);
 const stopped=await fixture([{text:'Saved partial',tokens:5,reason:'length'}],new AbortController());assert.equal(stopped.text,'Saved partial');assert.equal(stopped.caps.length,1);
 const failure=await fixture([{text:'Saved before error',tokens:5,reason:'length',error:true}]);assert.equal(failure.text,'Saved before error');assert(failure.events.some(e=>e.type==='error'));
 const b=new ChatContinuationBoundary('```ts\nconst value = ');assert.equal(b.push('const '),'');assert.equal(b.push('value = 42;\n```'),'42;\n```');
 console.log('PASS chat-only 50K aggregate cap, >16K auto continuation, EOS, dedup, Markdown boundary, Stop and backend partial text; no persisted synthetic user turn');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
