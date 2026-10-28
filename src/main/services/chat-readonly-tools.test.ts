import './test-runtime-isolation';
import assert from 'node:assert/strict';
import type { ChatMessage, StreamEvent } from '../../shared/types';
import type { LlmBackend, ToolCallingBackend, ToolMessage } from '../backends/types';
import { AttachmentService } from './attachment-service';
import { ChatReadonlyTools } from './chat-readonly-tools';
import { Database } from './database';
import { ensureAppDirectories } from './paths';
import { WebChatService } from './web-chat';

async function call(scope:ChatReadonlyTools,name:string,args:Record<string,unknown>,signal=new AbortController().signal) {
  const iterator=scope.execute(name,args,signal);let next=await iterator.next();
  while(!next.done)next=await iterator.next();return next.value as Record<string,unknown>;
}
async function main(){
  ensureAppDirectories();let db=new Database();let files=new AttachmentService(db);
  const chat=db.createConversation('fixture'),other=db.createConversation('fixture');const user=db.addMessage(chat.id,'user','Read the whole book');
  const text=Array.from({length:24},(_,i)=>`Chapter ${i+1}\nUnique fact ${i}: violet-lighthouse-${i}.\n`+'Ordinary narrative. '.repeat(1150)).join('\n');
  assert(text.length>500000);
  const attachment=await files.import({messageId:user.id,index:0,filename:'book.txt',mimeType:'text/plain',data:Buffer.from(text)});
  await files.preprocess(attachment,new AbortController().signal);
  let chunks=0; const sourceRanges:Array<[number,number]>=[];
  const backend={
    async chatWithTools(_m:string,messages:ToolMessage[]){chunks++;const match=/range=\[(\d+),(\d+)\)/.exec(messages[0].content)!;sourceRanges.push([Number(match[1]),Number(match[2])]);return {role:'assistant',content:JSON.stringify({events:JSON.parse(messages[1].content).source_text.match(/Unique fact[^\n]+/g)??[],hypotheses:[],uncertainties:[]}),finish_reason:'stop'};},
    async *streamWithTools(_m:string,messages:ToolMessage[]){
      const hasResult=messages.some(m=>m.role==='tool');
      yield {type:'response',response:hasResult?{role:'assistant',content:'Answer from processed document.',finish_reason:'stop'}:{role:'assistant',content:'',tool_calls:[{id:'read-whole',function:{name:'read_document',arguments:{attachment_id:attachment.id}}}],finish_reason:'tool_calls'}};
    },getModels:async()=>[],getStatus:async()=>({available:true}),async *streamChat(){},
  } as unknown as LlmBackend&ToolCallingBackend;
  let scope=new ChatReadonlyTools(db,files,chat.id,backend,'fixture',65536);
  const events:StreamEvent[]=[];
  for await(const e of new WebChatService(backend,{openSession:async()=>{throw Error('Not needed');}} as never).stream('fixture',[user],new AbortController().signal,65536,'fast',false,undefined,undefined,'fixture-run',scope))events.push(e);
  assert(events.some(e=>e.type==='token'&&e.content==='Answer from processed document.'));
  const state=await call(scope,'attachment_metadata',{attachment_id:attachment.id});assert.equal(state.completed,true);assert.equal(state.current_offset,text.length);
  assert.deepEqual(sourceRanges[0],[0,24000]);for(let i=1;i<sourceRanges.length;i++)assert.equal(sourceRanges[i][0],sourceRanges[i-1][1]);assert.equal(sourceRanges.at(-1)?.[1],text.length);
  const count=chunks;await call(scope,'read_document',{attachment_id:attachment.id});assert.equal(chunks,count,'Completed document must not be reprocessed');
  await call(scope,'read_file',{attachment_id:attachment.id,offset_chars:0,limit_chars:24000});assert(db.documentNotes(chat.id,attachment.id).find(n=>n.start===0)?.summary.includes('events'),'A re-read must not erase processed notes');
  const unrelated=new ChatReadonlyTools(db,files,other.id,backend,'fixture',65536);
  await assert.rejects(call(unrelated,'read_file',{attachment_id:attachment.id}),/conversation/);
  for(const name of ['apply_patch','run_terminal','delete_file','write_file','git','web_project'])await assert.rejects(call(scope,name,{}),/Capability denied/);
  await assert.rejects(call(scope,'read_file',{attachment_id:attachment.id,path:'/etc/passwd'}),/Unknown/);
  await assert.rejects(call(scope,'read_file',{attachment_id:attachment.id,offset_chars:-1}),/integer/);
  await assert.rejects(call(scope,'read_observation',{observation_id:'tm-001'}),/Unknown observation/);
  const matches=await call(scope,'search_attachments',{query:'violet-lighthouse-23'});assert(JSON.stringify(matches).includes('violet-lighthouse-23'));
  const lastNote=db.documentNotes(chat.id,attachment.id).filter(n=>n.processed).at(-1)!;
  assert(JSON.stringify(await call(scope,'read_observation',{observation_id:lastNote.observationId})).includes('source_text'));
  db.close();db=new Database();files=new AttachmentService(db);scope=new ChatReadonlyTools(db,files,chat.id,backend,'fixture',65536);
  assert.equal((await call(scope,'attachment_metadata',{attachment_id:attachment.id})).completed,true);
  const followup=db.addMessage(chat.id,'user','What happened in the last chapter?') as ChatMessage;assert(!followup.attachments?.length);
  assert(scope.context().includes(attachment.id));
  const abort=new AbortController();abort.abort();await assert.rejects(call(scope,'read_document',{attachment_id:attachment.id},abort.signal));
  db.deleteConversation(chat.id);assert.equal(db.documentNotes(chat.id).length,0);db.close();
  console.log(`PASS Chat read-only runtime: ${text.length} chars, ${sourceRanges.length} contiguous chunks, EOF, notes, next turn/restart, ownership, mutation denial, provenance, cancellation. Summary backend is controlled.`);
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
