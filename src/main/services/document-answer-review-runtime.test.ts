import './test-runtime-isolation';
import assert from 'node:assert/strict';
import {ensureAppDirectories} from './paths';
import {WebChatService} from './web-chat';
import type {ChatReadonlyScope} from './chat-readonly-tools';
import type {ToolCallingBackend,LlmBackend} from '../backends/types';
import type {StreamEvent} from '../../shared/types';
async function main(){
 ensureAppDirectories();
 const backend={async *streamWithTools(){yield {type:'token',content:'UNREVIEWED WRONG ENDING'};yield {type:'response',response:{role:'assistant',content:'UNREVIEWED WRONG ENDING',finish_reason:'stop'}};}} as unknown as ToolCallingBackend&LlmBackend;
 let fail=false;
 const scope:ChatReadonlyScope={definitions:[],context:()=>'',readingReviewReady:()=>true,reviewReadingAnswer:async text=>{assert.equal(text,'UNREVIEWED WRONG ENDING');if(fail)throw Error('Review incomplete; source notes preserved');return 'SOURCE-CHECKED ENDING';},async *execute(){yield* [];throw Error('Unexpected tool');}};
 async function run(){const events:StreamEvent[]=[];for await(const e of new WebChatService(backend,{} as never).stream('fixture',[{id:'u',conversationId:'c',role:'user',content:'Read each chapter',createdAt:new Date().toISOString()}],new AbortController().signal,65536,'fast',false,undefined,undefined,'review-fixture',scope))events.push(e);return events;}
 const good=await run();assert(good.some(e=>e.type==='token'&&e.presentation==='reviewed-ready'));assert.deepEqual(good.filter(e=>e.type==='token').map(e=>e.content),['SOURCE-CHECKED ENDING']);
 fail=true;const bad=await run();assert(!bad.some(e=>e.type==='token'),'Review failure must not expose the unverified answer');assert(bad.some(e=>e.type==='error'));
 console.log('PASS document review runtime: raw answer withheld, corrected answer emitted once, failed review never emits unsupported final');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
