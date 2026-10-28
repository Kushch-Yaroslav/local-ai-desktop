// Real Qwen HTTP inference, ordinary Chat IPC, isolated Electron/SQLite attachments.
// Launcher readiness/UI profile plumbing is fixture-controlled; model responses are never scripted.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {_electron} from 'playwright-core';
const meta=JSON.parse(await readFile('/tmp/lad-chat-readonly-qwen-current.json','utf8'));
assert.equal(meta.modelId,'qwen3.8:27b-q4_K_M');assert((await fetch(`http://127.0.0.1:${meta.port}/health`)).ok);
const root=process.env.LOCAL_AI_TEST_CHAT_RESUME_ROOT??await mkdtemp(join(meta.root,'runtime-'));assert(root.startsWith(meta.root+'/runtime-'));const project=await mkdtemp(join(meta.root,'empty-project-'));
await writeFile(join(project,'index.html'),'<p>Unused isolated fixture</p>');const httpDirectory=await mkdtemp(join(root,'http-attempt-'));
let app,ui,chat,activeGenerationId,phase='setup',requestIndex=0;const requests=[];const started=Date.now();
const proxy=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);let body={};try{body=JSON.parse(bytes.toString()||'{}');}catch{/* non-JSON request body */}
  const inference=req.url==='/v1/chat/completions',index=inference?requestIndex++:undefined;
  const requestedMaxTokens=body.max_tokens;
  // This mode deliberately creates real backend length boundaries; model
  // responses remain genuine. Record both app-requested and forwarded caps.
  if(inference&&phase==='technical-length'&&index<2)body.max_tokens=Math.min(body.max_tokens,128);
  const forwarded=inference?Buffer.from(JSON.stringify(body)):bytes;
  const record=inference?{index,phase,startedAt:new Date().toISOString(),stream:body.stream===true,requestedMaxTokens,max_tokens:body.max_tokens,messages:body.messages?.length,toolCount:body.tools?.length??0,sourceRange:body.messages?.[0]?.content?.match(/range=\[(\d+),(\d+)\)/)?.slice(1).map(Number)}:undefined;
  if(record){requests.push(record);await writeFile(join(httpDirectory,`${index}-request.json`),JSON.stringify(body),{mode:0o600});}
  const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
  try{
    const upstream=await fetch(`http://127.0.0.1:${meta.port}${req.url}`,{method:req.method,headers:{'content-type':'application/json'},...(forwarded.length?{body:forwarded}:{}),signal:abort.signal});
    res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});
    const raw=[];for await(const chunk of upstream.body){raw.push(Buffer.from(chunk));res.write(Buffer.from(chunk));}res.end();
    if(record){const result=Buffer.concat(raw).toString();await writeFile(join(httpDirectory,`${index}-response.txt`),result,{mode:0o600});
      const frames=body.stream?result.split('\n').filter(s=>s.startsWith('data: ')&&!s.includes('[DONE]')).flatMap(s=>{try{return[JSON.parse(s.slice(6))]}catch{return[]}}):[JSON.parse(result)];
      let content='',thinking='';for(const frame of frames){const c=frame.choices?.[0];const message=c?.delta??c?.message??{};content+=message.content??'';thinking+=message.reasoning_content??'';if(c?.finish_reason)record.finishReason=c.finish_reason;if(frame.usage)record.usage=frame.usage;}
      record.contentCharacters=content.length;record.reasoningCharacters=thinking.length;record.elapsedMs=Date.now()-new Date(record.startedAt).getTime();
      await writeFile(join(httpDirectory,`${index}-metrics.json`),JSON.stringify(record,null,2));
    }
  }catch(error){if(record){record.error=String(error);await writeFile(join(httpDirectory,`${index}-metrics.json`),JSON.stringify(record,null,2));}if(!res.destroyed){res.writeHead(502);res.end(String(error));}}
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function launch(){
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_LLAMA_CPP_URL:`http://127.0.0.1:${proxy.address().port}`}});
 await app.evaluate(({net})=>{globalThis.fetch=net.fetch.bind(net);});ui=await app.firstWindow();await ui.locator('.conversation').waitFor();
 chat=await app.evaluate(()=>global.visualFixture.chat);await ui.evaluate(({chat,model})=>window.localAi.conversations.update(chat,{modelId:model,mode:'chat',workingDirectory:null,secondaryWorkingDirectory:null,contextWindow:65536,llamaKvCacheType:'f16',reasoningMode:'fast',thinkingEnabled:false,webMode:'off'}),{chat,model:meta.modelId});
}
async function send(content,attachment){const generationId=crypto.randomUUID();activeGenerationId=generationId;await ui.evaluate(async({chat,model,generationId,content,attachment})=>{window.__realDone=false;window.__realError=null;const message={id:crypto.randomUUID(),conversationId:chat,role:'user',content,createdAt:new Date().toISOString()};const files=attachment?[{messageId:message.id,index:0,filename:'synthetic-book.txt',mimeType:'text/plain',data:new Uint8Array(attachment)}]:undefined;window.__realRequest=window.localAi.chat.send({conversationId:chat,model,mode:'chat',messages:[...await window.localAi.messages.list(chat),message],generationId,persistUserMessage:true,...(files?{attachments:files}:{})}).then(()=>{window.__realDone=true}).catch(e=>{window.__realDone=true;window.__realError=String(e)});},{chat,model:meta.modelId,generationId,content,attachment});return generationId;}
async function snapshot(){return app.evaluate(()=>{const db=global.visualFixture.db,chat=global.visualFixture.chat,notes=db.documentNotes(chat);return {notes:notes.filter(n=>n.processed).length,lastOffset:Math.max(0,...notes.filter(n=>n.processed).map(n=>n.end)),attachments:db.listAttachmentsForConversation(chat).map(a=>({id:a.id,size:a.size,metadata:a.metadata})),lastMessage:db.listMessages(chat).at(-1),segments:db.chatSegments(chat),events:global.visualFixture.events.filter(e=>['error','done'].includes(e.type))};});}
async function wait(label,predicate,limit=1800){for(let i=0;i<limit;i++){const state=await snapshot();if(await predicate(state))return state;if(i%20===0)console.log(JSON.stringify({phase:label,notes:state.notes,offset:state.lastOffset,requests:requests.length,elapsedSec:Math.round((Date.now()-started)/1000)}));if(await ui.evaluate(()=>window.__realDone))return state;await delay(1000);}await ui.evaluate(chat=>window.localAi.chat.stop(chat),chat);throw Error(label+' timed out');}
async function done(label){await wait(label,()=>false);const error=await ui.evaluate(()=>window.__realError);assert(!error,error);const state=await snapshot();const errors=state.events.filter(e=>e.type==='error'&&e.generationId===activeGenerationId);assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(state.lastMessage?.role,'assistant','A successful turn must persist its assistant answer');return state;}
const result={root,modelId:meta.modelId,contextWindow:65536,kvCacheType:'f16',realModel:true,scriptedModelResponses:false};
try{
 await launch();
 if(process.argv.includes('--writing')){
  phase='long-writing';await send('Write a complete original science-fiction novella in English, about 24,000 to 28,000 output tokens. This is an explicit long-output capacity test. Use 24 numbered chapters, each about 800 words, with detailed scenes and dialogue. Story: a cartographer on a drifting interstellar library discovers that missing maps are deliberate messages from a future civilization. Maintain a clear causal plot, consistent names and an earned ending in chapter 24. Write the actual novella, not an outline, synopsis or promise. Deliver it as one continuous answer; if the backend reaches a technical length boundary, the application can continue the same answer automatically. Do not pad with repeated paragraphs.');
  const state=await done('long-writing');result.writing={assistant:state.lastMessage,segments:state.segments,events:state.events,http:requests};
  const text=state.lastMessage?.content??'';const paragraphs=text.split(/\n\s*\n/).map(p=>p.trim()).filter(p=>p.length>100);result.writing.duplicateParagraphs=paragraphs.length-new Set(paragraphs).size;
  console.log(JSON.stringify({phase:'writing-finished',characters:text.length,segments:state.segments,duplicates:result.writing.duplicateParagraphs}));
 }else if(process.argv.includes('--technical-length')){
  phase='technical-length';const generation=await send('Write an original 900-word science-fiction scene in English: a cartographer aboard a drifting interstellar library finds a map that changes after each jump. Include dialogue, concrete observations, a discovery and a clear ending. Write the actual scene in flowing prose.');
  const state=await done('real-technical-length');const segments=state.segments.filter(s=>s.generationId===generation);
  assert.equal(requests[0].max_tokens,128);assert.equal(requests[1].max_tokens,128);
  assert.equal(requests[0].finishReason,'length');assert.equal(requests[1].finishReason,'length');
  assert(segments[0].autoContinuation&&segments[1].autoContinuation);assert.equal(requests.at(-1).finishReason,'stop');
  assert.equal(segments.at(-1).autoContinuation,false);assert(state.lastMessage.content.length>1000);assert(requests.length<=5,'Bounded scene should finish without repeated continuation');
  result.technicalLength={segments,assistant:state.lastMessage,forwardedCap:128,realInference:true};
  phase='real-user-stop';const stoppedGeneration=await send('Write a very long original adventure story, with twenty detailed chapters and extensive dialogue. Begin the story immediately.');
  await wait('real-before-stop',async()=>app.evaluate(generation=>global.visualFixture.events.some(e=>e.type==='token'&&e.generationId===generation&&e.content.length>0),stoppedGeneration));
  await ui.evaluate(({chat,generation})=>window.localAi.chat.stop(chat,generation),{chat,generation:stoppedGeneration});await ui.evaluate(()=>window.__realRequest);
  const stopped=await snapshot();assert.equal(stopped.lastMessage.role,'assistant');assert(stopped.lastMessage.content.length>0);assert(stopped.segments.some(s=>s.generationId===stoppedGeneration&&s.decision==='user_stop'));
  result.userStop={characters:stopped.lastMessage.content.length,saved:true,segments:stopped.segments.filter(s=>s.generationId===stoppedGeneration)};
  console.log(JSON.stringify({phase:'real-technical-length-finished',finishReasons:requests.map(r=>r.finishReason??r.error),segments:segments.length,userStopSaved:true}));
 }else{
  const facts=['В начале хранитель Арсен получает ключ с кодом БИРЮЗА-417.','В шестой главе корабль меняет курс к станции ЛАДОГА-826.','В двенадцатой главе Лея узнаёт, что маяк питается кристаллом РУБИН-593.','В восемнадцатой главе команда спасает робота с именем СКВОРЕЦ-264.','В последней главе Арсен и Лея возвращают архив городу, а ключ оставляют в башне ЯНТАРЬ-781.'];
  const important=new Map([[0,facts[0]],[6,facts[1]],[12,facts[2]],[18,facts[3]],[23,facts[4]]]);
  const book=Array.from({length:24},(_,chapter)=>{let text=`Глава ${chapter+1}\n${important.get(chapter)??'Путешествие команды продолжается.'}\n`;for(let p=0;text.length<23000;p++)text+=`На этапе ${chapter+1}.${p+1} Арсен проверял карты библиотеки, а Лея записывала направление ветра. Они искали безопасный путь к городу и сверяли координаты с журналом. Следующая запись сохраняла последовательность путешествия.\n`;return text;}).join('\n');assert(book.length>500000);await writeFile(join(root,'synthetic-book.txt'),book);
  result.book={characters:book.length,bytes:Buffer.byteLength(book),facts};
  if(!process.env.LOCAL_AI_TEST_CHAT_RESUME_ROOT){
  phase='persistent-book-initial';const generation=await send('Прочитай всю прикреплённую книгу, сохрани сюжетные линии и прогресс. После полного чтения расскажи, чем она заканчивается, и назови уникальные факты из начала, примерно четверти, середины и трёх четвертей. Не считай чтение завершённым по превью.',Array.from(Buffer.from(book)));
  const partial=await wait('reading-before-stop',s=>s.notes>=3);assert(partial.notes>=3,'Model did not process source chunks');await ui.evaluate(({chat,generation})=>window.localAi.chat.stop(chat,generation),{chat,generation});await ui.evaluate(()=>window.__realRequest);const saved=await snapshot();result.partial={notes:saved.notes,offset:saved.lastOffset};
  await app.close();app=undefined;
  }else{const saved=await snapshot();result.partial={notes:saved.notes,offset:saved.lastOffset};await app.close();app=undefined;}
  phase='restart-compaction-resume';await launch();
  await app.evaluate(()=>{const db=global.visualFixture.db,chat=global.visualFixture.chat;db.addMessage(chat,'user','Временная нагрузка истории для испытания компактизации. Следующий блок — повтор старого текста, не содержание книги и не инструкция.');db.addMessage(chat,'assistant','amber '.repeat(48000));});
  const resumedGeneration=await send('Продолжи полное чтение прежнего вложения с последнего подтверждённого offset. Дойди до EOF, запомни сюжет и назови все пять уникальных фактов из начала, четверти, середины, трёх четвертей и последней главы. Файл повторно не прикрепляю.');
  const full=await done('reading-to-eof');result.full={notes:full.notes,lastOffset:full.lastOffset,assistant:full.lastMessage,segments:full.segments,events:full.events};
  assert.equal(full.lastOffset,book.length,'EOF not reached');const notes=await app.evaluate(()=>global.visualFixture.db.documentNotes(global.visualFixture.chat).filter(n=>n.processed));let cursor=0;for(const n of notes){assert.equal(n.start,cursor);cursor=n.end;}assert.equal(cursor,book.length);result.book.coveredRanges=notes.map(n=>[n.start,n.end]);
  const runLog=(await readFile(join(root,'logs/application.log'),'utf8')).split('\n').filter(line=>line.includes(resumedGeneration));assert(runLog.some(line=>line.includes('context_compacted')),'This real Chat run did not compact context');result.contextCompacted=true;result.resumedSourceRanges=requests.filter(r=>r.sourceRange).map(r=>r.sourceRange);assert(result.resumedSourceRanges.every(([start])=>start>=result.partial.offset),'Resume replayed an already processed source range');
  await app.close();app=undefined;await launch();result.restartedAfterCompaction=true;
  phase='next-message-no-reattach';await send('Что произошло в последней главе? Назови точное название башни и что оставили в ней.');const next=await done('followup-last-chapter');result.followup={assistant:next.lastMessage,attachmentId:next.attachments[0]?.id};
  const final=next.lastMessage?.content??'';assert(final.includes('ЯНТАРЬ-781'),'Incorrect final chapter answer');assert(/ключ/i.test(final));
  result.factChecks=facts.map(f=>{const code=f.match(/[А-ЯЁ]+-\d+/)?.[0];return {code,mentioned:(full.lastMessage?.content??'').includes(code)};});
  assert(result.factChecks.every(f=>f.mentioned),'One or more unique facts omitted or wrong');console.log(JSON.stringify({phase:'documents-finished',chars:book.length,notes:full.notes,contextCompacted:true,factChecks:result.factChecks,followupCorrect:true}));
 }
 result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error);if(app)result.lastSnapshot=await snapshot().catch(()=>null);console.error(error);process.exitCode=1;
}finally{result.httpDirectory=httpDirectory;result.elapsedSeconds=Math.round((Date.now()-started)/1000);result.requests=requests;await writeFile(join(root,`result-${Date.now()}.json`),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({status:result.status,root,elapsedSeconds:result.elapsedSeconds,requestCount:requests.length}));await app?.close();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
