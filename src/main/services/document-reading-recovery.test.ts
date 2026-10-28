import './test-runtime-isolation';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { ToolCallingBackend, ToolMessage } from '../backends/types';
import { ChatReadonlyTools } from './chat-readonly-tools';
import { AttachmentService } from './attachment-service';
import { Database } from './database';
import { ensureAppDirectories } from './paths';
async function execute(scope:ChatReadonlyTools,name:string,args:Record<string,unknown>,signal=new AbortController().signal){const iterator=scope.execute(name,args,signal);let next=await iterator.next();while(!next.done)next=await iterator.next();return next.value as Record<string,unknown>;}
async function main(){
 ensureAppDirectories();const db=new Database(),service=new AttachmentService(db),chat=db.createConversation('fixture'),user=db.addMessage(chat.id,'user','Read');
 const text='A source fact. '.repeat(5000),file=await service.import({messageId:user.id,index:0,filename:'source.txt',mimeType:'text/plain',data:Buffer.from(text)});await service.preprocess(file,new AbortController().signal);
 let calls=0,mode='malformed';const offsets:Array<[number,number]>=[];const abort=new AbortController();
 const backend={chatWithTools:async(_m:string,messages:ToolMessage[])=>{calls++;const range=/range=\[(\d+),(\d+)\)/.exec(messages[0].content)!;const start=Number(range[1]),end=Number(range[2]);offsets.push([start,end]);if(mode==='malformed')return{role:'assistant',content:'{ broken',finish_reason:'stop'};if(mode==='adaptive'&&end-start>6000)return{role:'assistant',content:'{}',finish_reason:'length'};if(mode==='cancel'&&calls===2)abort.abort();return{role:'assistant',content:JSON.stringify({events:['source-fact-42'],hypotheses:[],uncertainties:[]}),finish_reason:'stop'};}} as ToolCallingBackend;
 let scope=new ChatReadonlyTools(db,service,chat.id,backend,'fixture',65536);
 await assert.rejects(execute(scope,'read_document',{attachment_id:file.id}),/valid JSON/);assert.equal(db.documentNotes(chat.id).length,0);
 mode='cancel';calls=0;await assert.rejects(execute(scope,'read_document',{attachment_id:file.id},abort.signal));assert.equal((await execute(scope,'attachment_metadata',{attachment_id:file.id})).current_offset,24000);
 mode='adaptive';calls=0;offsets.length=0;scope=new ChatReadonlyTools(db,service,chat.id,backend,'fixture',65536);
 const result=await execute(scope,'read_document',{attachment_id:file.id});assert.equal(result.completed,true);assert.equal(result.current_offset,text.length);assert.equal(offsets[0][0],24000);assert.equal(offsets[2][1]-offsets[2][0],6000,'Length-limited summaries need a smaller source chunk, not repeated identical reads');
 scope.saveContextCheckpoint([user],'Preserved facts and source cursor');const next=db.addMessage(chat.id,'user','Follow-up');const restored=scope.restoreHistory([user,next]);assert(restored[0].content.includes('Preserved facts'));assert(!restored.some(m=>m.id===user.id));assert(scope.restoreHistory([{...user,content:'edited'},next]).some(m=>m.id===user.id),'Edited history must invalidate the checkpoint');
 const note=db.documentNotes(chat.id).find(n=>n.processed)!;await writeFile(file.storageRef,'modified source');await scope.prepare(new AbortController().signal);assert(!scope.context().includes('summary_preview'));await assert.rejects(execute(scope,'read_observation',{observation_id:note.observationId}),/hash/);await assert.rejects(execute(scope,'document_memory',{attachment_id:file.id}),/hash/);
 db.close();console.log('PASS reading recovery: malformed summaries do not advance, Stop retains first chunk, adaptive length chunks, resume without replay, checkpoint edit invalidation, source hash invalidation');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
