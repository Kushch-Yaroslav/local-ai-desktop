// Real inference only. Isolated storage; never launches or reconfigures a model/server.
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),stage=process.argv[2]??'short';
const root=process.env.LAD_ARTEMIS_TEST_ROOT??mkdtempSync(join(tmpdir(),'lad-artemis-'));
if(!resolve(root).startsWith(resolve(tmpdir())+'/lad-artemis-'))throw Error('Test root must be a lad-artemis-* directory under the OS temp directory');
process.env.LOCAL_AI_RUNTIME_ROOT=root;mkdirSync(join(root,'app-data'),{recursive:true});
const settings=JSON.parse(readFileSync('runtime/app-data/runtime-settings.json','utf8'));
const profile=settings.models.find(m=>/artemis/i.test(m.displayName));if(!profile)throw Error('Installed Artemis profile missing');
writeFileSync(join(root,'app-data/runtime-settings.json'),JSON.stringify({...settings,models:[profile]}));
const {Database}=require('../dist/main/services/database.js');const {AttachmentService}=require('../dist/main/services/attachment-service.js');
const {ChatReadonlyTools}=require('../dist/main/services/chat-readonly-tools.js');const {LlamaCppBackend}=require('../dist/main/backends/llama-cpp-backend.js');const {WebChatService}=require('../dist/main/services/web-chat.js');
const {ensureAppDirectories}=require('../dist/main/services/paths.js');ensureAppDirectories();
const url=process.env.LAD_ARTEMIS_URL??'http://127.0.0.1:8081';
const slots=await (await fetch(url+'/slots')).json();if(!Array.isArray(slots)||slots.some(s=>s.is_processing))throw Error('Backend busy; no test submitted');
const context=slots[0].n_ctx;const provider=new LlamaCppBackend(url,context,false,profile.id);
const db=new Database(),files=new AttachmentService(db),abort=new AbortController();process.on('SIGINT',()=>abort.abort());process.on('SIGTERM',()=>abort.abort());
let fixture;if(existsSync(join(root,'fixture.json')))fixture=JSON.parse(readFileSync(join(root,'fixture.json')));else {
 const chat=db.createConversation('Isolated Artemis document test');const user=db.addMessage(chat.id,'user','ты можешь прочитать эту книгу и кратко рассказать о чем она. А так же кратко расскажи о каждой главе, мне интересно узнать линейное повествование');
 const file=await files.import({messageId:user.id,index:0,filename:'Stalker book.txt',mimeType:'text/plain',data:readFileSync(process.env.LAD_TEST_BOOK??'/home/yaroslav/Загрузки/Stalker book.txt')});await files.preprocess(file,abort.signal);fixture={conversationId:chat.id,user,fileId:file.id};writeFileSync(join(root,'fixture.json'),JSON.stringify(fixture));
}
const records=[],started=Date.now();let final='';
function persist(extra={}){writeFileSync(join(root,stage+'-metrics.json'),JSON.stringify({stage,root,model:profile.id,context,elapsedMs:Date.now()-started,requests:records,notes:db.documentNotes(fixture.conversationId).map(n=>({start:n.start,end:n.end,processed:n.processed,summaryCharacters:n.summary.length})),...extra},null,2));}
async function idle(signal){let tries=0;while(true){signal.throwIfAborted();const models=await(await fetch(url+'/v1/models',{signal})).json();if(!models.data?.some(m=>m.id===profile.id))throw Error('Active backend model changed; isolated test stopped without switching runtime');const s=await(await fetch(url+'/slots',{signal})).json();if(s.every(x=>!x.is_processing))return;if(++tries>120)throw Error('Backend remained busy for ten minutes');await new Promise(r=>setTimeout(r,5000));}}
function record(response,messages,begin){const match=/range=\[(\d+),(\d+)\)/.exec(messages[0]?.content??'');const n=records.length+1;
 const r={request:n,elapsedMs:Date.now()-begin,...(match?{start:+match[1],end:+match[2]}:{}),finishReason:response.finish_reason,...response.inference};records.push(r);
 writeFileSync(join(root,stage+'-response-'+n+'.json'),JSON.stringify({content:response.content,thinkingCharacters:response.thinking?.length??0},null,2));persist();console.log(JSON.stringify({request:n,range:match?[+match[1],+match[2]]:null,ms:r.elapsedMs,input:r.inputTokens,output:r.evalCount,finish:r.finishReason}));}
const backend=new Proxy(provider,{get(target,key){if(key==='chatWithTools')return async(model,messages,tools,signal,...args)=>{await idle(signal);const begin=Date.now();const response=await target.chatWithTools(model,messages,tools,AbortSignal.any([signal,AbortSignal.timeout(900000)]),...args);record(response,messages,begin);return response;};
 if(key==='streamWithTools')return async function*(model,messages,tools,signal,...args){await idle(signal);const begin=Date.now();for await(const e of target.streamWithTools(model,messages,tools,AbortSignal.any([signal,AbortSignal.timeout(900000)]),...args)){if(e.type==='response')record(e.response,messages,begin);yield e;}};
 const v=target[key];return typeof v==='function'?v.bind(target):v;}});
const scope=new ChatReadonlyTools(db,files,fixture.conversationId,backend,profile.id,context);
console.log(JSON.stringify({stage,root,model:profile.id,context}));
try {
 if(stage.startsWith('review-')) {
  await scope.completedReading([fixture.user],abort.signal);
  let candidate=readFileSync(join(root,process.env.LAD_REVIEW_INPUT??'full-reviewed-final.md'),'utf8');if((process.env.LAD_REVIEW_INPUT??'').endsWith('.json'))candidate=JSON.parse(candidate).content;
  final=await scope.reviewReadingAnswer(candidate,abort.signal);
  writeFileSync(join(root,stage+'-final.md'),final);
 }else if(stage.startsWith('full')){
  for await(const e of new WebChatService(backend,{}).stream(profile.id,[fixture.user],abort.signal,context,{mode:'fast',selection:{thinking:true,effort:null}},false,undefined,undefined,'artemis-isolated-'+stage,scope)){
   if(e.type==='token')final+=e.content;if(e.type==='error')throw Error(e.details??e.message);
  }
  writeFileSync(join(root,stage+'-final.md'),final);writeFileSync(join(root,'final.md'),final);
 }else {
  const it=scope.execute('read_document',{attachment_id:fixture.fileId},abort.signal);let step=await it.next();while(!step.done){
   const count=db.documentNotes(fixture.conversationId).filter(n=>n.processed).length;
   if((stage==='short'&&count>=3)||(stage==='reproduce'&&count>=1)){await it.return();break;}
   step=await it.next();
  }
  if(step.done)writeFileSync(join(root,stage+'-result.json'),JSON.stringify(step.value,null,2));
 }
 const it=scope.execute('attachment_metadata',{attachment_id:fixture.fileId},abort.signal);let step=await it.next();while(!step.done)step=await it.next();persist({coverage:step.value,finalCharacters:final.length});
 console.log(JSON.stringify({finished:true,stage,root,offset:step.value.current_offset,completed:step.value.completed,requests:records.length}));
} catch(e){persist({error:String(e)});console.error(String(e));process.exitCode=1;}finally{db.close();}
