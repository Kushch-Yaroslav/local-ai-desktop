import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-workspace-layout-'),project=await mkdtemp('/tmp/lad-workspace-layout-project-');
await writeFile(join(project,'index.html'),'<style>body{margin:0;background:white}button{position:absolute;left:40px;top:60px;width:100px;height:40px;background:red}</style><button id="target">Checkout</button>');
let app;const delay=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label)=>{for(let i=0;i<150;i++){if(await fn())return;await delay(100);}throw Error(label);};
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs'),...(process.argv.includes('--dpr2')?['--force-device-scale-factor=2']:[])],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();const chat=await app.evaluate(()=>global.visualFixture.chat);
 await app.evaluate(()=>global.visualFixture.window.setSize(1500,950));
 await ui.evaluate(chat=>window.localAi.visualDebug.open(chat,'index.html?currency=EUR#/product/1'),chat);await ui.locator('.live-manual-open').waitFor();await ui.locator('.live-manual-open').click();
 await ui.getByRole('button',{name:'Browser Expanded',exact:true}).click();
 const session=await app.evaluate(()=>global.visualFixture.entry().state.sessionId),nativeId=await app.evaluate(()=>global.visualFixture.entry().native.contents.id);
 const state=()=>app.evaluate(()=>global.visualFixture.entry().native.workspaceState());
 const workspaceState=()=>app.evaluate(()=>global.visualFixture.entry().state.workspace);
 const nativeBounds=()=>app.evaluate(()=>global.visualFixture.nativeSurfaceBounds());
 const doc=()=>ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat),cmd=command=>ui.evaluate(({chat,command})=>window.localAi.visualDebug.command(chat,command),{chat,command});
 const configure=async settings=>{await ui.evaluate(({session,settings})=>window.localAi.liveBrowser.workspace(session,settings),{session,settings});await delay(200);};
 await configure({viewport:{width:1440,height:900},zoom:1,scale:'fit',previewScale:1,pan:{x:0,y:0},layout:'vertical',toolsWidth:300});
 const height=()=>ui.locator('.live-screen').evaluate(e=>e.clientHeight);
 const initialHeight=await height();assert(initialHeight>200,'Native surface must retain working area');
 const regions=[];
 for(let i=1;i<=10;i++){
  const d=await cmd({action:'new-area'}),area=d.issues.at(-1);await cmd({action:'selection',enabled:true,groupId:area.id});await app.evaluate(()=>global.visualFixture.drag('#target'));
  await until(async()=>(await doc()).regions.length===i,'Region capture '+i);await cmd({action:'selection',enabled:false});
  regions.push((await doc()).regions.at(-1));assert.equal((await doc()).issues.at(-1).number,i);
  if([1,2,5,10].includes(i))assert(Math.abs(await height()-initialHeight)<3,'Cards must scroll inside fixed tools row');if([1,5,10].includes(i))await ui.screenshot({path:join(root,`geometry-vertical-${i}.png`)});
 }
 // Newly saved manual selections are already attached to the draft. Clear
 // those chips through the real UI before checking a fresh two-area transfer.
 await ui.getByRole('button',{name:'Split View',exact:true}).click();
 await until(()=>ui.locator('.visual-composer-references .visual-region-chip').count().then(n=>n===10),'Automatic manual references');
 while(await ui.locator('.visual-composer-references button[aria-label^="Delete Area"]').count())await ui.locator('.visual-composer-references button[aria-label^="Delete Area"]').first().click();
 await ui.getByRole('button',{name:'Browser Expanded',exact:true}).click();
 const messagesBeforeTransfer=await app.evaluate(()=>global.visualFixture.db.listMessages(global.visualFixture.chat).length);
 await ui.evaluate(()=>{window.__workspaceDraft=null;window.addEventListener('visual-region-draft',event=>{window.__workspaceDraft=event.detail;},{once:true});});
 await ui.getByRole('checkbox',{name:'Select area 1',exact:true}).check();await ui.getByRole('checkbox',{name:'Select area 2',exact:true}).check();
 await ui.getByRole('button',{name:/Send selected to agent/}).click();
 const draft=await ui.evaluate(()=>window.__workspaceDraft);assert.equal(new Set(draft.regions.map(r=>r.groupId)).size,2);assert.equal(draft.regions.length,2);assert(draft.regions.every(r=>r.url&&r.viewport.width===1440&&r.anchors.length));
 assert.equal(await ui.locator('.attachment-draft .visual-region-chip').count(),2);assert.equal(await app.evaluate(()=>global.visualFixture.db.listMessages(global.visualFixture.chat).length),messagesBeforeTransfer,'Transferring issues must not send a message');
 await ui.getByRole('button',{name:'Browser Expanded',exact:true}).click();
 await app.evaluate((_,r)=>{const f=global.visualFixture;f.db.addMessage(f.chat,'user','Original area 1','layout-history');f.db.setRegionReferences('layout-history',f.chat,[r]);},regions[0]);
 await ui.getByLabel('Browser layout',{exact:true}).selectOption('horizontal');await until(()=>ui.locator('.live-browser.workspace-horizontal').count(),'Horizontal layout');
 await ui.screenshot({path:join(root,'geometry-horizontal-10.png')});const surface=await ui.locator('.live-screen').boundingBox(),tools=await ui.locator('.browser-tools').boundingBox();assert(surface.x>tools.x+tools.width);assert(surface.height>(process.argv.includes('--dpr2')?250:500),JSON.stringify({surface,dpr2:process.argv.includes('--dpr2')}));
 const divider=ui.getByRole('separator',{name:'Browser tools width',exact:true});await divider.focus();await ui.keyboard.press('ArrowRight');await until(async()=>(await state()).settings.toolsWidth===310,'Keyboard resize');
 const b=await divider.boundingBox();const pointerBefore=(await state()).settings.toolsWidth;await ui.mouse.move(b.x+3,b.y+30);await ui.mouse.down();await ui.mouse.move(b.x+73,b.y+30,{steps:6});await ui.mouse.up();await until(async()=>(await state()).settings.toolsWidth>340,'Pointer resize '+JSON.stringify({dpr2:process.argv.includes('--dpr2'),divider:b,pointerBefore,workspace:(await state()).settings,surface:await nativeBounds()}));
 for(const width of [390,768,1440,1920,3840]){await configure({...((await state()).settings),viewport:{width,height:width===3840?2160:900}});await until(async()=>await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>innerWidth))===width,'CSS viewport '+width+' state '+JSON.stringify(await state()));assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);}
 await configure({...((await state()).settings),viewport:{width:1440,height:900},zoom:1,scale:'fit',previewScale:1});
 await ui.getByLabel('Presentation mode',{exact:true}).selectOption('scroll');await until(async()=>(await state()).settings.scale===1,'Visible scroll mode');
 await ui.getByLabel('Preview scale',{exact:true}).selectOption('0.75');await until(async()=>(await state()).settings.scale===.75,'Visible preview scale');
 const at75=await state(),bounds75=await nativeBounds();assert.equal(at75.displayScale,.75);assert.equal(bounds75.width,at75.surface.width);assert.equal(bounds75.height,at75.surface.height);
 await ui.getByLabel('Preview scale',{exact:true}).selectOption('0.5');await until(async()=>(await state()).displayScale===.5,'Actual preview scale 50');const at50=await state(),bounds50=await nativeBounds();assert.equal(bounds50.width,at50.surface.width);assert.equal(bounds50.width,bounds75.width*2/3);
 await ui.getByLabel('Preview scale',{exact:true}).selectOption('1');await until(async()=>(await state()).displayScale===1,'Actual preview scale 100');const at100=await state(),bounds100=await nativeBounds();assert.equal(bounds100.width,at100.surface.width);assert.equal(bounds100.width,bounds75.width*4/3);
 await ui.getByLabel('Preview scale',{exact:true}).selectOption('1.25');await until(async()=>(await state()).displayScale===1.25,'Actual preview scale 125');const at125=await state(),bounds125=await nativeBounds();assert.equal(bounds125.width,at125.surface.width);assert(bounds125.width>bounds100.width);
 assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>innerWidth)),1440);
 assert.equal(at50.viewport.width,1440);assert.equal(at100.viewport.width,1440);assert.equal(at125.viewport.width,1440,'Presentation scale cannot alter the CSS viewport');
 const geometry=[{layout:'horizontal',viewport:{width:1440,height:900},scales:[{scale:.5,bounds:bounds50},{scale:.75,bounds:bounds75},{scale:1,bounds:bounds100},{scale:1.25,bounds:bounds125}]}];
 for(const layout of ['vertical','horizontal'])for(const viewport of ['auto',{width:1440,height:900}]){
  await configure({...((await state()).settings),layout,viewport,scale:1,pan:{x:0,y:0}});
  const original=await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>({width:innerWidth,height:innerHeight})));
  const scales=[];
  for(const scale of [.5,.75,1,1.25]){
   await configure({...((await state()).settings),scale,previewScale:scale});
   const actual=await state(),bounds=await nativeBounds();
   assert.equal(bounds.width,actual.surface.width);assert.equal(bounds.height,actual.surface.height);
   assert.deepEqual(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>({width:innerWidth,height:innerHeight}))),original,'Presentation scale preserves actual CSS viewport');
   scales.push({scale,bounds,cssViewport:original});
  }
  geometry.push({layout,viewport,scales});
 }
 await configure({...((await state()).settings),layout:'horizontal',viewport:{width:1440,height:900},scale:1.25,previewScale:1.25});
 await ui.getByRole('button',{name:'Hide tools',exact:true}).click();await until(()=>ui.locator('.browser-tools').evaluate(e=>getComputedStyle(e).display==='none'),'Hide workspace tools');assert(await ui.locator('.browser-navigation').isVisible());assert((await ui.locator('.live-screen').boundingBox()).width>600);await ui.getByRole('button',{name:'Show tools',exact:true}).click();await until(()=>ui.locator('.browser-tools').evaluate(e=>getComputedStyle(e).display!=='none'),'Restore workspace tools');
 await app.evaluate(()=>global.visualFixture.setOwnership('agent'));await ui.getByRole('button',{name:'Hide tools',exact:true}).click();await until(async()=>(await workspaceState()).settings.toolsCollapsed===true,'Collapse tools during agent ownership');assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);await ui.getByRole('button',{name:'Show tools',exact:true}).click();await until(async()=>(await workspaceState()).settings.toolsCollapsed===false,'Restore tools during agent ownership');await app.evaluate(()=>global.visualFixture.setOwnership('user'));
 await ui.getByLabel('Presentation mode',{exact:true}).selectOption('fit');await until(async()=>(await state()).settings.scale==='fit','Visible Fit mode');
 await ui.getByLabel('Presentation mode',{exact:true}).selectOption('scroll');await until(async()=>(await state()).settings.scale===1.25,'Remember numeric preview scale');await ui.getByRole('button',{name:'Hide tools',exact:true}).click();await until(async()=>(await state()).settings.toolsCollapsed===true,'Persist collapsed tools');
 await ui.reload();await ui.locator('.chat-select').filter({hasText:'Visual Debugging demo'}).click();await ui.evaluate(chat=>window.localAi.visualDebug.open(chat),chat);
 assert.equal((await state()).settings.layout,'horizontal');assert.equal((await state()).settings.scale,1.25);assert.equal((await state()).settings.previewScale,1.25);assert.equal((await state()).settings.toolsCollapsed,true);await ui.getByRole('button',{name:'Show tools',exact:true}).click();await until(async()=>(await state()).settings.toolsCollapsed===false,'Show persisted collapsed tools');
 await app.evaluate(()=>global.visualFixture.window.setSize(600,850));await until(()=>ui.locator('.live-browser.workspace-vertical').count(),'Narrow fallback');assert((await height())>=120);
 await configure({...((await state()).settings),pan:{x:90,y:60},zoom:1.1});const beforeHide=await state(),regionsBeforeHide=(await doc()).regions.length;
 await ui.getByRole('button',{name:'Hide browser',exact:true}).click();await until(()=>ui.locator('.live-browser').evaluate(e=>getComputedStyle(e).display==='none'),'Hide Browser Workspace');assert.equal(await app.evaluate(()=>global.visualFixture.entry().state.sessionId),session);assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);await ui.locator('.live-manual-open').click();await until(()=>ui.locator('.live-browser').evaluate(e=>getComputedStyle(e).display!=='none'),'Reopen existing Browser Workspace');assert.equal(await app.evaluate(()=>global.visualFixture.entry().state.sessionId),session);
 assert.deepEqual((await state()).viewport,beforeHide.viewport);assert.deepEqual((await state()).settings.pan,beforeHide.settings.pan);assert.equal((await state()).browserZoom,beforeHide.browserZoom);assert.equal((await doc()).regions.length,regionsBeforeHide);
 await ui.locator('.new-chat').click();assert(!(await ui.locator('.live-browser').isVisible()),'A new chat must not show another chat browser');await ui.locator('.chat-select').filter({hasText:'Visual Debugging demo'}).click();if(await ui.locator('.live-manual-open').isVisible())await ui.locator('.live-manual-open').click();assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);
 await cmd({action:'delete-area',areaId:regions[0].groupId});assert.deepEqual((await doc()).issues.map(i=>i.number),[1,2,3,4,5,6,7,8,9]);
 const history=await app.evaluate(()=>global.visualFixture.db.getMessage('layout-history').regionReferences[0]);assert.equal(history.id,regions[0].id);assert.equal(history.groupNumber,1);assert((await cmd({action:'reveal',regionId:history.id})).view.deleted);
 await cmd({action:'clear'});const fresh=await cmd({action:'new-area'});assert.equal(fresh.issues[0].number,1);assert(!regions.some(r=>r.groupId===fresh.issues[0].id));
 assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);
 const result={result:'PASS',root,checks:['10 real selections; bounded vertical tools height','horizontal same Page','pointer/keyboard width','390/768/1440/1920/4K CSS viewport','visible Fit/Scroll/preview scale','renderer reload persistence','narrow fallback','current numbering and immutable deleted history'],dpr2:process.argv.includes('--dpr2'),geometry};await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await app?.close();}
