import './test-runtime-isolation';
import assert from 'node:assert/strict';
import { ChatTelemetry } from './chat-telemetry';
import type { ToolCallingBackend, LlmBackend } from '../backends/types';
import type { AgentTelemetry } from '../../shared/types';
import { Database } from './database';
import { ensureAppDirectories } from './paths';
import { AttachmentService } from './attachment-service';
import { ChatReadonlyTools } from './chat-readonly-tools';
import { WebChatService } from './web-chat';
import { useAppStore } from '../../renderer/store/app-store';

async function main() {
  ensureAppDirectories(); const db=new Database(),chat=db.createConversation('fixture');
  const snapshots:AgentTelemetry[]=[];
  const monitor=new ChatTelemetry('fixture',snapshot=>{snapshots.push(snapshot);db.saveChatTelemetry(chat.id,snapshot);});
  const backend:ToolCallingBackend={
    async chatWithTools(_model,_messages,_tools,_signal,_window,_reasoning,meta){meta?.onUsage?.({inputTokens:20});return {role:'assistant',content:'summary',prompt_eval_count:20,inference:{evalCount:3} as never};},
    async *streamWithTools(_model,_messages,_tools,_signal,_window,_reasoning,meta){
      meta?.onUsage?.({inputTokens:100});assert.equal(monitor.snapshot().outputTokensKnown,false);
      meta?.onUsage?.({outputTokens:7});yield {type:'token',content:'real output'};
      meta?.onUsage?.({inputTokens:100,outputTokens:12});
      yield {type:'response',response:{role:'assistant',content:'real output',prompt_eval_count:100,inference:{evalCount:12} as never}};
    },
  };
  const observed=monitor.observe(backend),signal=new AbortController().signal;
  monitor.start();assert.equal(monitor.snapshot().inputTokensKnown,false);
  await observed.chatWithTools('fixture',[],undefined,signal,4096,'fast',{phase:'recovery'});
  for await(const event of observed.streamWithTools!('fixture',[],undefined,signal,4096,'fast'))void event;
  assert.equal(monitor.snapshot().inputTokens,120);assert.equal(monitor.snapshot().outputTokens,15);assert.equal(monitor.snapshot().contextUsed,112);
  monitor.activity({id:'call',toolName:'read_document',label:'Read',state:'running'});
  monitor.activity({id:'call',toolName:'read_document',label:'Read',state:'running'});
  monitor.activity({id:'source-progress',label:'Read chunk',kind:'file_read',state:'running'});
  monitor.activity({id:'compact',label:'Compact',kind:'context',state:'completed'});
  monitor.activity({id:'compact',label:'Compact',kind:'context',state:'completed'});
  await observed.chatWithTools('fixture',[],undefined,signal,4096,'fast');
  const reduced=monitor.snapshot();assert.equal(reduced.contextUsed,23);assert.equal(reduced.inputTokens,140);assert.equal(reduced.outputTokens,18);assert.equal(reduced.actions,1);assert.equal(reduced.compactions,1);assert.equal(reduced.turn,3);
  monitor.finish();const finished=monitor.snapshot();monitor.finish();assert.equal(monitor.snapshot().finishedAt,finished.finishedAt);
  assert(snapshots.some(s=>s.turn===2&&s.outputTokens===10),'Usage must publish during inference, not just after it');

  Object.defineProperty(globalThis,'window',{configurable:true,value:{requestAnimationFrame:()=>1,cancelAnimationFrame(){},localAi:{messages:{list:async()=>[]},analysis:{list:async()=>[]},agentPlans:{get:async()=>null}}}});
  const store=useAppStore;store.setState({activeId:chat.id,generationId:'run',generationConversationId:chat.id,generationOwnerId:'run',isGenerating:true,conversations:[db.getConversation(chat.id)!],agentTelemetry:null});
  const send=(telemetry:Partial<AgentTelemetry>)=>store.getState().handleStream({type:'agent-telemetry',telemetry,conversationId:chat.id,generationId:'run'});
  send(finished);send(finished);assert.equal(store.getState().agentTelemetry!.inputTokens,140,'Chat snapshots cannot be added twice');
  store.setState({agentTelemetry:{turn:0,inputTokens:0,outputTokens:0,actions:0,startedAt:new Date().toISOString()}});
  send({inputTokens:10,outputTokens:2});send({inputTokens:10,outputTokens:2});assert.equal(store.getState().agentTelemetry!.inputTokens,20,'Agent usage remains additive');
  db.close();const reopened=new Database();assert.deepEqual(reopened.getConversation(chat.id)!.chatTelemetry,JSON.parse(JSON.stringify(finished)));
  store.setState({activeId:null,isGenerating:false,generationState:'idle',conversations:[reopened.getConversation(chat.id)!]});await store.getState().selectConversation(chat.id);assert.equal(store.getState().agentTelemetry!.outputTokens,18);

  const unknown:ToolCallingBackend={async chatWithTools(){return {role:'assistant',content:'Many characters',inference:{inputTokens:99999} as never};}};
  let missing:AgentTelemetry|undefined;const missingMonitor=new ChatTelemetry('fixture',s=>{missing=s;});await missingMonitor.observe(unknown).chatWithTools('fixture',[],undefined,signal,4096,'fast');
  assert.equal(missing!.inputTokensKnown,false);assert.equal(missing!.outputTokensKnown,false);assert.equal(missing!.contextUsed,undefined,'Estimated inference.inputTokens is not a measured context');

  const files=new AttachmentService(reopened),user=reopened.addMessage(chat.id,'user','Read all');const text='A source fact. '.repeat(40000);
  const file=await files.import({messageId:user.id,index:0,filename:'large.txt',mimeType:'text/plain',data:Buffer.from(text)});await files.preprocess(file,signal);
  let chunks=0;const reader=new ChatTelemetry('fixture',()=>{});
  const provider=reader.observe({async chatWithTools(_model,messages,tools,_signal,_window,_reasoning,meta){
    const internal=messages[0].content.includes('Process exactly this source chunk');if(internal)chunks++;
    meta?.onUsage?.({inputTokens:internal?350:100,outputTokens:internal?7:4});
    return {role:'assistant',content:messages[0].content.includes('Review the final document answer')?JSON.stringify({edits:[]}):internal?JSON.stringify({events:['fact']}):tools&&!messages.some(m=>m.role==='tool')?'':'Done',
      ...(!internal&&tools&&!messages.some(m=>m.role==='tool')?{tool_calls:[{id:'read',function:{name:'read_document',arguments:{attachment_id:file.id}}}]}:{}),
      prompt_eval_count:internal?350:100,inference:{evalCount:internal?7:4} as never,finish_reason:'stop'};
  },getModels:async()=>[],getStatus:async()=>({available:true}),async *streamChat(){}} as ToolCallingBackend & LlmBackend);
  const scope=new ChatReadonlyTools(reopened,files,chat.id,provider,'fixture',65536);
  for await(const event of new WebChatService(provider,{openSession:async()=>{throw Error('No web');}} as never).stream('fixture',[user],signal,65536,'fast',false,undefined,undefined,'reading',scope))if(event.type==='tool')reader.activity(event.activity);
  assert.equal(chunks,Math.ceil(text.length/24000));assert.equal(reader.snapshot().turn,chunks+3);assert.equal(reader.snapshot().inputTokens,350*chunks+300);assert.equal(reader.snapshot().outputTokens,7*chunks+12);assert.equal(reader.snapshot().actions,1);
  reopened.close();console.log('PASS Chat telemetry: live usage, internal document requests, absolute snapshots, compaction totals, missing metrics, restart and Agent deltas');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
