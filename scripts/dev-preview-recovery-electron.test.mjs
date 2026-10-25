// Real Vite build + real Native Page. Servers belong to THIS harness, never to a user.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
const run=promisify(execFile),root=await mkdtemp('/tmp/lad-dev-recovery-'),project=await mkdtemp('/tmp/lad-dev-recovery-project-');
await symlink(resolve('node_modules'),join(project,'node_modules'),'dir');
await writeFile(join(project,'package.json'),JSON.stringify({private:true,type:'module',scripts:{build:'vite build',preview:'vite preview'}}));
await writeFile(join(project,'vite.config.ts'),"import{defineConfig}from'vite';import react from'@vitejs/plugin-react';export default defineConfig({plugins:[react()],build:{outDir:'artifacts'}});");
await writeFile(join(project,'index.html'),'<div id="root"></div><script type="module" src="/App.jsx"></script>');
const component="import React from'react';import{createRoot}from'react-dom/client';import s from'./Card.module.css';createRoot(document.getElementById('root')).render(<button id='card' className={s.card}>Card</button>);";
await writeFile(join(project,'App.jsx'),component);await writeFile(join(project,'Card.module.css'),'.card{background:#ffe4e6;border-radius:2px}');
let server,app;const delay=ms=>new Promise(r=>setTimeout(r,ms));const until=async(fn,label)=>{for(let i=0;i<100;i++){if(await fn())return;await delay(100);}throw Error(label);};
const start=async port=>{server=await createServer({configFile:join(project,'vite.config.ts'),root:project,server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[project,resolve('node_modules')]}}});await server.listen();};
try{
 await start(0);const port=server.httpServer.address().port,url=`http://127.0.0.1:${port}/?currency=EUR#/it/product/1`;
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();const chat=await app.evaluate(()=>global.visualFixture.chat);
 await ui.evaluate(({chat,url})=>window.localAi.visualDebug.open(chat,url),{chat,url});
 const sample=()=>app.evaluate(()=>global.visualFixture.entry().page.locator('#card').evaluate(e=>({background:getComputedStyle(e).backgroundColor,radius:getComputedStyle(e).borderRadius})));
 await until(async()=>(await sample()).background==='rgb(255, 228, 230)','Initial CSS');
 const area=await ui.evaluate(async chat=>{const d=await window.localAi.visualDebug.command(chat,{action:'new-area'});const area=d.issues.at(-1);await window.localAi.visualDebug.command(chat,{action:'selection',enabled:true,groupId:area.id});return area;},chat);
 await app.evaluate(()=>global.visualFixture.drag('#card'));await until(async()=>(await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat)).regions.length===1,'Actual original region');await ui.evaluate(chat=>window.localAi.visualDebug.command(chat,{action:'selection',enabled:false}),chat);
 const sessionId=await app.evaluate(()=>global.visualFixture.entry().state.sessionId);await ui.evaluate(id=>window.localAi.liveBrowser.workspace(id,{viewport:{width:1440,height:900},zoom:1.25,scale:.75,pan:{x:90,y:40},layout:'horizontal',toolsWidth:290,previewScale:.75}),sessionId);
 const before=await app.evaluate(()=>({id:global.visualFixture.entry().native.contents.id,workspace:global.visualFixture.entry().native.workspaceState().settings}));
 const execute=args=>app.evaluate(async(_,args)=>global.visualFixture.session.execute(args,new AbortController().signal,async()=>({approved:true,reason:'once'})),args);
 await writeFile(join(project,'Card.module.css'),'.card{background:#fff;border-radius:28px}');await until(async()=>(await sample()).background==='rgb(255, 255, 255)','HMR CSS');
 await writeFile(join(root,'watcher-before.json'),JSON.stringify(await app.evaluate(()=>{const s=global.visualFixture.session;return {vite:s.viteManaged,server:s.serverManaged,outputs:s.watcher?.outputDirectories,files:[...s.watcher?.files??[]]};}),null,2));
 const build=await run('npm',['run','build'],{cwd:project,timeout:60000,maxBuffer:1024*1024});await writeFile(join(root,'build.log'),build.stdout+build.stderr);
 const afterBuildInspection=await execute({action:'inspect',selector:'#card'});await writeFile(join(root,'after-build-inspection.json'),JSON.stringify(afterBuildInspection,null,2));await writeFile(join(root,'watcher-after.json'),JSON.stringify(await app.evaluate(()=>{const s=global.visualFixture.session;return {vite:s.viteManaged,outputs:s.watcher?.outputDirectories,files:[...s.watcher?.files??[]]};}),null,2));assert.equal(afterBuildInspection.inspection.elements[0].styles['background-color'],'rgb(255, 255, 255)');assert.notEqual(afterBuildInspection.freshness.status,'possibly-stale','Build output must not masquerade as a newer source edit');
 let status=await execute({action:'preview_status'});assert.equal(status.status,'responding',JSON.stringify(status));assert(status.assets.length);assert.equal(status.original_url,url);assert.equal(status.formal_verification,false);assert.match(status.process_ownership,/unknown/);
 // Existing server remains live after build. Never treat its port as app ownership.
 assert.equal((await sample()).background,'rgb(255, 255, 255)');
 const refused=await execute({action:'open',url:`http://127.0.0.1:${port}/dist/index.html`});assert.equal(refused.code,'BUILD_ARTIFACT_ON_DEV_SERVER');assert.equal(refused.retrySameArguments,false);assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.url()),url);
 const customBuild=await execute({action:'open',url:`http://127.0.0.1:${port}/artifacts/index.html`});assert.equal(customBuild.code,'BUILD_ARTIFACT_ON_DEV_SERVER','Literal configured output directory is guarded too');
 const qaFallback=await execute({action:'qa',scenarios:[{id:'bad-build-fallback',goal:'Must not navigate built HTML on dev origin',target:'/artifacts/index.html',viewport:{width:390,height:844},preconditions:[],required_state:[],steps:[],assertion:{source:'layout',operator:'equals',expected:0},timeout_ms:1000}]});assert.equal(qaFallback.code,'BUILD_ARTIFACT_ON_DEV_SERVER','Refuse before creating isolated QA target too');
 const responsiveFallback=await execute({action:'qa',path:'artifacts/index.html',responsive:{reason:'Reject invalid production fallback',viewports:[{width:390,height:844}]}});assert.equal(responsiveFallback.code,'BUILD_ARTIFACT_ON_DEV_SERVER','Generated responsive targets are guarded too');
 const wrongOrigin=await execute({action:'open',url:`http://127.0.0.1:${port+1}/`});assert.equal(wrongOrigin.code,'PREVIEW_ORIGIN_SCOPE_MISMATCH');
 const preview=await run('npm',['run','preview','--','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:project,timeout:10000,maxBuffer:1024*1024}).then(()=>({failed:false}),e=>({failed:true,message:e.stderr}));assert(preview.failed);assert.match(preview.message,/already in use/);
 assert.equal((await execute({action:'preview_status'})).status,'responding','Failed production preview must not affect existing dev server');
 await writeFile(join(project,'App.jsx'),component+'\n!!!invalid syntax');await assert.rejects(run('npm',['run','build'],{cwd:project,timeout:60000,maxBuffer:1024*1024}));await writeFile(join(project,'App.jsx'),component);await until(async()=>(await sample()).radius==='28px','Fast Refresh after failed build');
 // Stop only the exact createServer handle owned by this harness. App cannot adopt it.
 await server.close();server=undefined;status=await execute({action:'preview_status'});assert.equal(status.status,'unreachable');assert.equal(status.code,'DEV_PREVIEW_UNREACHABLE');assert.equal(status.retrySameArguments,false);assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.url()),url);
 assert(!(JSON.parse(await readFile(join(project,'package.json'),'utf8')).scripts.dev),'Missing dev script must not be invented');
 // Simulate explicit owner-approved recovery at the same port; no app auto-start/kill.
 await start(port);assert.equal((await execute({action:'preview_status'})).status,'responding');
 await execute({action:'reload'});await until(async()=>(await sample()).background==='rgb(255, 255, 255)','Original route recovered');
 const originalRegion=(await ui.evaluate(chat=>window.localAi.visualDebug.document(chat),chat)).regions.find(r=>r.groupId===area.id);
 await app.evaluate((_,{url,originalRegion})=>{const s=global.visualFixture.session;s.beginRun(s.observer,{...s.qaOptions,regionContext:[{id:originalRegion.id,groupId:originalRegion.groupId,url,viewport:originalRegion.viewport}]});},{url,originalRegion});
 await execute({action:'open',url:url.replace('/?currency=EUR#/it/product/1','/?currency=EUR#/supplementary')});
 assert.match(await app.evaluate(()=>global.visualFixture.entry().page.url()),/supplementary/);
 await app.evaluate(()=>global.visualFixture.session.finishRun());
 assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.url()),url,'Normal finish restores original route after supplementary verification');

 const after=await app.evaluate(()=>({id:global.visualFixture.entry().native.contents.id,workspace:global.visualFixture.entry().native.workspaceState().settings}));assert.deepEqual(after,before);assert.equal(await app.evaluate(()=>global.visualFixture.entry().page.url()),url);
 const result={result:'PASS',root,url,checks:['actual npm build leaves dev alive','HTTP/entry assets probe without navigation','wrong build URL rejected before goto','failed preview preserves live dev','failed build + Fast Refresh','unreachable external ownership remains unknown; no automatic process actions','same-port owner recovery','missing dev script','custom Vite outDir guarded','supplementary route restored on normal finish','same Native Page/query/hash/viewport/zoom/scale/pan']};await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await app?.close();await server?.close();}
