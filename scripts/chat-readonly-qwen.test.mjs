// Real Qwen HTTP inference, ordinary Chat IPC, isolated Electron/SQLite attachments.
// Launcher readiness/UI profile plumbing is fixture-controlled; model responses are never scripted.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {_electron} from 'playwright-core';
const meta=JSON.parse(await readFile(process.env.LOCAL_AI_TEST_QWEN_META??'/tmp/lad-chat-readonly-qwen-current.json','utf8'));
assert(/^qwen3\.[68]:/.test(meta.modelId),'An installed Qwen model is required');assert((await fetch(`http://127.0.0.1:${meta.port}/health`)).ok);
const contextWindow=Number(meta.contextWindow??65536);
const root=process.env.LOCAL_AI_TEST_RUNTIME_ROOT??process.env.LOCAL_AI_TEST_CHAT_RESUME_ROOT??await mkdtemp(join(meta.root,'runtime-'));
if(process.env.LOCAL_AI_TEST_RUNTIME_ROOT)assert(root.startsWith('/tmp/lad-chat-project-qwen-'));else assert(root.startsWith(meta.root+'/runtime-'));
await mkdir(root,{recursive:true});const project=await mkdtemp(join(root,'empty-project-'));
await writeFile(join(project,'index.html'),'<p>Unused isolated fixture</p>');const httpDirectory=await mkdtemp(join(root,'http-attempt-'));
let app,ui,chat,activeGenerationId,phase='setup',requestIndex=0;const requests=[];const started=Date.now();
const proxy=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);let body={};try{body=JSON.parse(bytes.toString()||'{}');}catch{/* non-JSON request body */}
  const inference=req.url==='/v1/chat/completions',index=inference?requestIndex++:undefined;
  const requestedMaxTokens=body.max_tokens;
  if(inference&&phase==='project-region'&&index<14)body.max_tokens=Math.min(Number(body.max_tokens??2048),2048);
  if(inference&&phase==='project-region'&&index>=14){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Limited project-region inference budget reached'}}));return;}
  // This mode deliberately creates real backend length boundaries; model
  // responses remain genuine. Record both app-requested and forwarded caps.
  if(inference&&phase==='technical-length'&&index<2)body.max_tokens=Math.min(body.max_tokens,128);
  const forwarded=inference?Buffer.from(JSON.stringify(body)):bytes;
  const record=inference?{index,phase,purpose:body.messages?.[0]?.content?.startsWith('Return ONLY a concise JSON object summarizing this conversation context')?'context_compaction':'chat',startedAt:new Date().toISOString(),stream:body.stream===true,requestedMaxTokens,max_tokens:body.max_tokens,messages:body.messages?.length,toolCount:body.tools?.length??0,toolNames:(body.tools??[]).map(t=>t.function?.name).filter(Boolean),historyToolCalls:(body.messages??[]).flatMap(m=>m.tool_calls??[]).map(c=>({name:c.function?.name,arguments:c.function?.arguments})),toolResults:(body.messages??[]).filter(m=>m.role==='tool').map(m=>{const content=String(m.content??'');const found=content.indexOf('drawUni');let regionEvidence;try{const r=JSON.parse(content);if(r.region_id)regionEvidence={region_id:r.region_id,url:r.url,route:r.route,anchors:r.anchors,source_hints:r.source_hints,pixel_bytes_sent:r.pixel_bytes_sent,source_research:r.source_research};}catch{/* Non-JSON source text has no region metadata. */}return {callId:m.tool_call_id,name:m.name??m.tool_name,characters:content.length,containsDrawUni:found>=0,regionEvidence,evidenceExcerpt:found>=0?content.slice(Math.max(0,found-180),found+360):content.slice(0,180)};}),sourceRange:body.messages?.[0]?.content?.match(/range=\[(\d+),(\d+)\)/)?.slice(1).map(Number)}:undefined;
  if(record){requests.push(record);if(phase!=='project-region')await writeFile(join(httpDirectory,`${index}-request.json`),JSON.stringify(body),{mode:0o600});}
  const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
  try{
    const upstream=await fetch(`http://127.0.0.1:${meta.port}${req.url}`,{method:req.method,headers:{'content-type':'application/json'},...(forwarded.length?{body:forwarded}:{}),signal:abort.signal});
    res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});
    const raw=[];for await(const chunk of upstream.body){raw.push(Buffer.from(chunk));res.write(Buffer.from(chunk));}res.end();
    if(record){const result=Buffer.concat(raw).toString();if(phase!=='project-region')await writeFile(join(httpDirectory,`${index}-response.txt`),result,{mode:0o600});
      const frames=body.stream?result.split('\n').filter(s=>s.startsWith('data: ')&&!s.includes('[DONE]')).flatMap(s=>{try{return[JSON.parse(s.slice(6))]}catch{return[]}}):[JSON.parse(result)];
      let content='',thinking='';const responseCalls=new Map();for(const frame of frames){const c=frame.choices?.[0];const message=c?.delta??c?.message??{};content+=message.content??'';thinking+=message.reasoning_content??'';for(const [position,call]of (message.tool_calls??[]).entries()){const key=call.index??position,prior=responseCalls.get(key)??{id:'',name:'',arguments:''};if(call.id)prior.id=call.id;prior.name+=call.function?.name??'';const args=call.function?.arguments;prior.arguments+=typeof args==='string'?args:args?JSON.stringify(args):'';responseCalls.set(key,prior);}if(c?.finish_reason)record.finishReason=c.finish_reason;if(frame.usage)record.usage=frame.usage;}record.responseToolCalls=[...responseCalls.values()];
      record.contentCharacters=content.length;record.reasoningCharacters=thinking.length;record.elapsedMs=Date.now()-new Date(record.startedAt).getTime();
      if(phase!=='project-region')await writeFile(join(httpDirectory,`${index}-metrics.json`),JSON.stringify(record,null,2));
    }
  }catch(error){if(record){record.error=String(error);await writeFile(join(httpDirectory,`${index}-metrics.json`),JSON.stringify(record,null,2));}if(!res.destroyed){res.writeHead(502);res.end(String(error));}}
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function launch(){
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_TEST_MODEL_ID:meta.modelId,LOCAL_AI_LLAMA_CPP_URL:`http://127.0.0.1:${proxy.address().port}`}});
 await app.evaluate(({net})=>{globalThis.fetch=net.fetch.bind(net);});ui=await app.firstWindow();await ui.locator('.conversation').waitFor();
 chat=await app.evaluate(()=>global.visualFixture.chat);await ui.evaluate(({chat,model,selectedProject,contextWindow,projectRegion})=>window.localAi.conversations.update(chat,{modelId:model,mode:'chat',workingDirectory:selectedProject??null,secondaryWorkingDirectory:null,contextWindow,llamaKvCacheType:'f16',reasoningMode:'fast',thinkingEnabled:projectRegion?null:false,visionMode:'off',webMode:projectRegion?'auto':'off'}),{chat,model:meta.modelId,selectedProject:process.env.LOCAL_AI_CHAT_PROJECT_ROOT??null,contextWindow,projectRegion:process.argv.includes('--project-region')});
}
async function send(content,attachment,includeRegion=false){const generationId=crypto.randomUUID();activeGenerationId=generationId;await ui.evaluate(async({chat,model,generationId,content,attachment,regionId,includeRegion})=>{window.__realDone=false;window.__realError=null;const message={id:crypto.randomUUID(),conversationId:chat,role:'user',content,createdAt:new Date().toISOString(),...(includeRegion?{regionReferences:[{id:regionId}]}:{})};const files=attachment?[{messageId:message.id,index:0,filename:'synthetic-book.txt',mimeType:'text/plain',data:new Uint8Array(attachment)}]:undefined;window.__realRequest=window.localAi.chat.send({conversationId:chat,model,mode:'chat',messages:[...await window.localAi.messages.list(chat),message],generationId,persistUserMessage:true,...(files?{attachments:files}:{})}).then(()=>{window.__realDone=true}).catch(e=>{window.__realDone=true;window.__realError=String(e)});},{chat,model:meta.modelId,generationId,content,attachment,regionId:'region-deadbeef',includeRegion});return generationId;}
async function snapshot(){return app.evaluate(()=>{const db=global.visualFixture.db,chat=global.visualFixture.chat,notes=db.documentNotes(chat);return {notes:notes.filter(n=>n.processed).length,lastOffset:Math.max(0,...notes.filter(n=>n.processed).map(n=>n.end)),attachments:db.listAttachmentsForConversation(chat).map(a=>({id:a.id,size:a.size,metadata:a.metadata})),lastMessage:db.listMessages(chat).at(-1),segments:db.chatSegments(chat),events:global.visualFixture.events.filter(e=>['error','done'].includes(e.type))};});}
async function wait(label,predicate,limit=1800){for(let i=0;i<limit;i++){const state=await snapshot();if(await predicate(state))return state;if(i%20===0)console.log(JSON.stringify({phase:label,notes:state.notes,offset:state.lastOffset,requests:requests.length,elapsedSec:Math.round((Date.now()-started)/1000)}));if(await ui.evaluate(()=>window.__realDone))return state;await delay(1000);}await ui.evaluate(chat=>window.localAi.chat.stop(chat),chat);throw Error(label+' timed out');}
async function done(label,limit=1800){await wait(label,()=>false,limit);const error=await ui.evaluate(()=>window.__realError);assert(!error,error);const state=await snapshot();const errors=state.events.filter(e=>e.type==='error'&&e.generationId===activeGenerationId);assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(state.lastMessage?.role,'assistant','A successful turn must persist its assistant answer');return state;}
const result={root,modelId:meta.modelId,contextWindow,kvCacheType:'f16',realModel:true,scriptedModelResponses:false};
try{
 await launch();
 if(process.argv.includes('--project-region')){
  phase='project-region';const projectRoot=process.env.LOCAL_AI_CHAT_PROJECT_ROOT;assert(projectRoot&&projectRoot.startsWith('/media/yaroslav/DATA/Projects/'));
  const source=await readFile(join(projectRoot,'index.html'),'utf8');assert(source.includes('drawUni'),'The real project index.html must contain drawUni');
  const sourceHash=createHash('sha256').update(source).digest('hex');
  const regionMetadata=JSON.parse(await readFile(resolve('test-fixtures/chat/canvas-region-no-source.json'),'utf8'));
  assert.deepEqual(regionMetadata.sourceHints,[]);assert.deepEqual(regionMetadata.anchors,[]);
  await ui.evaluate(chat=>window.localAi.visualDebug.open(chat,'index.html#universe'),chat);
  const browserWorkspace=await app.evaluate(()=>{const entry=global.visualFixture.entry();if(!entry?.page||entry.page.isClosed())throw Error('A real Browser Workspace is required');return {real:true,url:entry.state.url,ownership:entry.state.ownership};});
  assert.equal(browserWorkspace.url,regionMetadata.url);
  const fixture=await app.evaluate((_,{projectRoot,regionMetadata})=>{
    const db=global.visualFixture.db,chat=global.visualFixture.chat,conversation=db.getConversation(chat),projectId=conversation.primaryProjectId;
    if(conversation.workingDirectory!==projectRoot||!projectId)throw Error(`Selected project was not bound to this isolated Chat conversation: ${JSON.stringify({expected:projectRoot,actual:conversation.workingDirectory,projectId})}`);
    const region={...regionMetadata,id:'region-deadbeef',conversationId:chat,projectId,projectRoot,groupId:'canvas-universe',createdAt:new Date().toISOString()};
    const document=db.visualDocument(chat,projectId);document.regions=[...document.regions.filter(item=>item.id!==region.id),region];db.saveVisualDocument(chat,projectId,document);return {projectId,regionId:region.id,route:region.route,sourceHints:region.sourceHints,anchors:region.anchors,pixels:false};
  },{projectRoot,regionMetadata});
  const prompt='Расскажи, что изображено в этой области';
  const visualGeneration=await send(prompt,undefined,true);const visualState=await done('project-region-readonly',240);const calls=requests.flatMap(record=>record.responseToolCalls??[]);const results=[...new Map(requests.flatMap(record=>record.toolResults).map(result=>[result.callId,result])).values()];const offered=new Set(requests.flatMap(record=>record.toolNames));
  const orchestrationRequests=requests.filter(record=>record.purpose==='chat');assert(orchestrationRequests.length>=2,'Expected the live Chat tool loop after inspection');
  for(const record of orchestrationRequests)for(const name of ['read_project_file','search_project_files','search_project_text','read_browser'])assert(record.toolNames.includes(name),`Missing live project/browser tool in inference ${record.index}: ${name}`);
  assert(calls.some(call=>call.name==='inspect_region'),'Qwen did not inspect the selected region metadata');assert(calls.some(call=>call.name==='read_project_file'),'Qwen did not read project source');assert(results.some(result=>result.containsDrawUni),'Actual tool result did not contain drawUni');
  for(const forbidden of ['run_terminal','write_file','create_file','apply_patch','delete_file','git_status','git_diff','web_project'])assert(!offered.has(forbidden),`Forbidden Chat tool was exposed: ${forbidden}`);
  assert(calls.every(call=>!['run_terminal','write_file','create_file','apply_patch','delete_file','git_status','git_diff','web_project'].includes(call.name)),'Qwen attempted a mutating or Agent-only tool');
  const visualAnswer=visualState.lastMessage.content;assert(/ч[её]рн|black hole/i.test(visualAnswer),`Qwen did not identify the black hole from source: ${visualAnswer}`);assert(/аккреционн|accretion/i.test(visualAnswer),`Qwen omitted the source-confirmed accretion disk: ${visualAnswer}`);assert(/зв[её]зд|star field/i.test(visualAnswer),`Qwen omitted the source-confirmed star field: ${visualAnswer}`);assert(/исходн|код|source/i.test(visualAnswer),`Qwen did not state the evidence basis: ${visualAnswer}`);assert(!/я (?:вижу|увидел|рассмотрел) изображение/i.test(visualAnswer),'Qwen falsely claimed image perception without pixel input');
  result.visualRegion={fixture,browserWorkspace,realModel:true,scriptedResponses:false,generationId:visualGeneration,toolCalls:calls,toolResults:results,offeredProjectTools:[...offered].filter(name=>name.startsWith('read_project_')||name.startsWith('search_project_')||['list_project_files','inspect_region','read_browser'].includes(name)),assistant:visualAnswer,finishReasons:orchestrationRequests.map(record=>record.finishReason),compactionRequests:requests.filter(record=>record.purpose==='context_compaction').map(record=>({index:record.index,finishReason:record.finishReason})),maxCompletionTokens:2048,sourceSha256:sourceHash};
  const start=requests.length;await ui.evaluate(chat=>window.localAi.conversations.update(chat,{workingDirectory:null,secondaryWorkingDirectory:null}),chat);
  const plainGeneration=await send('Сколько будет 2 + 2? Ответь кратко.');const plainState=await done('chat-without-project',90);const plainRequests=requests.slice(start);assert(!plainRequests.some(record=>record.toolNames.some(name=>['list_project_files','read_project_file','search_project_files','search_project_text','inspect_region'].includes(name))),'Project-only tools remained in Chat after project removal');assert(/\b4\b/.test(plainState.lastMessage.content),`Ordinary no-project Chat failed: ${plainState.lastMessage.content}`);
  result.noProject={realModel:true,scriptedResponses:false,generationId:plainGeneration,offeredTools:[...new Set(plainRequests.flatMap(record=>record.toolNames))],assistant:plainState.lastMessage.content};
  assert(requests.length<=14,'Limited real Qwen test exceeded the inference request budget');await app.close();app=undefined;console.log(JSON.stringify({phase:'project-region-qwen-finished',toolCalls:calls.map(call=>call.name),identifyBlackHole:/ч[её]рн|black hole/i.test(visualAnswer),pixelClaim:false,noProjectAnswer:plainState.lastMessage.content,finishReasons:requests.map(record=>record.finishReason??record.error)}));
 }else if(process.argv.includes('--writing')){
  phase='long-writing';await send('Write a complete original science-fiction novella in English, about 24,000 to 28,000 output tokens. This is an explicit long-output capacity test. Use 24 numbered chapters, each about 800 words, with detailed scenes and dialogue. Story: a cartographer on a drifting interstellar library discovers that missing maps are deliberate messages from a future civilization. Maintain a clear causal plot, consistent names and an earned ending in chapter 24. Write the actual novella, not an outline, synopsis or promise. Deliver it as one continuous answer; if the backend reaches a technical length boundary, the application can continue the same answer automatically. Do not pad with repeated paragraphs.');
  const state=await done('long-writing');result.writing={assistant:state.lastMessage,segments:state.segments,events:state.events,http:requests};
  const text=state.lastMessage?.content??'';const paragraphs=text.split(/\n\s*\n/).map(p=>p.trim()).filter(p=>p.length>100);result.writing.duplicateParagraphs=paragraphs.length-new Set(paragraphs).size;
  const generated=state.segments.reduce((sum,segment)=>sum+(segment.generatedTokens??0),0);
  result.writing.assessment={transport:'PASS',requestedMinimumCompletionTokens:24000,generatedCompletionTokens:generated,requestedLengthReached:generated>=24000,real50KReached:generated>=50000,requestedChapters:24,numberedChapterHeadings:(text.match(/^#{1,6}\s+Chapter\s+\d+/gm)??[]).length,exactLongParagraphRepetitions:result.writing.duplicateParagraphs,contentQuality:result.writing.duplicateParagraphs?'repetition_detected':'no_exact_long_paragraph_repetition'};
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
  await wait('real-before-stop',async()=>app.evaluate((_,generation)=>global.visualFixture.events.some(e=>e.type==='token'&&e.generationId===generation&&e.content.length>0),stoppedGeneration));
  assert.equal(await ui.evaluate(()=>window.__realDone),false,'Stop must interrupt a live stream, not follow a natural stop');
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
