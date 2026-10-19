const {app,BrowserWindow}=require('electron');
const {resolve,join}=require('node:path');
const {mkdir,appendFile}=require('node:fs/promises');
const {writeFileSync,renameSync,watchFile,unwatchFile,readFileSync}=require('node:fs');
app.setPath('userData',join(process.env.LOCAL_AI_RUNTIME_ROOT,'electron'));
if(process.env.LOCAL_AI_TEST_SOFTWARE==='1')app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const root=process.env.LOCAL_AI_RUNTIME_ROOT;
 const originalFetch=global.fetch;
 const fixture=await require(resolve('dist/main/ipc/context-profiles.test.js')).contextProfileFixture(root,true);
 const project=process.env.LOCAL_AI_TEST_PROJECT_ROOT??join(root,'project');await mkdir(project,{recursive:true});
 fixture.db.updateConversation(fixture.chat.id,{title:'Native browser fixture',mode:'agent',workingDirectory:project,webMode:'auto'});
 const window=new BrowserWindow({width:1400,height:950,webPreferences:{preload:resolve('dist/preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const {ProjectBrowserSession}=require(resolve('dist/main/web/project-browser.js'));
 const {liveBrowsers}=require(resolve('dist/main/web/live-browser.js'));
 const {QaLoopGuard}=require(resolve('dist/main/web/qa-loop-guard.js'));
 const guard=new QaLoopGuard();let browser,run=0,approvals=0,frameIpc=0;
 const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,event,...rest)=>{if(channel==='live-browser:event'&&event.type==='frame')frameIpc++;return send(channel,event,...rest)};
 const approve=async()=>{approvals++;return{approved:true,reason:'once'}};
 global.nativeFixture={chat:fixture.chat.id,project,window,
  async open(args={}){await browser?.close();browser=new ProjectBrowserSession(project,join(root,'captures'),undefined,liveBrowsers.observer(window.webContents,fixture.chat.id,'native-'+(++run)),{guard});return browser.execute({action:'open',...args},new AbortController().signal,approve)},
  async execute(args){return browser.execute(args,new AbortController().signal,approve)},
  async finish(){return browser.finishRun()},async pause(){return browser.pauseRun()},
  async begin(){guard.rearm();browser.beginRun(liveBrowsers.observer(window.webContents,fixture.chat.id,'native-'+(++run)),{guard});return browser.execute({action:'read'},new AbortController().signal,approve)},
  async close(){this.abort?.abort();await this.promise?.catch(()=>{});await browser?.close();for(const item of this.runtime?.previews?.values()??[])await item.session.close()},
  async info(){const native=browser?.native;return{frameIpc,approvals,nativeId:native?.contents.id,pageCount:browser?.context?.pages().length,views:window.contentView.children.map(view=>({bounds:view.getBounds(),visible:view.getVisible?.()})),bounds:window.getContentBounds(),snapshot:browser?.page&&!browser.page.isClosed()?await browser.page.evaluate(()=>({url:globalThis.location.href,identity:window.identity,camera:window.__qaDiagnostics,keys:window.keyLog,clicks:window.clicks,input:globalThis.document.querySelector('#text')?.value,viewport:{width:globalThis.innerWidth,height:globalThis.innerHeight},frames:window.framesDrawn,scrollY:globalThis.scrollY,available:{require:typeof require,localAi:typeof window.localAi}})):null}},
  disconnect(){browser.native.contents.debugger.detach()},
  async unsafeLoad(url){try{await browser.native.contents.loadURL(url);return 'unexpected-navigation'}catch(error){return String(error)}},
  async security(){browser.native.contents.openDevTools({mode:"detach"});const devToolsOpened=browser.native.contents.isDevToolsOpened();if(devToolsOpened)browser.native.contents.closeDevTools();return {devToolsOpened,preferences:browser.native.contents.getLastWebPreferences(),...(await browser.page.evaluate(async()=>({serviceWorker:typeof navigator.serviceWorker,rtc:typeof RTCPeerConnection,popup:window.open('https://example.com')===null,fetchDenied:await fetch('http://127.0.0.1:1/no').then(()=>false,()=>true)}))) }},
  async backgroundFocus(){const{createNativeProjectPage}=require(resolve('dist/main/web/native-project-page.js'));const background=await createNativeProjectPage(window.webContents,'https://project-preview.invalid');browser.native.contents.focus();background.ownership('agent');const preserved=browser.native.contents.isFocused();await background.close();return preserved},
  async webgl(){return browser.page.evaluate(()=>{const canvas=globalThis.document.createElement('canvas');canvas.width=32;canvas.height=32;globalThis.document.body.append(canvas);const gl=canvas.getContext('webgl');if(!gl){canvas.remove();return{supported:false}}gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(1,1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);const extension=gl.getExtension('WEBGL_debug_renderer_info');const renderer=extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove();return{supported:true,pixel:Array.from(pixel),renderer}})},
  async screenshot(){return (await browser.native.contents.capturePage()).toPNG().toString('base64')},
  async pressWithoutRelease(selector){const box=await browser.page.locator(selector).boundingBox();browser.native.contents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)})},
  async keyboard(key,phase){browser.native.contents.sendInputEvent({type:phase==='down'?'keyDown':'keyUp',keyCode:key})},
  async startRealAgent(endpoint,model,prompt,context=32768,memory){
    await browser?.close();global.fetch=originalFetch;
    const settings=require(resolve('dist/main/services/runtime-settings.js'));settings.saveRuntimeConfiguration({...settings.loadRuntimeConfiguration(),browserVision:'on',autonomousBrowserQa:true});
    const {RustAgentRuntime}=require(resolve('dist/main/services/rust-agent-runtime.js'));const runtime=this.runtime??new RustAgentRuntime(endpoint);this.runtime=runtime;this.runId='native-real-'+Date.now();this.events=[];this.reports=[];this.agentError=null;this.finished=false;this.qaPhase=null;this.abort=new AbortController();this.history??=[];this.history.push({id:this.runId+'-user',conversationId:fixture.chat.id,role:'user',content:prompt,createdAt:new Date().toISOString()});this.persistSummary();
    this.promise=(async()=>{try{for await(const event of runtime.stream(model,[...this.history],[{id:'native-project',slot:1,root:project,label:'Native Canvas fixture'}],this.abort.signal,context,'fast','auto',this.runId,memory,fixture.chat.id,true,{fast:{chat_template_kwargs:{enable_thinking:false}},main:{chat_template_kwargs:{enable_thinking:false}},final:{chat_template_kwargs:{enable_thinking:false}}},[],undefined,approve,undefined,{mode:'strict',trusted_roots:[]},'native-real-task',liveBrowsers.observer(window.webContents,fixture.chat.id,this.runId),status=>{this.qaPhase=status.phase;if(status.report)this.reports.push(status.report);this.persistSummary()})){this.events.push(event);void appendFile(join(root,'agent-events.jsonl'),JSON.stringify(event)+'\n');if(event.type==='error')this.agentError=event}}catch(error){this.agentError=String(error)}finally{if(this.events.some(e=>e.type==='done'))this.history.push({id:this.runId+'-assistant',conversationId:fixture.chat.id,role:'assistant',content:this.events.filter(e=>e.type==='token').map(e=>e.content).join(''),createdAt:new Date().toISOString()});this.finished=true;writeFileSync(join(root,'agent-result.json'),JSON.stringify(this.realResult()));this.persistSummary()}})();
  },
  persistSummary(){writeFileSync(join(root,'agent-status.tmp'),this.realSummary());renameSync(join(root,'agent-status.tmp'),join(root,'agent-status.json'))},
  realSummary(){return JSON.stringify({finished:this.finished,error:this.agentError,qaPhase:this.qaPhase,reports:this.reports?.length,nativeViewId:[...liveBrowsers.entries.values()].find(entry=>entry.state.conversationId===fixture.chat.id&&!entry.ended)?.native?.contents.id})},
  realResult(){return{nativeViewId:[...liveBrowsers.entries.values()].find(entry=>entry.state.conversationId===fixture.chat.id&&!entry.ended)?.native?.contents.id,ownership:[...liveBrowsers.entries.values()].find(entry=>entry.state.conversationId===fixture.chat.id&&!entry.ended)?.state.ownership,qaPhase:this.qaPhase,runId:this.runId,finished:this.finished,error:this.agentError,reports:this.reports,events:this.events}},
  async target(selector){const box=await browser.page.locator(selector).boundingBox();const nativeBounds=window.contentView.children[0].getBounds(),windowBounds=window.getContentBounds();return{x:windowBounds.x+nativeBounds.x+box.x+box.width/2,y:windowBounds.y+nativeBounds.y+box.y+box.height/2}},
 };
 // Test driver commands avoid unstable long-lived Electron inspector promises.
 const commandFile=join(root,'native-command.json');let lastCommand;
 watchFile(commandFile,{interval:50},async()=>{
  let command;try{command=JSON.parse(readFileSync(commandFile,'utf8'))}catch{return}
  if(command.id===lastCommand)return;lastCommand=command.id;
  const ack={id:command.id};
  try{if(command.action==='stop')global.nativeFixture.abort.abort();else if(command.action==='pause')await global.nativeFixture.runtime.steer(global.nativeFixture.runId,'Pause','pause');else throw Error('Unknown fixture command')}catch(error){ack.error=String(error)}
  writeFileSync(join(root,'native-command-ack.tmp'),JSON.stringify(ack));renameSync(join(root,'native-command-ack.tmp'),join(root,'native-command-ack.json'));
 });
 app.once('before-quit',()=>unwatchFile(commandFile));
 await window.loadFile(resolve('dist/renderer/index.html'));
}).catch(error=>{console.error(error);app.exit(1)});
app.on('before-quit',()=>{void global.nativeFixture?.close()});
