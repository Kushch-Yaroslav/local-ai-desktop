const {app,BrowserWindow,ipcMain}=require('electron');
const {resolve,join}=require('node:path');
const root=process.env.LOCAL_AI_RUNTIME_ROOT;
if(!root||!root.startsWith('/tmp/'))throw Error('A temporary runtime is required');
app.setPath('userData',join(root,'electron'));
let quitting=false;
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;void require(resolve('dist/main/ipc/register-ipc.js')).shutdownRuntime().catch(error=>console.error('Fixture shutdown failed',error)).finally(()=>app.quit());});
app.whenReady().then(async()=>{
 const fixture=await require(resolve('dist/main/ipc/context-profiles.test.js')).contextProfileFixture(root,true,process.env.LOCAL_AI_TEST_MODEL_ID??'qwen3.8:27b-q4_K_M');
 const controller=require(resolve('dist/main/services/llama-runtime-controller.js')).LlamaRuntimeController;controller.prototype.unload=async()=>{fixture.set({cold:true});return {ok:true,state:fixture.state()};};
 await controller.prototype.switchTo(fixture.modelId,32768);
 const settings=require(resolve('dist/main/services/runtime-settings.js'));settings.saveRuntimeConfiguration({...settings.loadRuntimeConfiguration(),autonomousBrowserQa:false,browserVision:'off'});
 const project=process.env.LOCAL_AI_TEST_PROJECT_ROOT;if(!project?.startsWith('/tmp/'))throw Error('A separate temporary project is required');
 fixture.db.updateConversation(fixture.chat.id,{title:'Visual Debugging demo',mode:'agent',workingDirectory:project,webMode:'auto',visionMode:'off'});
 const window=new BrowserWindow({width:1500,height:1000,webPreferences:{preload:resolve('dist/preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 ipcMain.handle('settings:setLanguage',(_event,language)=>{require(resolve('dist/main/services/runtime-settings.js')).saveLanguage(language);require(resolve('dist/shared/locale.js')).setLanguage(language);window.webContents.send('settings:language',language);});
 const {liveBrowsers}=require(resolve('dist/main/web/live-browser.js'));
 const events=[];const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,event,...rest)=>{if(channel==='chat:stream')events.push(event);return send(channel,event,...rest);};
 const Session=require(resolve('dist/main/web/project-browser.js')).ProjectBrowserSession,display=Session.prototype.visualDisplay;Session.prototype.visualDisplay=function(...args){global.visualFixture.session=this;return display.apply(this,args);};
 global.visualFixture={events,db:fixture.db,chat:fixture.chat.id,project,window,
  entry(){return [...liveBrowsers.entries.values()].find(e=>e.state.conversationId===fixture.chat.id&&!e.ended)},
  async drag(selector){const page=this.entry().page,b=await page.locator(selector).boundingBox();if(!b)throw Error('Missing target');await page.mouse.move(b.x+1,b.y+1);await page.mouse.down();await page.mouse.move(b.x+b.width-1,b.y+b.height-1,{steps:5});await page.mouse.up();},
  async info(){const entry=this.entry();return {id:entry?.native?.contents.id,pageCount:entry?.page?.context().pages().length,ownership:entry?.state.ownership,regions:this.db.visualDocument(this.chat,this.db.getConversation(this.chat).primaryProjectId),snapshot:entry?.page?await entry.page.evaluate(()=>({width:globalThis.innerWidth,height:globalThis.innerHeight,dpr:globalThis.devicePixelRatio,scrollY:globalThis.scrollY,overlay:!!globalThis.document.getElementById('__lad-visual-selection')})):null}},
 };
 await window.loadFile(resolve('dist/renderer/index.html'));
}).catch(e=>{console.error(e);app.exit(1)});
