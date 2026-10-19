const{app,BrowserWindow,ipcMain}=require('electron');const{resolve,join}=require('node:path');
process.env.LOCAL_AI_RUNTIME_ROOT=process.env.LOCAL_AI_PERF_ROOT;
app.setPath('userData',join(process.env.LOCAL_AI_PERF_ROOT,'data'));
app.whenReady().then(async()=>{
 const native=process.env.LOCAL_AI_PERF_MODE==='native';
 const {LiveBrowserHub}=require(native?resolve('dist/main/web/live-browser.js'):join(process.env.LOCAL_AI_PERF_ROOT,'legacy-hub.cjs'));
 const hub=new LiveBrowserHub();const window=new BrowserWindow({width:1280,height:850,webPreferences:{preload:resolve('test-fixtures/native-browser/perf-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const {readFile}=require('node:fs/promises');
 const frames={count:0,bytes:0,states:0};const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,event)=>{if(event.type==='frame'){frames.count++;frames.bytes+=Buffer.byteLength(event.frame.data)}else frames.states++;send(channel,event)};
 ipcMain.handle('live-browser:watch',(event,...args)=>hub.watch(event.sender,...args));
 ipcMain.handle('live-browser:layout',(event,...args)=>hub.layout?.(event.sender,...args));
 ipcMain.on('live-browser:ack',(event,...args)=>hub.acknowledge?.(event.sender,...args));
 ipcMain.handle('live-browser:input',(event,...args)=>hub.input(event.sender,...args));
 ipcMain.handle('live-browser:close',(event,...args)=>hub.close(event.sender,...args));
 const{ProjectBrowserSession}=require(resolve('dist/main/web/project-browser.js'));
 const browser=new ProjectBrowserSession(join(process.env.LOCAL_AI_PERF_ROOT,'project'),join(process.env.LOCAL_AI_PERF_ROOT,'captures'),undefined,hub.observer(window.webContents,'perf','perf'));
 global.perf={window,browser,frames,async sample(){let legacyProcesses=[];if(!native){const cdp=await browser.browser.newBrowserCDPSession();const info=await cdp.send('SystemInfo.getProcessInfo');await cdp.detach();legacyProcesses=await Promise.all(info.processInfo.map(async p=>{let rssKiB=null;try{rssKiB=Number((await readFile('/proc/'+p.id+'/status','utf8')).match(/^VmRSS:\s+(\d+)/m)?.[1])}catch{/* process exited */}return{...p,rssKiB}}))}return{legacyProcesses,...frames,scene:await browser.page.evaluate(()=>({frames:window.sceneFrames,at:performance.now(),viewport:{width:globalThis.innerWidth,height:globalThis.innerHeight}})),processes:app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,cpu:p.cpu.percentCPUUsage,rssKiB:p.memory.workingSetSize}))}},async handover(){await browser.finishRun()},
 async screenshot(){const start=performance.now();const bytes=await browser.page.screenshot();return{ms:performance.now()-start,bytes:bytes.length}},async close(){await browser.close()}};
 await window.loadFile(join(process.env.LOCAL_AI_PERF_ROOT,process.env.LOCAL_AI_PERF_MODE+'.html'));
 await browser.execute({action:'open'},new AbortController().signal,async()=>({approved:true}));
}).catch(error=>{console.error(error);app.exit(1)});
