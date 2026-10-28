// Controlled provider; actual Rust orchestration and the shared attachment capability service.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const root=await mkdtemp('/tmp/lad-conversation-attachment-agent-');process.env.LOCAL_AI_RUNTIME_ROOT=root;
const require=createRequire(import.meta.url);const {ensureAppDirectories}=require('../dist/main/services/paths.js');ensureAppDirectories();
const {Database}=require('../dist/main/services/database.js'),{AttachmentService}=require('../dist/main/services/attachment-service.js'),{ChatReadonlyTools}=require('../dist/main/services/chat-readonly-tools.js'),{RustAgentRuntime}=require('../dist/main/services/rust-agent-runtime.js');
const db=new Database(),files=new AttachmentService(db),chat=db.createConversation('qwen3.8:27b-q4_K_M'),user=db.addMessage(chat.id,'user','Read the last attached source slice. Do not edit files. Answer the final marker.');
const text='chapter\n'+'Narrative line. '.repeat(35000)+'\nFINAL-MARKER-782';const attachment=await files.import({messageId:user.id,index:0,filename:'book.txt',mimeType:'text/plain',data:Buffer.from(text)});await files.preprocess(attachment,new AbortController().signal);
let requests=0,sourceReceived=false;const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
 if(req.url.endsWith('/input_tokens')){res.end(JSON.stringify({input_tokens:1000}));return;}
 const schemas=new Map((body.tools??[]).map(tool=>[tool.function.name,tool.function.parameters]));
 assert(schemas.get('read_conversation_file')?.properties.attachment_id);if(schemas.has('read_file'))assert(schemas.get('read_file').properties.path,'Project read_file must retain its path contract');assert(schemas.has('plan')&&schemas.has('deliverables'),'Agent planning contracts must remain available');
 requests++;const result=body.messages?.findLast(m=>m.role==='tool'&&m.content.includes('FINAL-MARKER-782'));if(result)sourceReceived=true;
 const message=requests===1?{role:'assistant',content:'',tool_calls:[{id:'read-attached',type:'function',function:{name:'read_conversation_file',arguments:JSON.stringify({attachment_id:attachment.id,offset_chars:text.length-1000,limit_chars:1000})}}]}:{role:'assistant',content:'Final marker: FINAL-MARKER-782. No user files changed.'};
 const reason=requests===1?'tool_calls':'stop',usage={prompt_tokens:1000,completion_tokens:100};
 if(body.stream){res.setHeader('content-type','text/event-stream');const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((call,index)=>({...call,index}))}:{})};res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:reason}],usage})+'\n\ndata: [DONE]\n\n');}
 else {res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message,finish_reason:reason}],usage}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 const endpoint=`http://127.0.0.1:${server.address().port}/v1/chat/completions`,scope=new ChatReadonlyTools(db,files,chat.id,{},chat.modelId,65536),runtime=new RustAgentRuntime(endpoint);
 const history=[{id:'attachment-registry',conversationId:chat.id,role:'system',content:scope.context('agent'),createdAt:'',attachments:db.listAttachmentsForConversation(chat.id)},user];
 const events=[];for await(const event of runtime.stream(chat.modelId,history,[],new AbortController().signal,65536,'fast','off','attachment-agent-test',undefined,chat.id,false,undefined,[],undefined,undefined,undefined,{mode:'strict',trusted_roots:[]},undefined,undefined,undefined,'off',false,undefined,scope))events.push(event);
 await writeFile(root+'/events.json',JSON.stringify(events,null,2));
 assert(sourceReceived,'Rust host did not receive actual attached source beyond the preview');assert(events.some(e=>e.type==='token'&&e.content.includes('FINAL-MARKER-782')));assert(!events.some(e=>e.type==='error'),JSON.stringify(events.filter(e=>e.type==='error')));
 assert.equal(db.listAttachmentsForConversation(chat.id)[0].id,attachment.id);assert(scope.context().includes(attachment.id));
 assert(events.some(e=>e.type==='tool'&&e.activity.toolName==='read_conversation_file'&&e.activity.kind==='file_read'));
 const reopened=new Database();try{reopened.updateConversation(chat.id,{mode:'chat'});const after=new ChatReadonlyTools(reopened,new AttachmentService(reopened),chat.id,{},chat.modelId,65536);const iterator=after.execute('read_file',{attachment_id:attachment.id,offset_chars:text.length-1000,limit_chars:1000},new AbortController().signal);let item=await iterator.next();while(!item.done)item=await iterator.next();assert(item.value.text.includes('FINAL-MARKER-782'));assert.equal(reopened.listAttachmentsForConversation(chat.id)[0].id,attachment.id);}finally{reopened.close();}
 console.log(JSON.stringify({result:'PASS',root,requests,realModel:false,sourceReceived,noProject:true,chatAgentChatAttachmentPreserved:true,planningContractsPreserved:true}));
}finally{db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
