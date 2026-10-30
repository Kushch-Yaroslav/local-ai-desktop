import './test-runtime-isolation';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {documentSections, readingProgress, type DocumentChunkNote} from './document-memory';
import {ChatReadonlyTools} from './chat-readonly-tools';
import {AttachmentService} from './attachment-service';
import {Database} from './database';
import {ensureAppDirectories} from './paths';
import {WebChatService} from './web-chat';
import type {ToolCallingBackend, LlmBackend, ToolMessage} from '../backends/types';
async function main(){
 ensureAppDirectories();const db=new Database(),files=new AttachmentService(db),chat=db.createConversation('coverage'),user=db.addMessage(chat.id,'user','Read the whole book');
 const text=process.env.LAD_TEST_BOOK?await readFile(process.env.LAD_TEST_BOOK,'utf8'):'Глава 1\n\nГлава 2\n\nГлава 1\n'+('first chapter fact. '.repeat(1500))+'\nГлава 2\n'+('second chapter fact. '.repeat(42000));
 const file=await files.import({messageId:user.id,index:0,filename:'book.txt',mimeType:'text/plain',data:Buffer.from(text)});await files.preprocess(file,new AbortController().signal);
 let fail=true,outer=0;const ranges:Array<[number,number]>=[];
 const backend={chatWithTools:async(_m:string,messages:ToolMessage[])=>{
  const m=/range=\[(\d+),(\d+)\)/.exec(messages[0].content)!;ranges.push([+m[1],+m[2]]);
  return {role:'assistant',content:fail?'broken JSON':JSON.stringify({events:['controlled fact, not a real book summary']}),finish_reason:'stop'};
 },async *streamWithTools(){outer++;yield {type:'response',response:outer===1?{role:'assistant',content:'',tool_calls:[{id:'read',function:{name:'read_document',arguments:{attachment_id:file.id}}}]}:{role:'assistant',content:'FABRICATED ENDING',finish_reason:'stop'}};}} as unknown as ToolCallingBackend&LlmBackend;
 const call=async(scope:ChatReadonlyTools)=>{const iterator=scope.execute('read_document',{attachment_id:file.id},new AbortController().signal);let step=await iterator.next();while(!step.done)step=await iterator.next();return step.value as {completed:boolean;notes:DocumentChunkNote[];current_offset:number;opening_excerpt:{start:number;end:number;text:string};closing_excerpt:{start:number;end:number;text:string};sections:Array<{completed:boolean}>};};
 let scope=new ChatReadonlyTools(db,files,chat.id,backend,'fixture',65536);let output='';
 for await(const e of new WebChatService(backend,{} as never).stream('fixture',[user],new AbortController().signal,65536,'deep',false,undefined,undefined,'coverage',scope))if(e.type==='token')output+=e.content;
 assert.equal(outer,1,'Failure must not trigger another reasoning loop or ungrounded final');assert(!output.includes('FABRICATED'));assert(output.includes('0 из'));assert.equal(db.documentNotes(chat.id).length,0);
 fail=false;ranges.length=0;scope=new ChatReadonlyTools(db,files,chat.id,backend,'fixture',65536);const result=await call(scope);
 assert.equal(result.opening_excerpt.text,text.slice(result.opening_excerpt.start,result.opening_excerpt.end));assert.equal(result.closing_excerpt.end,text.length);assert.equal(result.closing_excerpt.text,text.slice(result.closing_excerpt.start));assert(result.closing_excerpt.text.length<=8000);
 assert(result.completed);assert.equal(result.current_offset,text.length);assert.equal(result.notes.length,ranges.length);assert(result.sections.every(s=>s.completed));
 assert.equal(ranges[0][0],0);for(let i=1;i<ranges.length;i++)assert.equal(ranges[i][0],ranges[i-1][1]);assert.equal(ranges.at(-1)![1],text.length);
 assert.equal(documentSections(text).length,process.env.LAD_TEST_BOOK?22:2,'TOC must not be counted as narrative chapters');
 const saved=db.documentNotes(chat.id);scope=new ChatReadonlyTools(db,files,chat.id,backend,'fixture',65536);const count=ranges.length;assert((await call(scope)).completed);assert.equal(ranges.length,count);assert.deepEqual(db.documentNotes(chat.id),saved);
 const invalid={processed:true,start:-1,end:100} as DocumentChunkNote;assert.equal(readingProgress([invalid],100).completed,false);
 assert(!readingProgress([{...invalid,start:0,end:30},{...invalid,start:40,end:100}],100).completed);
 db.close();console.log(`PASS coverage: ${text.length} characters, ${count} contiguous calls, all notes delivered, TOC excluded, persisted resume, incomplete final blocked. Controlled backend; no factual LLM validation.`);
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
