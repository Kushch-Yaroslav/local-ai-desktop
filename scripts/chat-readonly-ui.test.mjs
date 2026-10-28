// Production renderer, controlled IPC events; no inference or user runtime.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-chat-readonly-ui-'),project=await mkdtemp('/tmp/lad-chat-readonly-ui-project-');
await writeFile(join(project,'index.html'),'<title>Unused fixture</title>');let app;
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();const chat=await app.evaluate(()=>global.visualFixture.chat);
 await ui.evaluate(async chat=>{await window.localAi.conversations.update(chat,{modelId:'qwen3.8:27b-q4_K_M',mode:'chat',contextWindow:32768,llamaKvCacheType:'f16',workingDirectory:null,secondaryWorkingDirectory:null,webMode:'off'});await window.localAi.settings.setLanguage('ru');},chat);await ui.reload();await ui.locator('.composer textarea').waitFor();
 await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('chat:send');ipcMain.handle('chat:send',(event,request)=>new Promise(resolve=>{global.sourceUi={event,request,resolve};}));});
 await ui.locator('.composer textarea').fill('Read the attached fixture');await ui.locator('.composer textarea').press('Enter');
 for(let n=0;n<100;n++){if(await app.evaluate(()=>Boolean(global.sourceUi)))break;await new Promise(r=>setTimeout(r,50));}assert(await app.evaluate(()=>Boolean(global.sourceUi)));
 const emit=activity=>app.evaluate((_,activity)=>{const {event,request}=global.sourceUi;event.sender.send('chat:stream',{type:'tool',activity,conversationId:request.conversationId,generationId:request.generationId});},activity);
 await emit({id:'reading-fixture',kind:'file_read',label:'Чтение файла',detail:'Прочитано 38% документа · Глава 10',state:'running',metadata:{documentReading:true}});
 await ui.getByRole('status',{name:'Чтение файла · Прочитано 38% документа · Глава 10',exact:true}).waitFor();await ui.screenshot({path:join(root,'reading-progress.png')});
 await emit({id:'reading-fixture',kind:'file_read',label:'Чтение файла',detail:'Confirmed offset preserved',state:'error',metadata:{chatSource:true}});
 await ui.getByRole('status',{name:'Обработка источника не завершена · Confirmed offset preserved',exact:true}).waitFor();await ui.screenshot({path:join(root,'source-error.png')});
 await app.evaluate(()=>{const {event,request,resolve}=global.sourceUi;event.sender.send('chat:stream',{type:'cancelled',conversationId:request.conversationId,generationId:request.generationId});resolve();});
 await writeFile(join(root,'result.json'),JSON.stringify({result:'PASS',root,realInference:false,progressAndChapterVisible:true,sourceErrorVisible:true},null,2));console.log(JSON.stringify({result:'PASS',root,progressAndChapterVisible:true,sourceErrorVisible:true}));
}finally{await app?.close();}
