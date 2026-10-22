import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-grounding-');const project=await mkdtemp('/tmp/lad-visual-project-');
await writeFile(join(project,'index.html'),`<!doctype html><style>body{margin:20px;font:16px sans-serif}.broken{display:block;width:90px;white-space:nowrap;overflow:hidden;margin-bottom:20px}canvas{display:block;width:180px;height:60px;background:#22d3ee}section{height:1300px}#lower{margin-top:800px}</style><button id="overflow" class="broken">A very long overflowing button label</button><button id="sibling" class="broken">Another overflowing reusable button</button><canvas></canvas><input type="password" value="PRIVATE-PASSWORD"><input value="PRIVATE-INPUT"><section><button id="lower">Lower page target</button></section>`);
let app;const requests=[];let queue=[],step=0;
const frame=(delta,reason)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:reason}]})}\n\n`;
const server=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const request=JSON.parse(Buffer.concat(chunks));requests.push(request);let action=queue[step++];if(typeof action==='function')action=await action();res.writeHead(200,{'Content-Type':'text/event-stream'});res.end((action?frame({tool_calls:[{index:0,id:'visual-'+step,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]},'tool_calls'):frame({content:'The shared button rule was fixed and the scoped DOM layout criterion was checked. No Vision analysis was performed.'},'stop'))+'data: [DONE]\n\n');}catch(error){console.error(error);res.writeHead(500);res.end(String(error));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${server.address().port}/v1/chat/completions`;

try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project,LOCAL_AI_AGENT_ENDPOINT:endpoint}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();
 await ui.locator('.live-manual-open').click();await ui.waitForFunction(()=>document.querySelector('.live-address')?.textContent.includes('project-preview.invalid'));
 const chat=await app.evaluate(()=>global.visualFixture.chat);
 const command=cmd=>ui.evaluate(({chat,cmd})=>window.localAi.visualDebug.command(chat,cmd),{chat,cmd});
 const info=()=>app.evaluate(()=>global.visualFixture.info());
 const waitRegions=async n=>{for(let i=0;i<150;i++){const d=await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat);if(d.regions.length===n)return;await new Promise(r=>setTimeout(r,100));}throw Error('Regions not saved: '+JSON.stringify(await info()));};
 await app.evaluate(async()=>{for(let i=0;i<150;i++){if(global.visualFixture.entry()?.state.ownership==='user')return;await new Promise(r=>setTimeout(r,100));}throw Error('Manual preview did not become user-owned');});
 let before=await info();assert.equal(before.pageCount,1);assert.equal(before.ownership,'user');
 await ui.locator('.live-manual-open').click();assert.equal((await info()).id,before.id,'Manual re-open reuses Native Page');
 await command({action:'selection',enabled:true,groupId:'group-1'});
 await app.evaluate(()=>global.visualFixture.entry().page.keyboard.press('Escape'));
 for(let i=0;i<30;i++){if(!(await info()).snapshot.overlay)break;await new Promise(r=>setTimeout(r,50));}assert.equal((await info()).snapshot.overlay,false,'Escape exits the native overlay');
 await command({action:'selection',enabled:true,groupId:'group-1'});
 await app.evaluate(()=>global.visualFixture.drag('#overflow'));
 await waitRegions(1);
 let doc=(await info()).regions;assert.equal(doc.regions[0].anchors[0].selector,'#overflow');assert(doc.regions[0].screenshotPath);assert(!JSON.stringify(doc).includes('PRIVATE-'));
 const region1=doc.regions[0];assert((await readFile(region1.screenshotPath)).length>100);
 await app.evaluate(()=>global.visualFixture.drag('#sibling'));
 await waitRegions(2);
 doc=(await info()).regions;const region2=doc.regions[1];assert.equal(doc.issues.length,1);
 await command({action:'group',regionIds:[region2.id],groupId:'group-2'});assert.equal((await info()).regions.issues.length,2);
 await command({action:'group',regionIds:[region1.id,region2.id],groupId:'shared-buttons'});assert.equal((await info()).regions.issues.length,1);
 await command({action:'selection',enabled:true,groupId:'canvas'});await app.evaluate(()=>global.visualFixture.drag('canvas'));
 await waitRegions(3);
 doc=(await info()).regions;const canvas=doc.regions.at(-1);assert.equal(canvas.anchors.length,0,'Canvas remains screenshot-only');
 await command({action:'delete',regionId:canvas.id});assert.equal((await info()).regions.regions.length,2);
 // Actual browser zoom changes CSS geometry/DPR; password pixels must be masked.
 await app.evaluate(()=>global.visualFixture.entry().native.contents.setZoomFactor(1.25));
 await command({action:'selection',enabled:true,groupId:'private-control'});await app.evaluate(()=>global.visualFixture.drag('input[type=password]'));await waitRegions(3);
 const privateRegion=(await info()).regions.regions.at(-1);assert(privateRegion.dpr>1);assert(!JSON.stringify(privateRegion).includes('PRIVATE-'));
 const pixel=await app.evaluate(({nativeImage},path)=>{const image=nativeImage.createFromPath(path),size=image.getSize(),bytes=image.toBitmap();const offset=(Math.floor(size.height/2)*size.width+Math.floor(size.width/2))*4;return Array.from(bytes.subarray(offset,offset+4));},privateRegion.screenshotPath);assert.deepEqual(pixel,[255,0,255,255],'Private input crop is masked magenta');
 await command({action:'delete',regionId:privateRegion.id});await app.evaluate(()=>global.visualFixture.entry().native.contents.setZoomFactor(1));
 // Scroll while selection is active and ground document, not screen, geometry.
 await command({action:'selection',enabled:true,groupId:'lower'});
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>scrollTo(0,650)));
 await app.evaluate(()=>global.visualFixture.drag('#lower'));
 await waitRegions(3);
 doc=(await info()).regions;assert(doc.regions.at(-1).scroll.y>=600);assert(doc.regions.at(-1).rect.y>600);
 await command({action:'selection',enabled:false});assert.equal((await info()).snapshot.overlay,false);
 await app.evaluate(()=>global.visualFixture.window.setContentSize(1200,900));
 await command({action:'reveal',regionId:region1.id});assert.equal((await info()).snapshot.overlay,true);
 await command({action:'selection',enabled:false});
 const detected=await command({action:'detect'});assert(detected.regions.some(r=>r.groupId.startsWith('auto-')));assert(detected.issues.every(i=>i.status==='Detected'));assert(detected.regions.length<=15);
 // UI draft references, no JSON/base64 in the textarea.
 await ui.waitForFunction(()=>document.querySelectorAll('.visual-region-list>div').length>=2);
 await ui.getByRole('checkbox',{name:`Select ${region1.id}`,exact:true}).check();
 await ui.getByRole('button',{name:'To chat → agent',exact:true}).click();
 assert(await ui.locator('.composer .visual-region-chip').count()||await ui.locator('.attachment-draft .visual-region-chip').count());
 assert(!(await ui.locator('textarea').first().inputValue()).includes('base64'));
 // Persist immutable reference snapshots separately from text, then reload renderer.
 await app.evaluate((_,region)=>{const f=global.visualFixture;f.db.addMessage(f.chat,'user','Please fix this button','visual-message');f.db.setRegionReferences('visual-message',f.chat,[region]);},region1);
 await command({action:'selection',enabled:true,groupId:'restart'});
 await ui.reload();await ui.locator('.chat-select').filter({hasText:'Visual Debugging demo'}).click();
 assert.equal((await info()).snapshot.overlay,false,'Renderer navigation clears the overlay');
 await ui.locator('.message .visual-region-chip').first().waitFor().catch(()=>ui.locator('.visual-region-chip').first().waitFor());
 const persisted=await app.evaluate(()=>global.visualFixture.db.getMessage('visual-message'));assert.equal(persisted.regionReferences[0].id,region1.id);assert.equal(persisted.content,'Please fix this button');
 await ui.evaluate(chat=>window.localAi.visualDebug.open(chat),chat);assert.equal((await info()).id,before.id);
 await assert.rejects(ui.evaluate(chat=>window.localAi.visualDebug.open(chat,'https://example.com'),chat));
 const foreign=await app.evaluate(()=>{const f=global.visualFixture;return f.db.createConversation('Foreign chat').id;});
 await assert.rejects(ui.evaluate(chat=>window.localAi.visualDebug.command(chat,{action:'reveal',regionId:'region-foreign'}),foreign));
 // Main IPC -> canonical region references -> actual Rust project edits -> real QA -> Verification Ledger.
 const spec={target:'/index.html',viewport:'desktop',preconditions:[],required_state:[],steps:[],assertion:{source:'layout',operator:'equals',expected:0},timeout_ms:5000};
 queue=[
  ['read_file',{path:'index.html'}],
  ['deliverables',{action:'add',id:'shared-buttons',text:'Both reusable buttons retain readable text',check:'browser',criteria:[{id:'layout',description:'No DOM clipping or overflow after the shared style fix',kind:'runtime',scenario:spec}]}],
  ['web_project',{action:'read'}],
  ['replace_text',{path:'index.html',old_text:'width:90px;white-space:nowrap;overflow:hidden',new_text:'width:max-content;max-width:100%;white-space:normal;overflow:visible'}],
  ['deliverables',{action:'implemented',id:'shared-buttons',evidence:'Read index.html and confirmed both buttons use .broken; fixed the common CSS rule'}],
  ['web_project',{action:'qa',scenario_refs:[{deliverable_id:'shared-buttons',criterion_id:'layout'}]}],
  async()=>{const memory=await app.evaluate(()=>global.visualFixture.events.filter(e=>e.type==='task-memory').at(-1)?.memory);const proof=memory?.verification?.records.findLast(r=>r.pass&&r.coverage?.some(c=>c.deliverable_id==='shared-buttons'));assert(proof,JSON.stringify(memory));return ['deliverables',{action:'verify',id:'shared-buttons',evidence_ids:[proof.id]}];}
 ];
 await ui.evaluate(()=>{window.__visualEvents=[];window.localAi.chat.onStream(event=>{window.__visualEvents.push(event);if(event.type==='approval-request')void window.localAi.chat.approve({conversationId:event.conversationId,generationId:event.generationId,approvalId:event.approval.approvalId,decision:'once'});});});
 await ui.evaluate(chat=>window.localAi.conversations.update(chat,{modelId:'qwen3.8:27b-q4_K_M',contextWindow:32768}),chat);
 const refs=(await info()).regions.regions.filter(r=>[region1.id,region2.id].includes(r.id));
 await ui.evaluate(({chat,refs})=>{window.__visualRun=window.localAi.chat.send({conversationId:chat,model:'qwen3.8:27b-q4_K_M',mode:'agent',generationId:'visual-fix-e2e',persistUserMessage:true,messages:[{id:'visual-fix-user',conversationId:chat,role:'user',content:'Fix the selected button group in the temporary project. Inspect the shared implementation, fix both instances, and verify the registered layout criterion.',regionReferences:refs.map(r=>({...r,screenshotPath:'/etc/passwd',anchors:[{text:'FORGED-EVIDENCE'}]})),createdAt:new Date().toISOString()}]}).catch(e=>{window.__visualSendError=String(e);});},{chat,refs});
 let finished=false;
 for(let i=0;i<900;i++){
  const result=await ui.evaluate(()=>({events:window.__visualEvents,error:window.__visualSendError}));
  assert(!result.error,result.error);const error=result.events.find(e=>e.type==='error');assert(!error,JSON.stringify(error));
  if(result.events.some(e=>e.type==='done')){finished=true;break;}
  await new Promise(r=>setTimeout(r,100));
 }
 assert(finished,'Actual Rust fix run did not complete');
 assert(requests.length>=8);assert(JSON.stringify(requests[0]).includes('Visual Grounding evidence'));assert(JSON.stringify(requests[0]).includes('shared-buttons'));assert(!JSON.stringify(requests).includes('FORGED-EVIDENCE'),'Renderer evidence is canonicalized in main');assert(!JSON.stringify(requests).includes('data:image/'),'Vision Off must not send image payloads');
 assert((await readFile(join(project,'index.html'),'utf8')).includes('width:max-content'));
 assert.equal((await info()).id,before.id,'Agent fix reuses the manually opened Native Page');assert.equal((await info()).ownership,'user');assert.equal((await info()).snapshot.overlay,false);
 const verified=await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat);
 assert.equal(verified.issues.find(i=>i.id==='shared-buttons').status,'Verified',JSON.stringify(verified.issues));
 const saved=await app.evaluate(()=>global.visualFixture.db.getMessage('visual-fix-user'));assert.equal(saved.regionReferences.length,2);assert(!saved.content.includes('screenshotPath'));
 await writeFile(join(root,'visual-debugging-result.json'),JSON.stringify({result:'PASS',provider:'scripted local SSE; actual Electron/Chromium/Rust',nativeId:before.id,requests:requests.length,verifiedIssue:verified.issues.find(i=>i.id==='shared-buttons'),checks:['manual reuse','selection and groups','DOM and Canvas','scroll/viewport/zoom/DPR','private pixels masked','history restart','canonical references','Vision Off','scoped fix and Verification Gate','bounded Auto']},null,2));
 console.log('PASS actual Rust Agent Runtime V2 with scripted local SSE provider: canonical structured region references, real source read, shared CSS write, browser session reuse and approval, mapped layout retest, Verification Gate and issue Ledger link; Vision Off has zero image payloads.');
 console.log('PASS real Electron Native Browser: manual open/reuse, rectangles, DOM grounding, Canvas, groups/split/delete, scroll/resize/reveal, crops, Vision Off, bounded QA suspects, UI draft chips, SQLite/history/renderer restart, external origin and foreign chat rejection. Runtime: '+root);
}finally{await app?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
