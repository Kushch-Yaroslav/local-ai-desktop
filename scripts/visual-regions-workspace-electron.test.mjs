import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-regions-workspace-'),project=await mkdtemp('/tmp/lad-regions-project-');
await writeFile(join(project,'index.html'),`<!doctype html><style>body{margin:0;min-height:2500px;background:white}button{position:absolute;left:70vw;top:180px;width:60px;height:48px;overflow:hidden;white-space:nowrap;background:#ff0000;border:0;color:white}#second{top:280px}canvas{position:absolute;top:360px;left:20px}#private{position:absolute;top:460px;left:20px;width:100px;height:40px} @media(max-width:500px){button{left:180px}}</style><button id="target">Very long checkout button</button><button id="second">Second checkout</button><canvas width="120" height="60"></canvas><input id="private" type="password" value="PRIVATE-SECRET"><script>window.hits=[];document.addEventListener('mousedown',e=>hits.push({x:e.clientX,y:e.clientY,id:e.target.id}));</script>`);
const app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs'),...(process.argv.includes('--dpr2')?['--force-device-scale-factor=2']:[])],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label)=>{for(let i=0;i<150;i++){if(await fn())return;await sleep(100);}throw Error(label);};
try{
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();const chat=await app.evaluate(()=>global.visualFixture.chat);
 const doc=()=>ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat),cmd=command=>ui.evaluate(({chat,command})=>window.localAi.visualDebug.command(chat,command),{chat,command});
 const state=()=>app.evaluate(()=>global.visualFixture.entry().native.workspaceState());
 // Actual API identity comes from the native hub, not a second browser target.
 await ui.evaluate(chat=>window.localAi.visualDebug.open(chat,'index.html?currency=UAH#/catalog?sort=price'),chat);
 const session=await app.evaluate(()=>global.visualFixture.entry().state.sessionId),nativeId=await app.evaluate(()=>global.visualFixture.entry().native.contents.id);
 const workspace=async(viewport,scale='fit',pan={x:0,y:0})=>{await ui.evaluate(({session,settings})=>window.localAi.liveBrowser.workspace(session,settings),{session,settings:{viewport,scale,pan}});await sleep(180);};
 await ui.evaluate(chat=>window.localAi.liveBrowser.watch(chat,true),chat);await until(async()=>!!(await state()),'Native surface not laid out');
 // Renderer uses actual layout bounds. Also test the specified 800x600 presentation directly.
 await ui.evaluate(session=>window.localAi.liveBrowser.layout(session,{x:20,y:100,width:800,height:600}),session);
 await ui.evaluate(session=>window.localAi.liveBrowser.layout(session,{x:20,y:100,width:800,height:12}),session);await workspace({width:390,height:844});assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>innerWidth)),390,'Tiny physical panel must not freeze the CSS viewport');await ui.evaluate(session=>window.localAi.liveBrowser.layout(session,{x:20,y:100,width:800,height:600}),session);
 await workspace({width:1920,height:1080});
 assert.deepEqual((await state()).viewport,{width:1920,height:1080});
 assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>innerWidth)),1920);
 await ui.evaluate(chat=>window.localAi.visualDebug.open(chat),chat);assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);
 const create=async(selector,partial=false)=>{
   const d=await cmd({action:'new-area'}),area=d.issues.at(-1);await cmd({action:'selection',enabled:true,groupId:area.id});
   await app.evaluate(async(_,arg)=>{const p=global.visualFixture.entry().page,b=await p.locator(arg.selector).boundingBox();await p.mouse.move(b.x+(arg.partial?b.width/2:1),b.y+1);await p.mouse.down();await p.mouse.move(b.x+b.width-1,b.y+b.height-1,{steps:5});await p.mouse.up();},{selector,partial});
   await until(async()=>(await doc()).regions.some(r=>r.groupId===area.id),'Missing selected rectangle');await cmd({action:'selection',enabled:false});return (await doc()).regions.find(r=>r.groupId===area.id);
 };
 const region=await create('#target',true);assert.equal(region.anchors[0].selector,'#target');assert(region.rect.width<35);assert(region.anchors[0].findings.some(f=>f.category==='text-clipping'));assert(!JSON.stringify(region).includes('PRIVATE-'));
 const cropStats=async(path)=>app.evaluate(({nativeImage},path)=>{const image=nativeImage.createFromPath(path),bitmap=image.toBitmap();let red=0,magenta=0;for(let i=0;i<bitmap.length;i+=4){if(bitmap[i]<80&&bitmap[i+1]<80&&bitmap[i+2]>190)red++;if(bitmap[i]>240&&bitmap[i+1]<20&&bitmap[i+2]>240)magenta++;}return {size:image.getSize(),red:red/(bitmap.length/4),magenta:magenta/(bitmap.length/4)};},path);
 assert((await cropStats(region.screenshotPath)).red>.45,'Crop must contain the actual red button at Fit');
 // Use the same projection function inside real Chromium, then inspect actual closed shadow borders through CDP.
 const boxes=(regionId=region.id)=>app.evaluate(async(_,regionId)=>{const c=global.visualFixture.entry().native.contents;await c.debugger.sendCommand('DOM.enable');const tree=await c.debugger.sendCommand('DOM.getDocument',{depth:-1,pierce:true});const found=[];const walk=n=>{if(n.nodeName==='DIV'&&n.attributes?.includes('style')){const i=n.attributes.indexOf('style'),style=n.attributes[i+1];const id=n.attributes[n.attributes.indexOf('data-region-id')+1];if((regionId===null||id===regionId)&&/border:\s*[35]px solid/.test(style))found.push(style);}for(const child of [...(n.children??[]),...(n.shadowRoots??[])])walk(child);};walk(tree.root);return found;},regionId);
 for(const [viewport,scale] of [[{width:1920,height:1080},1],[{width:1920,height:1080},.5],[{width:390,height:844},'fit'],[{width:3840,height:2160},'fit'],[{width:1920,height:1080},1.25]]){
   await workspace(viewport,scale);assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>innerWidth)),viewport.width);
   const view=await cmd({action:'reveal',regionId:region.id});assert(!view.view.stale);assert(!view.view.needsNavigation);await sleep(150);assert((await boxes()).length,'Actual highlight must be painted');
   await app.evaluate(()=>global.visualFixture.entry().page.mouse.click(10,10));
 }
 // Assert actual painted partial borders follow layout and dynamic transforms.
 await workspace({width:1920,height:1080});
 const assertPartial=async(reveal=true)=>{if(reveal)await cmd({action:'reveal',regionId:region.id});await sleep(130);const painted=await boxes();assert.equal(painted.length,1);const values=Object.fromEntries([...painted[0].matchAll(/(left|top|width|height):\s*([-\d.]+)px/g)].map(m=>[m[1],Number(m[2])]));const b=await app.evaluate(()=>global.visualFixture.entry().page.locator('#target').boundingBox());assert(Math.abs(values.left-(b.x+(region.rect.x-region.anchors[0].rect.x)*b.width/region.anchors[0].rect.width))<1);assert(Math.abs(values.width-region.rect.width*b.width/region.anchors[0].rect.width)<1);};
 await assertPartial();await app.evaluate(()=>global.visualFixture.window.setSize(1250,850));await sleep(250);await assertPartial(false);
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{document.querySelector('#target').style.transform='translate(35px,20px) scale(1.2)';}));await assertPartial(false);
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{document.querySelector('#target').style.transform='rotate(15deg)';}));assert((await cmd({action:'reveal',regionId:region.id})).view.stale);assert.equal((await boxes()).length,0);
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{document.querySelector('#target').style.transform='scaleX(-1)';}));assert((await cmd({action:'reveal',regionId:region.id})).view.stale);await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{document.querySelector('#target').style.transform='';document.body.style.opacity='0';}));assert((await cmd({action:'reveal',regionId:region.id})).view.stale);await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{document.body.style.opacity='1';}));
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{document.querySelector('#target').style.transform='';scrollTo(0,80);}));await assertPartial();
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>scrollTo(0,0)));
 for(const zoom of ['.8','1.25']){await app.evaluate((_,zoom)=>global.visualFixture.entry().page.evaluate(zoom=>{document.body.style.zoom=zoom;},zoom),zoom);await assertPartial();}await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>{document.body.style.zoom='1';}));
 await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>location.hash='/different?sort=other'));assert((await cmd({action:'reveal',regionId:region.id})).view.needsNavigation);await cmd({action:'navigate',regionId:region.id});
 await cmd({action:'reveal',regionId:region.id});await ui.getByRole('button',{name:'Browser Expanded',exact:true}).click();await sleep(180);await assertPartial(false);
 await ui.getByRole('button',{name:'Split View',exact:true}).click();await sleep(180);await assertPartial(false);
 await ui.getByRole('button',{name:'Chat Only',exact:true}).click();assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);await ui.locator('.live-reopen').click();await assertPartial();
 // Partial selection follows responsive movement rather than growing into the whole button.
 await workspace({width:1920,height:1080},1,{x:1000,y:120});const scrollBefore=await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>({x:scrollX,y:scrollY})));
 await workspace({width:1920,height:1080},1,{x:1100,y:160});assert.deepEqual(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>({x:scrollX,y:scrollY}))),scrollBefore);
 const panned=await create('#target');assert.equal(panned.anchors[0].selector,'#target');assert((await cropStats(panned.screenshotPath)).red>.45,'Fixed/panned crop must use CSS/document coordinates');
 await workspace({width:1920,height:1080},.5,{x:700,y:50});const half=await create('#target',true);assert((await cropStats(half.screenshotPath)).red>.45,'50% partial crop must retain CSS geometry');
 await workspace({width:1920,height:1080});const afterFit=await create('#target');assert.equal(afterFit.anchors[0].selector,'#target');assert((await cropStats(afterFit.screenshotPath)).red>.45);
 // Native physical input and agent CDP input hit the same CSS element at scaled presentation.
 await app.evaluate(async()=>{const f=global.visualFixture,e=f.entry(),s=e.native.workspaceState(),b=await e.page.locator('#target').boundingBox();e.native.contents.sendInputEvent({type:'mouseDown',x:Math.round((b.x+10)*s.displayScale*s.browserZoom),y:Math.round((b.y+10)*s.displayScale*s.browserZoom),button:'left',clickCount:1});e.native.contents.sendInputEvent({type:'mouseUp',x:Math.round((b.x+10)*s.displayScale*s.browserZoom),y:Math.round((b.y+10)*s.displayScale*s.browserZoom),button:'left',clickCount:1});await e.page.mouse.click(b.x+15,b.y+15);});
 await until(()=>app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>globalThis.hits.slice(-2).every(h=>h.id==='target'))),'Native and CDP inputs must agree');
 // Zoom/DPR must not change a fixed CSS viewport or corrupt the screenshot crop.
 for(const zoom of [.8,1,1.25]){await app.evaluate((_,zoom)=>global.visualFixture.entry().native.contents.setZoomFactor(zoom),zoom);await workspace({width:1920,height:1080});assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>innerWidth)),1920);const r=await create('#target');assert((await cropStats(r.screenshotPath)).red>.45,`Correct crop at zoom ${zoom}`);}
 const secret=await create('#private');assert((await cropStats(secret.screenshotPath)).magenta>.8,'Private control must be masked');
 await app.evaluate(()=>global.visualFixture.entry().native.contents.setZoomFactor(1));await workspace({width:1920,height:1080});
 const canvas=await create('canvas');assert.equal(canvas.anchors.length,0);await workspace({width:390,height:844});assert((await cmd({action:'reveal',regionId:canvas.id})).view.stale);assert.equal((await boxes(canvas.id)).length,0,'Stale screenshot-only region must not draw fallback');
 await workspace({width:1920,height:1080});await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>document.querySelector('#target').id='renamed'));assert((await cmd({action:'reveal',regionId:region.id})).view.stale);assert.equal((await boxes()).length,0,'Missing anchor must not draw saved coordinates');
 await app.evaluate(()=>global.visualFixture.entry().page.reload());assert(!(await cmd({action:'reveal',regionId:region.id})).view.stale);
 await app.evaluate(()=>{const n=global.visualFixture.entry().native,original=n.workspace;n.workspace=async settings=>{(global.workspaceCalls??=[]).push(settings);return original(settings);};});
 // Exercise compact renderer controls and real scrollbars, not only main-process methods.
 await ui.getByLabel('CSS viewport',{exact:true}).selectOption('Mobile');await until(()=>app.evaluate(async()=>await global.visualFixture.entry().page.evaluate(()=>innerWidth===390)),'Mobile preset UI failed');
 await ui.getByLabel('CSS viewport',{exact:true}).selectOption('Full HD');await ui.getByLabel('Display scale',{exact:true}).selectOption('1');await until(async()=>(await state()).settings.scale===1,'Fixed scale UI failed');
 const siteScroll=await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>({x:scrollX,y:scrollY})));
 await ui.locator('.native-browser-surface').evaluate(element=>{element.scrollLeft=700;element.scrollTop=150;});await until(async()=>(await state()).settings.pan.x>300,'Horizontal surface scrollbar failed');assert.deepEqual(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>({x:scrollX,y:scrollY}))),siteScroll);
 await ui.getByLabel('Display scale',{exact:true}).selectOption('fit');await until(async()=>(await state()).settings.scale==='fit','Fit UI failed');assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>innerWidth)),1920);
 await ui.getByLabel('CSS viewport',{exact:true}).selectOption('Custom');await ui.getByLabel('Viewport width',{exact:true}).fill('1000');await ui.getByLabel('Viewport height',{exact:true}).fill('700');await ui.getByRole('button',{name:'Apply',exact:true}).click();await until(()=>app.evaluate(async()=>await global.visualFixture.entry().page.evaluate(()=>innerWidth===1000&&innerHeight===700)),'Custom viewport UI failed');
 await workspace({width:1920,height:1080});

 // Save immutable history, reveal, delete and immediately request historical reference again.
 await app.evaluate((_,r)=>{const f=global.visualFixture;f.db.addMessage(f.chat,'user','Historical selected button','workspace-history');f.db.setRegionReferences('workspace-history',f.chat,[r]);},region);
 // Deterministic async race: delete while readonly focus awaits native surface pan.
 await app.evaluate(()=>{const n=global.visualFixture.entry().native,original=n.revealCss;global.focusStarted=false;n.revealCss=async rect=>{global.focusStarted=true;await new Promise(resolve=>{global.finishFocus=resolve;});return original(rect);};global.restoreFocus=()=>{n.revealCss=original;};});
 const pendingFocus=cmd({action:'reveal',regionId:region.id});await until(()=>app.evaluate(()=>global.focusStarted),'Readonly focus did not start');await cmd({action:'delete',regionId:region.id});await app.evaluate(()=>{global.restoreFocus();global.finishFocus();});await pendingFocus;assert.equal((await boxes()).length,0,'A pending readonly reveal cannot repaint after deletion');assert(!(await doc()).issues.some(i=>i.id===region.groupId),'Last rectangle removes its area');
 const history=await cmd({action:'reveal',regionId:region.id});assert(history.view.deleted);assert(history.view.cropDataUrl);assert.equal((await boxes()).length,0,'Historical reference cannot resurrect deleted overlay');
 await assert.rejects(cmd({action:'navigate',regionId:region.id}));
 const draft=await cmd({action:'new-area'});const draftNumber=draft.issues.at(-1).number;
 assert(!(await app.evaluate(()=>global.visualFixture.info())).regions.issues.some(i=>!i.regionIds.length),'Empty draft never persists to SQLite');
 await cmd({action:'selection',enabled:false});assert(!(await doc()).issues.some(i=>i.number===draftNumber));
 // Whole-area deletion, multi-rectangle UI confirmation and global confirmation.
 const multi=await create('#target');await cmd({action:'selection',enabled:true,groupId:multi.groupId});await app.evaluate(()=>global.visualFixture.drag('#second'));await until(async()=>(await doc()).regions.filter(r=>r.groupId===multi.groupId).length===2,'Missing second rectangle in group');await cmd({action:'selection',enabled:false});
 await until(()=>ui.locator('.visual-area').filter({hasText:`Area ${multi.groupNumber}`}).count(),'Area list did not refresh');
 const row=ui.locator('.visual-area').filter({has:ui.getByRole('button',{name:`Area ${multi.groupNumber}`,exact:true})});await row.getByRole('button',{name:`Delete area ${multi.groupNumber}`,exact:true}).click();assert(await ui.getByRole('button',{name:'Confirm deletion',exact:true}).count());assert((await doc()).regions.some(r=>r.groupId===multi.groupId));await ui.getByRole('button',{name:'Confirm deletion',exact:true}).click();await until(async()=>!(await doc()).issues.some(i=>i.id===multi.groupId),'Group delete did not persist');
 await ui.locator('.visual-options > summary').click();await ui.getByRole('button',{name:'Clear all areas',exact:true}).click();assert((await doc()).regions.length);await ui.getByRole('button',{name:'Confirm deletion',exact:true}).click();await until(async()=>!(await doc()).regions.length,'Clear all did not persist');
 await cmd({action:'clear'});assert.equal((await doc()).regions.length,0);assert.equal((await doc()).issues.length,0);assert.equal((await boxes(null)).length,0);
 await ui.reload();await ui.locator('.chat-select').filter({hasText:'Visual Debugging demo'}).click();assert.equal((await doc()).regions.length,0);
 await ui.evaluate(chat=>window.localAi.visualDebug.open(chat),chat);assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);
 assert.equal((await cmd({action:'new-area'})).issues.at(-1).number,draftNumber+2,'Deleted numbers cannot be reused');await cmd({action:'selection',enabled:false});
 await workspace({width:3840,height:2160});
 const before=await app.evaluate(({app})=>({metrics:app.getAppMetrics(),memory:process.memoryUsage(),views:global.visualFixture.window.contentView.children.length,nativePid:global.visualFixture.entry().native.contents.getOSProcessId(),ownerPid:global.visualFixture.window.webContents.getOSProcessId()}));const frames=await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>new Promise(resolve=>{const start=performance.now();let count=0;const frame=()=>{count++;if(performance.now()-start<2000)requestAnimationFrame(frame);else resolve({count,elapsed:performance.now()-start});};requestAnimationFrame(frame);})));
 const after=await app.evaluate(({app})=>({metrics:app.getAppMetrics(),memory:process.memoryUsage(),views:global.visualFixture.window.contentView.children.length,nativePid:global.visualFixture.entry().native.contents.getOSProcessId(),ownerPid:global.visualFixture.window.webContents.getOSProcessId()}));
 const clickStarted=Date.now();await app.evaluate(async()=>{const p=global.visualFixture.entry().page;await p.locator('#target').click();if((await p.evaluate(()=>globalThis.hits.at(-1).id))!=='target')throw Error('4K click missed the DOM target');});const clickRoundtripMs=Date.now()-clickStarted;
 assert.equal(before.views,after.views);assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.context().pages().length),1);
 await assert.rejects(ui.evaluate(chat=>window.localAi.visualDebug.open(chat,'https://example.com'),chat));
 const result={result:'PASS',root,project,dpr2:process.argv.includes('--dpr2'),nativeId,viewport:await state(),performance:{before,after,frames,clickRoundtripMs},checks:['delete/history/SQLite/no ghost','partial anchoring/responsive/stale/canvas','native and CDP input agreement','Fit/Fixed/pan independent of page scroll','390/1920/4K','zoom80/100/125 crop pixel checks','privacy mask','renderer reload/session identity','single Page/origin restrictions']};await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({result:'PASS',root,dpr2:result.dpr2,checks:result.checks}));
}catch(error){console.error(JSON.stringify(await app.evaluate(()=>({calls:global.workspaceCalls,state:global.visualFixture.entry()?.native?.workspaceState()}))));throw error;}finally{await app.close();}
