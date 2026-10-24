import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'vite';
import {createServer as createHttpServer} from 'node:http';
import react from '@vitejs/plugin-react';
import {_electron,chromium} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-adaptive-hmr-'),project=await mkdtemp('/tmp/lad-adaptive-react-');
await symlink(resolve('node_modules'),join(project,'node_modules'),'dir');
await writeFile(join(project,'index.html'),'<input id="note"><div id="root"></div><script type="module" src="/App.jsx"></script>');
const component=text=>`import React from 'react';import s from './Card.module.css';export default function Card(){return <button id="sticker" className={s.sticker}>${text}</button>}`;
const css=(radius,width)=>`.sticker{border-radius:${radius}px;width:${width}px;color:rgb(20,30,40)}.sticker:hover{color:rgb(120,30,40)}`;
await writeFile(join(project,'App.jsx'),"import React from 'react';import{createRoot}from'react-dom/client';import Card from './Card.jsx';createRoot(document.getElementById('root')).render(<Card/>);");await writeFile(join(project,'Card.jsx'),component('Original badge'));await writeFile(join(project,'Card.module.css'),css(2,160));
const server=await createServer({configFile:false,root:project,plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[project,resolve('node_modules')]}}});await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`,url=origin+'/index.html?currency=EUR#/it/product/1';
let actions=[],requestCount=0;
const provider=createHttpServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const payload=JSON.parse(Buffer.concat(chunks));
 const summary=payload.messages?.[0]?.content?.startsWith('Create an AGENT CONTINUATION CHECKPOINT');let action;
 if(!summary){requestCount++;action=actions.shift();if(typeof action==='function')action=await action();}
 const delta=action?{tool_calls:[{index:0,id:'hmr-'+requestCount,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:'CSS updated. Live computed radius is 32px at the original URL/viewport. No formal assertion was executed.'};
 res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:action?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
let app,external;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<160;i++){try{if(await fn())return;}catch{/* HMR may replace the execution world. */}await delay(100);}throw Error(label);}
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_AGENT_ENDPOINT:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();const chat=await app.evaluate(()=>global.visualFixture.chat);
 await ui.evaluate(({chat,url})=>window.localAi.visualDebug.open(chat,url),{chat,url});
 const sample=()=>app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{const e=document.querySelector('#sticker');return e?{radius:getComputedStyle(e).borderRadius,width:e.clientWidth,text:e.textContent,url:location.href}:null;}));
 await until(async()=>!!await sample(),'Native React initial render');
 external=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await external.newPage();await page.goto(url);await page.locator('#sticker').waitFor();
 const nativeId=(await app.evaluate(()=>global.visualFixture.info())).id;
 const sessionId=await app.evaluate(()=>global.visualFixture.entry().state.sessionId);
 await ui.evaluate(id=>window.localAi.liveBrowser.workspace(id,{viewport:{width:1920,height:1080},zoom:1,scale:1,pan:{x:120,y:50}}),sessionId);
 const token=await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{globalThis.fixtureIdentity=Math.random();return globalThis.fixtureIdentity;}));
 await writeFile(join(project,'Card.module.css'),css(28,220));
 await until(()=>page.locator('#sticker').evaluate(e=>getComputedStyle(e).borderRadius==='28px'),'External CSS Module HMR');
 if(process.argv.includes('--reproduce')){await delay(1500);console.log(JSON.stringify({root,externalRadius:await page.locator('#sticker').evaluate(e=>getComputedStyle(e).borderRadius),native:await sample()}));}
 else{
 await until(async()=>(await sample())?.radius==='28px','Native CSS Module HMR');
 await writeFile(join(project,'Card.jsx'),component('Updated badge'));await until(async()=>(await sample())?.text==='Updated badge','React Fast Refresh');
 assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>globalThis.fixtureIdentity)),token,'CSS and React HMR must not reload the document');
 await app.evaluate(()=>global.visualFixture.entry().page.locator('#sticker').hover());assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.locator('#sticker').evaluate(e=>getComputedStyle(e).color)),'rgb(120, 30, 40)');
 assert.equal((await sample()).url,url);assert.equal((await app.evaluate(()=>global.visualFixture.info())).id,nativeId);
 await app.evaluate(()=>{const n=global.visualFixture.entry().native,layout=n.layout;global.hmrLayouts=[];n.layout=value=>{global.hmrLayouts.push(value??null);return layout.call(n,value);};});
 await ui.locator('.live-footer .help-trigger').hover();await ui.getByRole('tooltip').waitFor();
 await delay(300);assert(!(await app.evaluate(()=>global.hmrLayouts)).includes(null),'Tooltip must not hide native surface');
 const current=await app.evaluate(()=>global.visualFixture.entry().native.workspaceState());assert.equal(current.settings.viewport.width,1920);assert.equal(current.settings.scale,1);assert.equal(current.settings.pan.x,120);
 // Actual Rust dispatch + Vite CSS update + live observation in the Ledger.
 await ui.evaluate(chat=>window.localAi.conversations.update(chat,{modelId:'qwen3.8:27b-q4_K_M',contextWindow:32768}),chat);
 await ui.evaluate(chat=>window.localAi.chat.setPermissions(chat,'autonomous',true),chat);
 const area=await ui.evaluate(async chat=>{const d=await window.localAi.visualDebug.command(chat,{action:'new-area'});const area=d.issues.at(-1);await window.localAi.visualDebug.command(chat,{action:'selection',enabled:true,groupId:area.id});return area;},chat);
 await app.evaluate(()=>global.visualFixture.drag('#sticker'));await until(async()=>(await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat)).regions.length===1,'Real region capture');
 await ui.evaluate(chat=>window.localAi.visualDebug.command(chat,{action:'selection',enabled:false}),chat);
 const regions=(await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat)).regions;
 await ui.evaluate(({chat,regions})=>window.dispatchEvent(new CustomEvent('visual-region-draft',{detail:{conversationId:chat,regions}})),{chat,regions});
 actions=[['read_file',{path:'Card.module.css'}],['deliverables',{action:'add',id:area.id,text:'Round selected badge',paths:[join(project,'Card.module.css')]}],['replace_text',{path:'Card.module.css',old_text:'border-radius:28px',new_text:'border-radius:32px'}],async()=>{await until(async()=>(await sample())?.radius==='32px','Agent CSS HMR before inspection');return ['web_project',{action:'inspect',selector:'#sticker'}];},['deliverables',{action:'implemented',id:area.id,evidence:'Changed shared CSS and observed radius 32px in the live browser'}]];
 await ui.locator('.composer textarea').fill('Fix the selected radius to 32px and inspect the live computed CSS. Finish with the actual observation; no formal label is requested.');await ui.locator('.send-button:not(.stop)').click();
 await until(async()=>!(await ui.locator('.send-button.stop').count()),'Scripted CSS task must finish');
 const run=await app.evaluate(()=>global.visualFixture.db.listAnalysisRuns(global.visualFixture.chat).at(-1));assert.equal(run.status,'completed');assert.equal(requestCount,6,'Sufficient live CSS evidence must not trigger a formal verification detour');
 const ledger=run.taskPlan.taskMemory.verification;const observation=ledger.records.find(r=>r.outcome==='observed_css');assert(observation,'Vite inspect must enter the actual Ledger despite empty served source hashes');assert.equal(observation.pass,false);assert.equal(observation.inspection.styles['border-radius'],'32px');assert.equal(observation.inspection.sourceBinding,'task_mutations');assert.deepEqual(observation.inspection.viewport,{width:1920,height:1080});assert.equal(observation.inspection.url,url);assert(observation.deliverable_ids.includes(area.id));assert(observation.source_revisions[join(project,'Card.module.css')]);
 await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat);await until(async()=>(await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat)).issues[0].workflow?.state==='completed','Linked CSS task completion');
 await ui.getByRole('button',{name:'Dispute',exact:true}).click();await until(()=>ui.locator('.attachment-draft .visual-region-chip').count(),'Dispute must add composer chip');assert.equal(requestCount,6,'Dispute must not run the agent');
 await writeFile(join(root,'css-ledger.json'),JSON.stringify({status:run.status,requestCount,observation,formalVerified:run.taskPlan.taskMemory.deliverables.items.some(i=>i.status==='verified')},null,2));
 const preserved=await app.evaluate(()=>global.visualFixture.entry().native.workspaceState());assert.equal(preserved.settings.viewport.width,1920);assert.equal(preserved.settings.scale,1);assert.equal(preserved.settings.pan.x,120);assert.equal(preserved.browserZoom,1);assert.equal((await app.evaluate(()=>global.visualFixture.info())).id,nativeId);
 // Fault injection: deny HMR reconnect on the same Page, preserving the actual HTTP dev server.
 await app.evaluate(async()=>{const p=global.visualFixture.entry().page;await p.context().routeWebSocket('**/*',s=>s.close());await p.reload();await p.locator('#note').fill('UNSAVED');});
 await writeFile(join(project,'Card.module.css'),css(36,240));await until(()=>page.locator('#sticker').evaluate(e=>getComputedStyle(e).borderRadius==='36px'),'External browser remains current');
 await until(()=>app.evaluate(()=>global.visualFixture.entry().state.freshness?.status==='possibly-stale'),'Missing HMR must warn about stale page');assert.equal((await sample()).radius,'32px');assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.locator('#note').inputValue()),'UNSAVED','No automatic form-destroying reload');
 await ui.locator('.live-address').getByRole('button',{name:'Refresh',exact:true}).click();await until(async()=>(await sample())?.radius==='36px','Explicit reload must recover actual CSS');assert.equal((await app.evaluate(()=>global.visualFixture.info())).id,nativeId);
 const result={result:'PASS',root,url,native:await sample(),nativeId,checks:['Rust scripted CSS patch + HMR + scoped Ledger observation + no formal-detour + completion/dispute','CSS Modules radius/width HMR','React update','same Page route/query/hash and workspace','tooltip without hiding surface','hover and no document reload during CSS/React HMR','blocked HMR warning preserves unsaved input; explicit reload restores CSS']};await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }
}finally{await external?.close();await app?.close();await server.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));}
