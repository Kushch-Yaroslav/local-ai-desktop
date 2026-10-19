// Actual legacy display vs native display. No model loaded. Reports RAF, not claimed display presentation FPS.
import{_electron}from'playwright-core';import{mkdtemp,mkdir,readFile,writeFile}from'node:fs/promises';import{resolve,join}from'node:path';import{execFileSync}from'node:child_process';import{createRequire}from'node:module';
const require=createRequire(import.meta.url),ts=require('typescript'),esbuild=require('esbuild');
const root=await mkdtemp('/tmp/lad-native-perf-'),output=resolve('artifacts/native-browser');await mkdir(output,{recursive:true});await mkdir(join(root,'project'));
const oldHub=execFileSync('git',['show','cfa3237:src/main/web/live-browser.ts'],{encoding:'utf8'}),oldUi=execFileSync('git',['show','cfa3237:src/renderer/components/LiveBrowser.tsx'],{encoding:'utf8'});
await writeFile(join(root,'legacy-hub.cjs'),ts.transpileModule(oldHub,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
const css=await readFile(resolve('src/renderer/styles/app.css'),'utf8');
for(const[mode,source]of[['legacy',oldUi],['native',await readFile(resolve('src/renderer/components/LiveBrowser.tsx'),'utf8')]]){
 const entry=source.replace(/^import.*from ['"].*(?:shared\/locale|use-locale|ControlHelp)['"];?$/gm,'')+'\nconst t=s=>s;const useLocale=()=>{};const ControlHelp=()=>null;\nimport React from "react";import{createRoot}from"react-dom/client";createRoot(document.getElementById("root")).render(<LiveBrowserWorkspace conversationId="perf"><textarea id="typing" aria-label="Typing" /></LiveBrowserWorkspace>);window.perfTasks=[];window.inputRaf=[];new PerformanceObserver(list=>window.perfTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:"longtask",buffered:true});window.addEventListener("keydown",e=>requestAnimationFrame(()=>window.inputRaf.push(performance.now()-e.timeStamp)));';
 const bundle=await esbuild.build({stdin:{contents:entry,resolveDir:resolve('src/renderer/components'),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',minify:true});
 await writeFile(join(root,mode+'.js'),bundle.outputFiles[0].contents);
 await writeFile(join(root,mode+'.html'),`<style>${css}\nhtml,body,#root{height:100%;margin:0}#root{display:flex}textarea{width:90%;height:100px}.live-workspace{height:100%}</style><div id="root"></div><script src="${mode}.js"></script>`);
}
await writeFile(join(root,'project/index.html'),'<canvas width="1000" height="600"></canvas><script>const c=document.querySelector("canvas").getContext("2d");window.sceneFrames=0;window.marker=false;window.onkeydown=e=>{if(e.key==="ArrowRight"){e.preventDefault();window.marker=!window.marker}};function draw(){sceneFrames++;c.fillStyle="#123";c.fillRect(0,0,1000,600);for(let i=0;i<600;i++){c.fillStyle="hsl("+(i+sceneFrames)%360+" 50% 50%)";c.fillRect((i*37+sceneFrames)%1000,(i*13)%600,8,8)}c.fillStyle=window.marker?"#ff0000":"#0000ff";c.fillRect(0,0,64,64);requestAnimationFrame(draw)}draw()</script>');
const gpu=()=>{try{return execFileSync('nvidia-smi',['--query-gpu=utilization.gpu,memory.used,power.draw','--format=csv,noheader'],{encoding:'utf8'}).trim()}catch{return'unavailable'}};
const result={root,notes:['No model loaded; actual legacy component/hub at cfa3237 versus current native component/hub. Same display window and Canvas source.','Scene RAF is not measured compositor presentation FPS. Input latency is main UI key event timestamp to next RAF, not full OS input-to-photon.','Visible input latency is XTest key injection to an X11 XGetImage 1-pixel transition (polling upper bound, not photon timing).','GPU is shared with desktop/other apps; snapshots are not isolated per-process GPU costs.'],samples:[]};
for(const mode of ['legacy','native','legacy','native']){
 let app;try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/native-browser/perf-main.cjs')],env:{...process.env,LOCAL_AI_PERF_ROOT:root,LOCAL_AI_PERF_MODE:mode}});
 const ui=await app.firstWindow();await ui.locator('.mode-split').waitFor();await ui.waitForTimeout(1000);const before=await app.evaluate(()=>global.perf.sample());
 await ui.locator('#typing').pressSequentially('typing while a canvas animates',{delay:35});await ui.waitForTimeout(4000);const after=await app.evaluate(()=>global.perf.sample());const renderer=await ui.evaluate(()=>({longTasks:window.perfTasks,inputRaf:window.inputRaf,memory:performance.memory?.usedJSHeapSize,footer:document.querySelector('.live-footer').innerText}));
 await app.evaluate(()=>global.perf.handover());await ui.waitForTimeout(200);
 const geometry=await app.evaluate(async()=>({window:global.perf.window.getContentBounds(),viewport:global.perf.browser.page.viewportSize(),box:await global.perf.browser.page.locator('canvas').boundingBox()}));
 const surface=await ui.locator(mode==='legacy'?'.live-viewport canvas':'.native-browser-surface').boundingBox();
 const factor=mode==='legacy'?surface.width/geometry.viewport.width:1;
 const point={x:geometry.window.x+surface.x+(geometry.box.x+20)*factor,y:geometry.window.y+surface.y+(geometry.box.y+20)*factor};
 await app.evaluate(()=>global.perf.window.focus());execFileSync('python3',[resolve('scripts/native-input.py'),'click',String(point.x),String(point.y)]);await ui.waitForTimeout(150);
 const visibleInputLatencyMs=[];for(let i=0;i<3;i++){visibleInputLatencyMs.push(Number(execFileSync('python3',[resolve('scripts/native-input.py'),'latency',String(point.x),String(point.y)],{encoding:'utf8'}).trim()));await ui.waitForTimeout(150)}
 const captures=[];for(let i=0;i<3;i++)captures.push(await app.evaluate(()=>global.perf.screenshot()));
 result.samples.push({mode,seconds:(after.scene.at-before.scene.at)/1000,sceneRafFps:(after.scene.frames-before.scene.frames)/((after.scene.at-before.scene.at)/1000),frameIpc:after.count-before.count,base64Bytes:after.bytes-before.bytes,renderer,visibleInputLatencyMs,processes:after.processes,legacyProcesses:after.legacyProcesses,viewport:after.scene.viewport,captures,gpu:gpu()});
 console.log(JSON.stringify(result.samples.at(-1)));
 }finally{await app?.evaluate(()=>global.perf.close()).catch(()=>{});await app?.close()}
}
await writeFile(join(output,'performance-comparison.json'),JSON.stringify(result,null,2));
