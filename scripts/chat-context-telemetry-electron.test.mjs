// Real IPC/backend/SQLite/renderer; controlled HTTP usage, no model or user runtime.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-chat-telemetry-'),project=await mkdtemp('/tmp/lad-chat-telemetry-project-');
await writeFile(join(project,'index.html'),'<title>Isolated fixture</title>');
const book='Document source fact. '.repeat(25000);await writeFile(join(root,'large.txt'),book);
let app,ui,chat,phase='short',steps=[],held,releaseSummary,chunksRead=0;
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
const server=createServer(async(req,res)=>{
 const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString()||'{}');
 if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'qwen3.8:27b-q4_K_M',meta:{n_ctx:32768}}]}));return;}
 if(req.url==='/health'){res.end('{}');return;}
 if(req.url==='/tokenize'){res.end(JSON.stringify({tokens:[1]}));return;}
 const summary=body.messages?.[0]?.content?.includes('Process exactly this source chunk');
 const compact=body.messages?.[0]?.content?.startsWith('Return ONLY a concise JSON object summarizing');
 if(req.url.endsWith('/input_tokens')){
  if(phase==='unknown'){res.writeHead(501);res.end('{}');return;}
  const old=body.messages?.some(m=>m.content.includes('old-marker'));
  res.end(JSON.stringify({input_tokens:summary?350:old?24000:compact?200:steps[0]?.input??1000}));return;
 }
 if(!body.stream){
  const send=()=>res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(summary?{events:['source fact']}:body.messages[0].content.includes('Review the final document answer')?{edits:[]}:{decisions:['Earlier history retained']})},finish_reason:'stop'}],usage:{prompt_tokens:summary?350:200,completion_tokens:summary?7:8}}));
  if(summary&&++chunksRead===2){releaseSummary=send;return;}send();return;
 }
 let step;
 if(phase==='document'){
  const hasRead=body.messages.some(m=>m.role==='tool');
  const id=body.messages[0].content.match(/"attachment_id":"([a-f0-9-]+)"/)?.[1];assert(id,'Attachment registry absent');
  step=hasRead?{text:'Document done',input:1000,output:10,reason:'stop'}:{text:'',input:1000,output:4,reason:'tool_calls',calls:[{index:0,id:'read-book',type:'function',function:{name:'read_document',arguments:JSON.stringify({attachment_id:id})}}]};
 }else{step=steps.shift();assert(step,'Unexpected inference: '+phase);}
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write(frame({choices:[{delta:{content:step.text,...(step.calls?{tool_calls:step.calls}:{})},finish_reason:null}],...(!step.omitUsage&&step.hold?{usage:{prompt_tokens:step.input,completion_tokens:step.liveOutput}}:{})}));
 const finish=()=>res.end(frame({choices:[{delta:{},finish_reason:step.reason}],...(!step.omitUsage?{usage:{prompt_tokens:step.input,completion_tokens:step.output}}:{})})+'data: [DONE]\n\n');
 if(step.hold)held={finish,res};else finish();
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,label){for(let n=0;n<200;n++){if(await predicate())return;await delay(100);}throw Error(label);}
const snapshot=()=>app.evaluate(()=>global.visualFixture.db.getConversation(global.visualFixture.chat).chatTelemetry);
const stat=label=>ui.locator('.ctx-stat').filter({hasText:label}).locator('b');
const numeric=async label=>Number((await stat(label).innerText()).replace(/[\s\u00a0,]/g,''));
async function send(text){held=undefined;await ui.locator('.composer textarea').fill(text);await ui.locator('.composer textarea').press('Enter');}
async function finished(){await until(async()=>Boolean((await snapshot())?.finishedAt),'Run did not finish');await until(async()=>await ui.locator('.send-button.stop').count()===0,'Renderer did not finish');}
async function reopen(){await ui.reload();await ui.locator('.composer textarea').waitFor();await ui.locator('.context-usage > button').click();await ui.locator('.context-usage-popover').waitFor();}
const checks=[];
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_LLAMA_CPP_URL:`http://127.0.0.1:${server.address().port}`}});
 await app.evaluate(({net})=>{globalThis.fetch=net.fetch.bind(net);});ui=await app.firstWindow();await ui.locator('.conversation').waitFor();chat=await app.evaluate(()=>global.visualFixture.chat);
 await ui.evaluate(async chat=>{await window.localAi.conversations.update(chat,{modelId:'qwen3.8:27b-q4_K_M',mode:'chat',contextWindow:32768,llamaKvCacheType:'f16',workingDirectory:null,secondaryWorkingDirectory:null,webMode:'off'});await window.localAi.settings.setLanguage('ru');},chat);await reopen();
 steps=[{text:'Short reply',input:1000,output:10,reason:'stop',hold:true}];await send('Say hello');await until(()=>Boolean(held),'Short stream not held');
 await until(async()=>await numeric('Входные токены')===1000,'No live provider usage');assert.equal(await stat('Выходные токены').innerText(),'—');assert.equal(await numeric('Всего за запуск'),1000);assert.equal(await numeric('Запросы модели'),1);assert.notEqual(await stat('Прошло').innerText(),'—');assert.equal((await ui.locator('.ctx-amount').innerText()).split('/')[0].replace(/\D/g,''),'1000');await ui.evaluate(()=>window.localAi.settings.setLanguage('en'));await until(async()=>await stat('Run total').count()===1,'English telemetry labels missing');assert.equal(await stat('Output tokens').innerText(),'—');assert.equal(await numeric('Run total'),1000);await ui.evaluate(()=>window.localAi.settings.setLanguage('ru'));await until(async()=>await stat('Всего за запуск').count()===1,'Russian telemetry labels missing');
 const elapsedBefore=await stat('Прошло').innerText();await until(async()=>await stat('Прошло').innerText()!==elapsedBefore,'Elapsed ticker did not advance during inference');
 held.finish();await finished();assert.equal((await snapshot()).outputTokens,10);assert.equal(await numeric('Всего за запуск'),1010);checks.push('Short Chat displays input-only usage without a placeholder, then sums both reported token metrics');
 const saved=await snapshot();await reopen();assert.equal(await numeric('Выходные токены'),10);assert.equal((await snapshot()).finishedAt,saved.finishedAt);checks.push('Reopening restores the completed snapshot without restarting elapsed time');

 phase='long';steps=[{text:'First part. ',input:1000,output:16000,reason:'length'},{text:'Second part.',input:1200,output:14000,reason:'stop'}];await send('Continue a long answer');await finished();
 let state=await snapshot();assert.equal(state.turn,2);assert.equal(state.inputTokens,2200);assert.equal(state.outputTokens,30000);assert.equal(state.contextUsed,15200);assert.equal(await numeric('Всего за запуск'),32200);checks.push('Auto-continuation adds all segments once; context and cumulative usage differ');

 phase='compaction';await app.evaluate(()=>{const db=global.visualFixture.db,id=global.visualFixture.chat;db.addMessage(id,'assistant','old-marker '+ 'historical data '.repeat(2000));});await reopen();steps=[{text:'After compaction',input:1000,output:10,reason:'stop'}];await send('Use the historical decisions');await finished();state=await snapshot();assert.equal(state.compactions,1);assert.equal(state.turn,2);assert.equal(state.inputTokens,1200);assert.equal(state.outputTokens,18);assert.equal(state.contextUsed,1010);checks.push('Compaction usage is included; the new current context shrinks without clearing run totals');

 phase='document';chunksRead=0;await ui.locator('input[type=file]').setInputFiles(join(root,'large.txt'));await send('Read the whole attached document');await until(()=>Boolean(releaseSummary),'Document summary not held');
 state=await snapshot();assert.equal(state.turn,3);assert.equal(state.actions,1);assert.equal(state.outputTokens,11);assert.equal(state.contextUsed,350);assert.equal(await numeric('Вызовы инструментов'),1);assert.equal(await stat('Выходные токены').innerText(),'11','Show the measured subtotal without an arithmetic placeholder');assert.match(await stat('Всего за запуск').innerText(),/^\d[\d\s,]*$/,'Run total must be a plain measured subtotal');await ui.evaluate(()=>window.localAi.settings.setLanguage('en'));await until(async()=>await stat('Output tokens').count()===1,'English telemetry labels missing');assert.equal(await stat('Output tokens').innerText(),'11');assert.match(await stat('Run total').innerText(),/^\d[\d\s,]*$/,'English run total must not contain arithmetic placeholders');await ui.evaluate(()=>window.localAi.settings.setLanguage('ru'));await until(async()=>await stat('Выходные токены').count()===1,'Russian telemetry labels missing');await ui.screenshot({path:join(root,'document-live-context.png')});releaseSummary();await finished();state=await snapshot();assert.equal(chunksRead,Math.ceil(book.length/24000));assert.equal(state.turn,chunksRead+3);assert.equal(state.inputTokens,350*chunksRead+2200);assert.equal(state.outputTokens,7*chunksRead+22);assert.equal(state.actions,1);checks.push('Large TXT includes every internal summary request and one real read_document call, without counting progress events as calls');

 phase='stop';steps=[{text:'Partial response',input:1000,liveOutput:40,output:200,reason:'length',hold:true}];await send('Stop this response');await until(()=>Boolean(held),'Stop stream not held');await until(async()=>await numeric('Выходные токены')===40,'No live Stop metrics');await ui.getByRole('button',{name:'Остановить',exact:true}).click();await finished();state=await snapshot();assert.equal(state.outputTokens,40);assert(state.finishedAt);await reopen();assert.equal(await numeric('Выходные токены'),40);checks.push('Stop retains last reported usage and duration across reopen');

 phase='unknown';steps=[{text:'No backend usage',reason:'stop',omitUsage:true}];await send('Unknown usage');await finished();assert.equal(await stat('Входные токены').innerText(),'—');assert.equal(await stat('Выходные токены').innerText(),'—');assert.equal(await stat('Всего за запуск').innerText(),'—');assert.match(await ui.locator('.ctx-amount').innerText(),/^—/);checks.push('Missing tokenizer and usage never become estimated or zero-valued metrics');

 phase='agent';steps=[{text:'Hello from Agent.',input:1000,output:10,reason:'stop'}];await ui.evaluate(({chat,project})=>window.localAi.conversations.update(chat,{mode:'agent',workingDirectory:project}),{chat,project});await reopen();await send('Say hello without making changes.');await until(async()=>await numeric('Входные токены')===1000,'Agent telemetry unavailable');await until(async()=>await ui.locator('.send-button.stop').count()===0,'Agent not finished');assert.equal(await numeric('Выходные токены'),10);assert.equal(await numeric('Всего за запуск'),1010);assert(await stat('Ход').count());checks.push('Agent keeps its existing delta-based counters and labels');
 await writeFile(join(root,'result.json'),JSON.stringify({result:'PASS',root,checks,realModel:false},null,2));console.log(JSON.stringify({result:'PASS',root,checks}));
}finally{releaseSummary?.();if(held&&!held.res.destroyed)held.finish();await app?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
