import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,symlink,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer as httpServer} from 'node:http';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {_electron} from 'playwright-core';
const baseline=process.argv.includes('--baseline'),resume=process.argv.includes('--resume'),dpr2=process.argv.includes('--dpr2');
const root=await mkdtemp('/tmp/lad-fresh-evidence-'),project=await mkdtemp('/tmp/lad-fresh-react-');
await symlink(resolve('node_modules'),join(project,'node_modules'),'dir');
await writeFile(join(project,'index.html'),'<div id="root"></div><script type="module" src="/App.jsx"></script>');
const component=(key=0,text='Purchase summary')=>`import React from 'react';import{createRoot}from'react-dom/client';import s from './Card.module.css';createRoot(document.getElementById('root')).render(<main><aside data-version="${key}" key={${key}} className={s.summaryCard}>${text}<input type="password" value="PRIVATE_FIXTURE_TOKEN" readOnly/></aside></main>);`;
await writeFile(join(project,'App.jsx'),component());
const pink='body{margin:0;min-height:2200px}main{padding:40px}.summaryCard{width:320px;height:160px;border-radius:2px;background:#ffe4e6}';
await writeFile(join(project,'Card.module.css'),pink);
await writeFile(join(project,'notes.txt'),Array.from({length:400},(_,i)=>createHash('sha256').update(String(i)).digest('hex')).join('\n'));
const vite=await createServer({configFile:false,root:project,plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[project,resolve('node_modules')]}}});await vite.listen();
const url=`http://127.0.0.1:${vite.httpServer.address().port}/?#/it/product/1`;
let actions=[],calls=0,payloads=[],providerError,held=false;
const provider=httpServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));await writeFile(join(root,`payload-${payloads.length}.json`),JSON.stringify(body,null,2));payloads.push(body);
 const summary=body.messages?.[0]?.content?.startsWith('Create an AGENT CONTINUATION CHECKPOINT');let action;if(!summary){calls++;action=actions.shift();if(typeof action==='function')action=await action();}
 if(action==='hold'){held=true;res.writeHead(200,{'content-type':'text/event-stream'});res.write(': held inference\n\n');return;}
 const delta=summary?{content:'Original pink selection is historical. Retain latest fresh computed styles and original route/viewport.'}:action?{tool_calls:[{index:0,id:'fresh-'+calls,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:'Changed the CSS background to white. The current scoped DOM inspection reports rgb(255, 255, 255). This is a CSS observation, not formal Verified or Vision.'};
 res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:action?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');}catch(e){providerError=e;res.writeHead(500);res.end('Fixture provider error');}});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const delay=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label){for(let i=0;i<200;i++){try{if(await fn())return;}catch{/* HMR may replace the execution world. */}await delay(100);}throw Error(label);}
let app;
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs'),...(dpr2?['--force-device-scale-factor=2']:[])],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_AGENT_ENDPOINT:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();const chat=await app.evaluate(()=>global.visualFixture.chat);
 await ui.evaluate(({chat,url})=>window.localAi.visualDebug.open(chat,url),{chat,url});
 if(await ui.locator('.live-manual-open').isVisible())await ui.locator('.live-manual-open').click();
 const sample=()=>app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{const e=document.querySelector('aside');return e&&{background:getComputedStyle(e).backgroundColor,selector:'aside.'+e.className,rect:e.getBoundingClientRect().toJSON(),url:location.href,viewport:{width:innerWidth,height:innerHeight}};}));
 await until(async()=>(await sample())?.background==='rgb(255, 228, 230)','Initial pink');
 const nativeId=(await app.evaluate(()=>global.visualFixture.info())).id,sessionId=await app.evaluate(()=>global.visualFixture.entry().state.sessionId);
 await ui.evaluate(id=>window.localAi.liveBrowser.workspace(id,{viewport:{width:1920,height:1080},zoom:1,scale:'fit',pan:{x:0,y:0}}),sessionId);
 const area=await ui.evaluate(async chat=>{const d=await window.localAi.visualDebug.command(chat,{action:'new-area'});const area=d.issues.at(-1);await window.localAi.visualDebug.command(chat,{action:'selection',enabled:true,groupId:area.id});return area;},chat);
 await app.evaluate(()=>global.visualFixture.drag('aside'));await until(async()=>(await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat)).regions.length===1,'Region saved');
 await ui.evaluate(chat=>window.localAi.visualDebug.command(chat,{action:'selection',enabled:false}),chat);
 const original=(await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat)).regions[0],before=await sample(),selector=before.selector;
 const inspect=sel=>app.evaluate((_,sel)=>global.visualFixture.session.execute({action:'inspect',selector:sel},new AbortController().signal,async()=>({approved:true,reason:"once"})),sel);
 if(baseline){await writeFile(join(project,'Card.module.css'),pink.replace('#ffe4e6','#ffffff'));await until(async()=>(await sample())?.background==='rgb(255, 255, 255)','HMR white');const result=await inspect(selector);await writeFile(join(root,'baseline-raw.json'),JSON.stringify(result,null,2));assert.equal(result.inspection?.matches,0,JSON.stringify(result));await writeFile(join(root,'baseline.json'),JSON.stringify({before,after:await sample(),oldSelector:selector,result},null,2));console.log(JSON.stringify({result:'REPRODUCED',root,matches:result.inspection.matches}));}
 else{
 await ui.evaluate(chat=>window.localAi.conversations.update(chat,{modelId:'qwen3.8:27b-q4_K_M',contextWindow:32768}),chat);await ui.evaluate(chat=>window.localAi.chat.setPermissions(chat,'autonomous',true),chat);
 await ui.evaluate(({chat,original})=>window.dispatchEvent(new CustomEvent('visual-region-draft',{detail:{conversationId:chat,regions:[original]}})),{chat,original});
 actions=[['read_file',{path:'Card.module.css'}],['deliverables',{action:'add',id:area.id,text:'White purchase card background',paths:[join(project,'Card.module.css')],check:'runtime'}],['replace_text',{path:'Card.module.css',old_text:'#ffe4e6',new_text:'#ffffff'}],async()=>{await until(async()=>(await sample())?.background==='rgb(255, 255, 255)','Real HMR');return ['web_project',{action:'inspect',selector}];},['deliverables',{action:'implemented',id:area.id,evidence:'Changed CSS and inspected the current white background at original conditions'}]];
 if(resume)actions.splice(4,1,['read_file',{path:'notes.txt'}],'hold');
 await ui.locator('.composer textarea').fill('Change the selected pink background to white; check the actual current CSS and finish.');await ui.locator('.send-button:not(.stop)').click();
 if(resume){await until(()=>held,'Held after fresh observation');const first=await app.evaluate(()=>global.visualFixture.db.listAnalysisRuns(global.visualFixture.chat).at(-1));await ui.locator('.send-button.stop').click();await until(async()=>!(await ui.locator('.send-button.stop').count()),'Stopped');await ui.evaluate(chat=>window.localAi.conversations.update(chat,{contextWindow:36864}),chat);await ui.reload();await ui.locator('.chat-select').filter({hasText:'Visual Debugging demo'}).click();await ui.locator('.task-selector select').selectOption(first.logicalTaskId);actions=[['read_file',{path:'notes.txt'}],['web_project',{action:'inspect',selector}],['deliverables',{action:'implemented',id:area.id,evidence:'Current white background confirmed after resume'}]];await ui.locator('.composer textarea').fill('Continue the stopped task. Use current browser CSS; the original pink capture is historical.');await ui.locator('.send-button:not(.stop)').click();await until(async()=>!(await ui.locator('.send-button.stop').count()),'Resumed completion');const continued=await app.evaluate(()=>global.visualFixture.db.listAnalysisRuns(global.visualFixture.chat).at(-1));assert.equal(continued.logicalTaskId,first.logicalTaskId);assert(payloads.some(p=>p.messages?.[0]?.content?.startsWith('Create an AGENT CONTINUATION CHECKPOINT')),'Real compaction must be exercised');}
 await until(async()=>calls>=6&&!(await ui.locator('.send-button.stop').count()),'Run completes');assert(!providerError,String(providerError));
 // Vite may bind the served JSX source without an exact CSS source revision.
 // The unchanged Gate may then make one bounded review; observed_css remains
 // unverified. Do not force a six-request transcript by weakening source proof.
 if(!resume)assert(calls===6||calls===7,`Expected direct completion or one bounded source-coverage review, received ${calls} requests`);
 const run=await app.evaluate(()=>global.visualFixture.db.listAnalysisRuns(global.visualFixture.chat).at(-1));assert.equal(run.status,'completed');const observation=run.taskPlan.taskMemory.verification.records.find(r=>r.outcome==='observed_css');assert.equal(observation?.inspection.styles['background-color'],'rgb(255, 255, 255)');assert.equal(observation.pass,false);
 const after=await sample();assert.notEqual(after.selector,selector,'Actual CSS Modules hash changes');
 const files=[];async function walk(p){for(const e of await readdir(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())await walk(f);else if(e.name.startsWith('obs-')&&e.name.endsWith('.txt'))files.push(f);}}await walk(join(root,'app-data','agent-evidence'));
 let sourceRevisionBefore;const raw=[];for(const f of files){const body=JSON.parse(await readFile(f,'utf8'));if(body.path?.endsWith('Card.module.css')&&body.source_revision)sourceRevisionBefore??=body.source_revision;if(body.inspection)raw.push({file:f,body});}assert(raw.some(r=>r.body.inspection.elements?.[0]?.styles?.['background-color']==='rgb(255, 255, 255)'));
 // The full result is immutable in observation storage. In a small context,
 // task inference receives its bounded Ledger projection, not necessarily the
 // complete tool JSON. Verify the actual current facts in that task payload.
 const current=raw.find(r=>r.body.inspection.elements?.[0]?.styles?.['background-color']==='rgb(255, 255, 255)').body;
 const taskMessages=payloads.filter(p=>!p.messages?.[0]?.content?.startsWith('Create an AGENT CONTINUATION CHECKPOINT')).flatMap(p=>p.messages).map(m=>m.content).filter(s=>typeof s==='string');
 assert(taskMessages.some(text=>text.includes('Live CSS facts:')&&text.includes('"background-color":"rgb(255, 255, 255)"')&&text.includes(current.inspection.observedAt)&&text.includes('"provenance":"current-browser-observation"')),'Fresh CSS facts must reach task inference, including after tool projection');
 if(resume)assert(JSON.stringify(payloads.at(-1)).includes('rgb(255, 255, 255)'),'Final resumed inference must retain actual white CSS');assert.equal(current.provenance.kind,'current-browser-observation');assert(current.inspection.anchorResolution.rebound);
 assert(payloads[0].messages.some(m=>typeof m.content==='string'&&m.content.includes('ORIGINAL ISSUE EVIDENCE')));assert(!JSON.stringify(payloads).includes('PRIVATE_FIXTURE_TOKEN'));assert(!JSON.stringify(payloads).includes('image_url'));
 const stored=(await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat)).regions[0];assert.deepEqual(stored.anchors,original.anchors,'Original capture must remain immutable');
 const screenshot=await app.evaluate(()=>global.visualFixture.session.execute({action:'screenshot',analyze:false},new AbortController().signal,async()=>({approved:true,reason:"once"})));assert.equal(screenshot.pixels_available_to_task_model,false);assert.equal(screenshot.visual.analyzed,false);assert(screenshot.capture.capturedAt);
 const missing=await inspect('aside.does-not-exist');assert.equal(missing.code,'ELEMENT_NOT_FOUND');assert.equal(missing.retrySameArguments,false);
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{const e=document.querySelector('aside');e.after(e.cloneNode(true));}));const ambiguous=await inspect(selector);assert.equal(ambiguous.code,'STALE_DOM_ANCHOR');assert(!ambiguous.inspection.anchorResolution.selector,'Duplicated targets must not be rebound');
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>document.querySelectorAll('aside')[1].remove()));
 await writeFile(join(project,'App.jsx'),component(1));await until(async()=>(await sample())?.background==='rgb(255, 255, 255)','React refresh');await until(()=>app.evaluate(()=>!!global.visualFixture.entry().native.contents.executeJavaScript), 'Live native contents');await app.evaluate(()=>global.visualFixture.entry().page.locator('aside[data-version="1"]').waitFor());const refreshed=await inspect(selector);assert.equal(refreshed.inspection.elements[0].styles['background-color'],'rgb(255, 255, 255)');
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{document.querySelector('aside').style.backgroundColor='#ffe4e6';}));
 await app.evaluate(()=>{const s=global.visualFixture.session,read=s.read.bind(s);s.read=async()=>{s.read=read;await global.visualFixture.entry().page.evaluate(()=>{document.querySelector('aside').style.backgroundColor='';window.__ladHmrAt=Date.now()+1;});return read();};});
 const raced=await inspect(selector);assert.equal(raced.inspection.elements[0].styles['background-color'],'rgb(255, 228, 230)');assert.equal(raced.code,'BROWSER_OBSERVATION_CHANGED');assert.equal(raced.freshness.status,'possibly-stale');const stable=await inspect(selector);assert.equal(stable.inspection.elements[0].styles['background-color'],'rgb(255, 255, 255)');
 assert.equal((await app.evaluate(()=>global.visualFixture.info())).id,nativeId);
 const result={result:'PASS',provider:'scripted',resume,dpr2,compactions:payloads.filter(p=>p.messages?.[0]?.content?.startsWith('Create an AGENT CONTINUATION CHECKPOINT')).length,root,project,regionId:original.id,originalEvidence:{createdAt:original.createdAt,snapshot:original.snapshot,crop:original.crop,sourceHints:original.sourceHints,provenance:'historical-user-selection'},sourceRevisionBefore,nativeId,before,after,inspection:current.inspection,ledger:observation,requests:calls,payloadCount:payloads.length,checks:['CSS Modules changed hash resolved with bounded identity','Immutable original SQLite snapshot','Live Native CSS equals tool, observation file, inference and Ledger','No pixels under Vision Off','Missing/ambiguous anchor refusals','React refresh same Page','Original URL/viewport','No private input values']};await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({result:'PASS',root,requests:calls}));
 }
}finally{await app?.close();await vite.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));}
