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
 await ui.evaluate(chat=>window.localAi.visualDebug.open(chat,'index.html?currency=EUR#/product/1'),chat);
 await ui.getByRole('button',{name:'Browser Expanded',exact:true}).click();
 const session=await app.evaluate(()=>global.visualFixture.entry().state.sessionId),nativeId=await app.evaluate(()=>global.visualFixture.entry().native.contents.id);
 const state=()=>app.evaluate(()=>global.visualFixture.entry().native.workspaceState());
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
  if([1,2,5,10].includes(i))assert(Math.abs(await height()-initialHeight)<3,'Cards must scroll inside fixed tools row');
 }
 await app.evaluate((_,r)=>{const f=global.visualFixture;f.db.addMessage(f.chat,'user','Original area 1','layout-history');f.db.setRegionReferences('layout-history',f.chat,[r]);},regions[0]);
 await ui.getByLabel('Browser layout',{exact:true}).selectOption('horizontal');await until(()=>ui.locator('.live-browser.workspace-horizontal').count(),'Horizontal layout');
 const surface=await ui.locator('.live-screen').boundingBox(),tools=await ui.locator('.browser-tools').boundingBox();assert(surface.x>tools.x+tools.width);assert(surface.height>500);
 const divider=ui.getByRole('separator',{name:'Browser tools width',exact:true});await divider.focus();await ui.keyboard.press('ArrowRight');await until(async()=>(await state()).settings.toolsWidth===310,'Keyboard resize');
 const b=await divider.boundingBox();await ui.mouse.move(b.x+3,b.y+30);await ui.mouse.down();await ui.mouse.move(b.x+73,b.y+30,{steps:6});await ui.mouse.up();await until(async()=>(await state()).settings.toolsWidth>340,'Pointer resize');
 for(const width of [390,768,1440,1920,3840]){await configure({...((await state()).settings),viewport:{width,height:width===3840?2160:900}});await until(async()=>await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>innerWidth))===width,'CSS viewport '+width+' state '+JSON.stringify(await state()));assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);}
 await configure({...((await state()).settings),viewport:{width:1440,height:900},zoom:1,scale:'fit',previewScale:1});
 await ui.getByLabel('Presentation mode',{exact:true}).selectOption('scroll');await until(async()=>(await state()).settings.scale===1,'Visible scroll mode');
 await ui.getByLabel('Preview scale',{exact:true}).selectOption('0.75');await until(async()=>(await state()).settings.scale===.75,'Visible preview scale');
 assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.evaluate(()=>innerWidth)),1440);
 await ui.getByLabel('Presentation mode',{exact:true}).selectOption('fit');await until(async()=>(await state()).settings.scale==='fit','Visible Fit mode');
 await ui.getByLabel('Presentation mode',{exact:true}).selectOption('scroll');await until(async()=>(await state()).settings.scale===.75,'Remember numeric preview scale');
 await ui.reload();await ui.locator('.chat-select').filter({hasText:'Visual Debugging demo'}).click();await ui.evaluate(chat=>window.localAi.visualDebug.open(chat),chat);
 assert.equal((await state()).settings.layout,'horizontal');assert.equal((await state()).settings.scale,.75);assert.equal((await state()).settings.previewScale,.75);
 await app.evaluate(()=>global.visualFixture.window.setSize(600,850));await until(()=>ui.locator('.live-browser.workspace-vertical').count(),'Narrow fallback');assert((await height())>=120);
 await cmd({action:'delete-area',areaId:regions[0].groupId});assert.deepEqual((await doc()).issues.map(i=>i.number),[1,2,3,4,5,6,7,8,9]);
 const history=await app.evaluate(()=>global.visualFixture.db.getMessage('layout-history').regionReferences[0]);assert.equal(history.id,regions[0].id);assert.equal(history.groupNumber,1);assert((await cmd({action:'reveal',regionId:history.id})).view.deleted);
 await cmd({action:'clear'});const fresh=await cmd({action:'new-area'});assert.equal(fresh.issues[0].number,1);assert(!regions.some(r=>r.groupId===fresh.issues[0].id));
 assert.equal(await app.evaluate(()=>global.visualFixture.entry().native.contents.id),nativeId);
 const result={result:'PASS',root,checks:['10 real selections; bounded vertical tools height','horizontal same Page','pointer/keyboard width','390/768/1440/1920/4K CSS viewport','visible Fit/Scroll/preview scale','renderer reload persistence','narrow fallback','current numbering and immutable deleted history'],dpr2:process.argv.includes('--dpr2')};await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await app?.close();}
