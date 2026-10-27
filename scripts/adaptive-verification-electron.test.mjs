import assert from 'node:assert/strict';
import{createHash}from'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-adaptive-policy-'),project=await mkdtemp('/tmp/lad-adaptive-policy-project-');
await writeFile(join(project,'index.html'),'<style>#badge{border-radius:2px;width:160px;height:45px}</style><button id="badge">3 al prezzo di 1</button><input type=password value=PRIVATE-SECRET><textarea>PRIVATE-TEXTAREA</textarea><div data-private>PRIVATE-NODE</div>');
await writeFile(join(project,'notes.txt'),Array.from({length:400},(_,i)=>`${i} ${createHash('sha256').update(String(i)).digest('hex')}`).join('\n'));
let app,queue=[],holdCount=0;const requests=[],checks=[];
const frame=(delta,reason)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:reason}]})}\n\n`;
const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const payload=JSON.parse(Buffer.concat(chunks));requests.push(payload);res.writeHead(200,{'content-type':'text/event-stream'});
 if(payload.messages?.[0]?.content?.startsWith('Create an AGENT CONTINUATION CHECKPOINT')){res.end(frame({content:'Retain scoped task evidence, screenshot budget is runtime owned; verification incomplete.'},'stop')+'data: [DONE]\n\n');return;}
 const action=queue.shift();if(action==='hold'){holdCount++;res.write(': waiting\n\n');return;}
 res.end((action?frame({tool_calls:[{index:0,id:'adaptive-'+requests.length,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]},'tool_calls'):frame({content:'Changes retained; report actual evidence and remaining verification limits.'},'stop'))+'data: [DONE]\n\n');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const delay=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label){for(let i=0;i<600;i++){if(await fn())return;await delay(60);}throw Error(label);}
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_AGENT_ENDPOINT:`http://127.0.0.1:${server.address().port}/v1/chat/completions`}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();const chat=await app.evaluate(()=>global.visualFixture.chat);
 const doc=()=>ui.evaluate(id=>window.localAi.visualDebug.document(id),chat),cmd=command=>ui.evaluate(({chat,command})=>window.localAi.visualDebug.command(chat,command),{chat,command});
 const send=async text=>{await ui.locator('.composer textarea').fill(text);await ui.locator('.send-button:not(.stop)').click();};
 const done=()=>until(async()=>!(await ui.locator('.send-button.stop').count()),'Run did not finish');
 const lastRun=()=>app.evaluate(()=>global.visualFixture.db.listAnalysisRuns(global.visualFixture.chat).at(-1));
 const count=task=>app.evaluate((_,task)=>global.visualFixture.db.taskScreenshotCount(global.visualFixture.chat,task),task);
 await ui.evaluate(id=>window.localAi.conversations.update(id,{modelId:'qwen3.8:27b-q4_K_M',contextWindow:32768}),chat);
 await ui.evaluate(id=>window.localAi.chat.setPermissions(id,'autonomous',true),chat);await ui.evaluate(id=>window.localAi.visualDebug.open(id,'index.html?lang=it#/it/product/1'),chat);
 if(await ui.locator('.live-manual-open').isVisible())await ui.locator('.live-manual-open').click();
 const nativeId=(await app.evaluate(()=>global.visualFixture.info())).id;
 assert.equal(await ui.evaluate(id=>window.localAi.browserQa.status(id),chat).then(v=>v.autonomous),true,'New chat verification defaults on');
 await cmd({action:'new-area'});let area=(await doc()).issues[0];await cmd({action:'selection',enabled:true,groupId:area.id});await app.evaluate(()=>global.visualFixture.drag('#badge'));await until(async()=>(await doc()).regions.length===1,'Region creation');await cmd({action:'selection',enabled:false});
 const region=(await doc()).regions[0];
 await ui.evaluate(({chat,regions})=>window.dispatchEvent(new CustomEvent('visual-region-draft',{detail:{conversationId:chat,regions}})),{chat,regions:[region]});
 queue=[['deliverables',{action:'add',id:area.id,text:'Badge rounding',paths:[join(project,'index.html')]}],['read_file',{path:'index.html'}],['replace_text',{path:'index.html',old_text:'border-radius:2px',new_text:'border-radius:28px'}],['deliverables',{action:'implemented',id:area.id,evidence:'Changed shared badge CSS in index.html'}]];
 await send('Correct the selected badge radius in index.html. Report verification limits honestly.');await done();
 assert.equal((await lastRun()).status,'completed');await until(async()=>(await doc()).issues[0].workflow?.state==='completed','Successful related patch should complete area');
 assert((await requests.filter(p=>p.tools).map(p=>JSON.stringify(p)).join('\n')).includes('Adaptive verification:'));
 checks.push('ON instruction reaches actual inference; related completed patch completes issue without forging Verified');
 await cmd({action:'display'});const faded=await app.evaluate(async()=>{const e=global.visualFixture.entry();await e.native.contents.debugger.sendCommand('DOM.enable');const{root}=await e.native.contents.debugger.sendCommand('DOM.getDocument',{depth:-1,pierce:true});const nodes=[];const visit=n=>{if((n.attributes??[]).includes('data-region-id'))nodes.push(n.attributes);for(const c of [...(n.children??[]),...(n.shadowRoots??[])])visit(c);};visit(root);return nodes;});assert(JSON.stringify(faded).includes('0.35'),'Completed overlay is dimmed');
 await ui.getByRole('button',{name:'Dispute',exact:true}).click();await until(async()=>(await doc()).issues[0].workflow?.state==='disputed','Dispute persisted');await ui.locator('.composer .visual-region-chip').first().waitFor();assert.equal((await lastRun()).status,'completed','Dispute must not start agent');
 await cmd({action:'workflow',issueId:area.id,state:'completed'});await ui.reload();await ui.locator('.chat-select').filter({hasText:'Visual Debugging demo'}).click();assert.equal((await doc()).issues[0].workflow.state,'completed');
 checks.push('Dimmed actual DOM overlay; Dispute restores state and composer chip without run; manual acceptance survives reload');
 await ui.evaluate(id=>window.localAi.browserQa.configure('off',false,true,id),chat);const start=requests.length;
 queue=[['web_project',{action:'inspect',selector:'body'}]];await send('Explicitly inspect the computed border radius even with verification instruction off.');await done();
 const off=requests.slice(start).filter(p=>p.tools);assert(off.length);assert(off.every(p=>!JSON.stringify(p).includes('Adaptive verification:')));assert(off[0].tools.some(t=>t.function.name==='web_project'));assert(JSON.stringify(off).includes('border-radius'));assert(!JSON.stringify(off).includes('PRIVATE-'),'DOM read/inspect must exclude private controls and descendant text');
 checks.push('OFF removes additional policy while browser inspect remains available for explicit checks');
 // Eight explicit requests, same task after Stop/Continue; neither manual crops nor QA consumes this counter.
 const second=await cmd({action:'new-area'});const activeArea=second.issues.at(-1);await cmd({action:'selection',enabled:true,groupId:activeArea.id});await app.evaluate(()=>global.visualFixture.drag('#badge'));await until(async()=>(await doc()).regions.length===2,'Second active area');await cmd({action:'selection',enabled:false});
 queue=[...Array.from({length:8},()=>['web_project',{action:'screenshot',selector:'#badge',analyze:false}]),['read_file',{path:'notes.txt'}],'hold'];const holds=holdCount;
 await send('Capture the badge eight times for this bounded budget fixture, then wait.');await until(()=>holdCount>holds,'Screenshot sequence did not reach held inference');const stopped=await lastRun();assert.equal(await count(stopped.logicalTaskId),8);
 // Keep room for the complete public tool schema while crossing the proactive
 // compaction threshold; a too-small context fails before a screenshot call.
 await ui.locator('.send-button.stop').click();await done();await ui.evaluate(id=>window.localAi.conversations.update(id,{contextWindow:28672}),chat);await ui.reload();await ui.locator('.chat-select').filter({hasText:'Visual Debugging demo'}).click();await ui.locator('.task-selector select').selectOption(stopped.logicalTaskId);assert.equal((await lastRun()).status,'interrupted');assert.notEqual((await doc()).issues.find(i=>i.id===activeArea.id).workflow?.state,'completed');
 queue=[['web_project',{action:'screenshot',selector:'#badge',analyze:false}],['web_project',{action:'inspect',selector:'#badge'}]];
 await ui.locator('.composer textarea').fill('Continue the stopped screenshot task; use CSS inspection if the budget is exhausted.');await ui.locator('.send-button:not(.stop)').click();await done();const resumed=await lastRun();assert.equal(resumed.logicalTaskId,stopped.logicalTaskId);assert.equal(await count(resumed.logicalTaskId),8);assert(resumed.actions.some(a=>a.state==='error'&&JSON.stringify(a).includes('SCREENSHOT_LIMIT')));
 checks.push('Eight persisted screenshots; ninth refused across real Stop/Continue; CSS alternative remains usable');
 queue=[['web_project',{action:'screenshot',selector:'#badge',analyze:false}]];await send('A new independent screenshot task.');await done();const fresh=await lastRun();assert.notEqual(fresh.logicalTaskId,stopped.logicalTaskId);assert.equal(await count(fresh.logicalTaskId),1);
 assert.equal((await app.evaluate(()=>global.visualFixture.info())).id,nativeId);
 const qa=await app.evaluate(async()=>{const f=global.visualFixture;return f.session.execute({action:'qa',scenarios:[{id:'radius',goal:'Computed radius',target:'index.html?lang=it#/it/product/1',viewport:{width:1920,height:1080},preconditions:[],required_state:[],steps:[],assertion:{source:'style',selector:'#badge',path:'border-top-left-radius',operator:'equals',expected:'28px'},timeout_ms:5000}]},new AbortController().signal,async()=>({approved:true,reason:'once'}));});await writeFile(join(root,'style-qa.json'),JSON.stringify(qa,null,2));assert.equal(qa.qa?.status,'Verified',JSON.stringify(qa));assert.equal(await count(fresh.logicalTaskId),1);
 checks.push('New logical task receives new budget on same Page; computed-style QA passes without consuming explicit captures');
 await app.close();app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_AGENT_ENDPOINT:`http://127.0.0.1:${server.address().port}/v1/chat/completions`}});const restarted=await app.firstWindow();await restarted.locator('.conversation').waitFor();
 const restored=await app.evaluate((_,{chat,oldTask,newTask})=>{const db=global.visualFixture.db;const another=db.createConversation();const anotherTask=db.resolveLogicalTask(another.id);return {old:db.taskScreenshotCount(chat,oldTask),fresh:db.taskScreenshotCount(chat,newTask),crossChat:db.takeTaskScreenshot(another.id,oldTask),independent:db.takeTaskScreenshot(another.id,anotherTask)};},{chat,oldTask:stopped.logicalTaskId,newTask:fresh.logicalTaskId});assert.deepEqual(restored,{old:8,fresh:1,crossChat:false,independent:true});
 checks.push('Actual process restart preserves both task counters; cross-chat task use refused, independent chat has own budget');
 assert(requests.some(p=>p.messages?.[0]?.content?.startsWith('Create an AGENT CONTINUATION CHECKPOINT')),'Fixture must exercise actual compaction');
 const result={result:'PASS',root,project,checks,requests:requests.length,compactions:requests.filter(p=>!p.tools).length,nativeId};await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error('Evidence:',root);if(app)try{await writeFile(join(root,'events.json'),JSON.stringify(await app.evaluate(()=>global.visualFixture.events),null,2));await writeFile(join(root,'ui.txt'),await(await app.firstWindow()).locator('body').innerText());}catch{/* Preserve failure. */}throw error;}finally{await app?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
