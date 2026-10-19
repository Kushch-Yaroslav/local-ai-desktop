import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {ProjectBrowserSession}=require('../dist/main/web/project-browser.js');
const {LiveBrowserHub}=require('../dist/main/web/live-browser.js');
const {launchWebBrowser}=require('../dist/main/web/web-tools.js');
const root=await mkdtemp(join(tmpdir(),'lad-auto-project-')),outside=await mkdtemp(join(tmpdir(),'lad-auto-outside-'));
const hub=new LiveBrowserHub();let frames=0,launches=0,page,browser,loads=0;const actions=[];
class Owner extends EventEmitter {constructor(){super();this.id=123;}isDestroyed(){return false;}send(_channel,event){if(event.type==='frame'){frames++;}else if(event.state.action)actions.push(event.state.action);}}
const owner=new Owner(),observe=hub.observer(owner,'auto-chat','auto-run');
const session=new ProjectBrowserSession(root,join(outside,'captures'),async()=>{launches++;browser=await launchWebBrowser();return browser;},{...observe,ready(p,visibility){page=p;observe.ready(p,visibility);}});
const signal=new AbortController().signal,approve=async()=>({approved:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(condition,label)=>{const start=Date.now();while(true){try{if(await condition())return;}catch{/* navigation replaces execution context */}if(Date.now()-start>8000)throw Error('Timeout: '+label);await sleep(40);}};
const execute=async args=>{const result=await session.execute(args,signal,approve);assert(!result.error,JSON.stringify(result));return result;};
const css='body{background:rgb(10, 20, 30)}';
const script=version=>`window.version=${version};document.querySelector('#button').onclick=()=>{localStorage.setItem('clicked',String(window.version));localStorage.setItem('clickColor',getComputedStyle(document.body).backgroundColor)};document.querySelector('#input').oninput=e=>localStorage.setItem('filled',e.target.value);let n=0,c=document.querySelector('canvas').getContext('2d');function draw(){c.fillStyle='hsl('+(n++%360)+' 80% 50%)';c.fillRect(0,0,300,150);requestAnimationFrame(draw)}draw();`;
const html='<title>Auto test</title><link rel="stylesheet" href="assets/site.css"><h1>Old HTML</h1><button id="button">Click</button><input id="input"><canvas></canvas><script src="assets/site.js"></script>';
let server,http,hmr;
try {
  await mkdir(join(root,'assets'));await writeFile(join(root,'index.html'),html);await writeFile(join(root,'assets/site.css'),css);await writeFile(join(root,'assets/site.js'),script(1));
  hub.watch(owner,'auto-chat',true);await execute({action:'open'});page.on('load',()=>loads++);
  await wait(()=>session.watcher?.settled,'watcher starts');const original=page;
  await writeFile(join(root,'index.html'),html.replace('Old HTML','Updated HTML'));
  await wait(async()=>await page.locator('h1').textContent()==='Updated HTML','HTML refresh');
  await writeFile(join(root,'assets/site.css'),'body{background:rgb(80, 90, 100)}');
  await wait(async()=>await page.evaluate(()=>getComputedStyle(document.body).backgroundColor)==='rgb(80, 90, 100)','CSS refresh');
  await writeFile(join(root,'assets/site.js'),script(2));await wait(async()=>await page.evaluate(()=>window.version)===2,'JS refresh');
  await execute({action:'click',selector:'#button'});assert.equal(await page.evaluate(()=>localStorage.getItem('clicked')),'2');
  await sleep(700);const burstStart=loads;
  for(let n=0;n<12;n++){await writeFile(join(root,'assets/site.css'),`body{background:rgb(${100+n}, 30, 40)}`);await sleep(25);}
  await wait(()=>loads>burstStart,'burst refresh');await sleep(700);assert.equal(loads-burstStart,1,'12 saves coalesce to one reload');
  const beforeLog=loads;const logWriter=setInterval(()=>{void writeFile(join(root,'activity.log'),String(Date.now())).catch(()=>undefined);},30);
  try {await writeFile(join(root,'assets/site.css'),'body{background:rgb(111, 30, 40)}/*while log writes*/');await wait(()=>loads>beforeLog,'irrelevant log traffic must not starve web changes');} finally {clearInterval(logWriter);}
  await sleep(650);const idle=loads;
  await writeFile(join(outside,'external.js'),'changed');await writeFile(join(root,'notes.txt'),'irrelevant');await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules/ignored.js'),'ignored');await mkdir(join(root,'.cache'));await writeFile(join(root,'.cache/ignored.css'),'ignored');await symlink(outside,join(root,'linked'));await writeFile(join(outside,'external.js'),'changed again');await sleep(1000);assert.equal(loads,idle,'outside/irrelevant/temporary/symlink changes ignored');
  await mkdir(join(root,'new/deep'),{recursive:true});await writeFile(join(root,'new/deep/nested.js'),'new');await wait(()=>loads>idle,'new nested directory detected');await sleep(500);const nested=loads;
  await writeFile(join(root,'new/deep/save.tmp'),'atomic JS');await rename(join(root,'new/deep/save.tmp'),join(root,'new/deep/nested.js'));await wait(()=>loads>nested,'atomic nested save detected');
  await sleep(600);await page.evaluate(()=>{document.querySelector('#button').disabled=true;setTimeout(()=>document.querySelector('#button').disabled=false,1200);});
  const beforeClick=loads,click=session.execute({action:'click',selector:'#button',wait_ms:300},signal,approve);await sleep(100);await writeFile(join(root,'assets/site.css'),'body{background:rgb(3, 4, 5)}');assert(!(await click).error,'click must finish before auto reload');
  await wait(()=>loads>beforeClick,'refresh after click');assert.equal(await page.evaluate(()=>localStorage.getItem('clickColor')),'rgb(111, 30, 40)','click used original document');
  await sleep(600);await page.evaluate(()=>{document.querySelector('#input').readOnly=true;setTimeout(()=>document.querySelector('#input').readOnly=false,1200);});
  const beforeFill=loads,fill=session.execute({action:'fill',selector:'#input',value:'uninterrupted',wait_ms:300},signal,approve);await sleep(100);await writeFile(join(root,'assets/site.js'),script(3));assert(!(await fill).error,'fill must finish before auto reload');
  await wait(()=>loads>beforeFill,'refresh after fill');assert.equal(await page.evaluate(()=>localStorage.getItem('filled')),'uninterrupted');
  await sleep(600);hub.watch(owner,'auto-chat',false);const hidden=loads;await writeFile(join(root,'index.html'),html.replace('Old HTML','Hidden update'));await sleep(900);assert.equal(loads,hidden,'no hidden reload');
  hub.watch(owner,'other-chat',true);await sleep(500);assert.equal(loads,hidden,'other chat cannot refresh this Page');
  hub.watch(owner,'auto-chat',true);await wait(async()=>await page.locator('h1').textContent()==='Hidden update','reopen applies pending edits');
  const animated=await page.screenshot();await sleep(200);assert(!animated.equals(await page.screenshot()),'real Canvas continues after reload without frame IPC');assert.equal(frames,0);assert.equal(page,original);assert.equal(launches,1);
  // Flush edits even if a task finishes before the 400 ms watcher debounce.
  let finalHeading;page.once('load',()=>{void page.locator('h1').textContent().then(text=>finalHeading=text).catch(()=>undefined);});
  await writeFile(join(root,'index.html'),html.replace('Old HTML','Final update'));const finalWatcher=session.watcher;await session.close(true);assert.equal(finalWatcher.watches.size,0);assert.equal(finalWatcher.timer,undefined);assert(!browser.isConnected());assert.equal(finalHeading,'Final update','task finish flushes the actual latest DOM');
  assert(actions.some(a=>a.kind==='auto-reload'));const closed=loads;await writeFile(join(root,'assets/site.css'),css);await sleep(600);assert.equal(loads,closed);
  // Ordinary loopback static servers auto-refresh; recognizable dev/HMR servers are left alone.
  let managed=false,stall=false;
  server=createServer(async(req,res)=>{if(stall)return;res.setHeader('Content-Type','text/html');res.end(managed?'<title>Vite</title><script type="module" src="/@vite/client"></script>':await readFile(join(root,'index.html')));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const make=id=>new ProjectBrowserSession(root,join(outside,'captures'),launchWebBrowser,hub.observer(owner,id,id));
  http=make('http');hub.watch(owner,'http',true);assert(!(await http.execute({action:'open',url:`http://127.0.0.1:${server.address().port}/`},signal,approve)).error);assert(http.watcher);
  await writeFile(join(root,'index.html'),html.replace('Old HTML','HTTP updated'));await wait(async()=>await http.page.locator('h1').textContent()==='HTTP updated','plain HTTP auto refresh');await http.close();
  managed=true;hmr=make('hmr');hub.watch(owner,'hmr',true);assert(!(await hmr.execute({action:'open',url:`http://127.0.0.1:${server.address().port}/`},signal,approve)).error);assert.equal(hmr.watcher,undefined,'Vite HMR does not get another watcher');await hmr.close();
  managed=false;const finishing=make('finish-stop');hub.watch(owner,'finish-stop',true);await finishing.execute({action:'open',url:`http://127.0.0.1:${server.address().port}/`},signal,approve);
  await writeFile(join(root,'index.html'),html.replace('Old HTML','Stop final refresh'));stall=true;const stoppingAt=Date.now(),finishingWork=finishing.close(true);setTimeout(()=>{void finishing.close();},100);await finishingWork;assert(Date.now()-stoppingAt<2000,'Stop must interrupt a final auto-refresh');stall=false;
  // Stop disposes pending refresh and directory watches immediately.
  const stopped=make('stop');hub.watch(owner,'stop',true);managed=false;await stopped.execute({action:'open'},signal,approve);const stopWatcher=stopped.watcher;const cancel=new AbortController();const blocked=stopped.execute({action:'click',selector:'#missing'},cancel.signal,approve);await writeFile(join(root,'assets/site.css'),css+'/*stop*/');setTimeout(()=>cancel.abort(),100);assert((await blocked).error);assert.equal(stopWatcher.watches.size,0);await stopped.close();
  const hiddenFinish=make('hidden-finish');hub.watch(owner,'hidden-finish',true);await hiddenFinish.execute({action:'open'},signal,approve);
  const hiddenEntry=[...hub.entries.values()].find(e=>e.state.conversationId==='hidden-finish');
  hub.watch(owner,'hidden-finish',false);let lastHeading;hiddenFinish.page.once('load',()=>{void hiddenFinish.page.locator('h1').textContent().then(text=>lastHeading=text).catch(()=>undefined);});
  await writeFile(join(root,'index.html'),html.replace('Old HTML','Finished while hidden'));await hiddenFinish.close(true);assert.equal(lastHeading,'Finished while hidden');assert.equal(frames,0,'no hidden final-frame transport');assert.equal(hiddenEntry.state.status,'ended');
  const withoutLive=new ProjectBrowserSession(root,join(outside,'captures'));await withoutLive.execute({action:'open'},signal,approve);assert.equal(withoutLive.watcher,undefined);await withoutLive.close();
  console.log(JSON.stringify({result:'PASS',html:true,css:true,javascript:true,burstSaves:12,burstReloads:1,nested:true,atomicSave:true,scope:true,irrelevantLogTraffic:true,symlinks:true,clickFillSerialized:true,hiddenAndChatSwitch:true,canvas:true,loopback:true,hmrSkipped:true,stop:true,finishFlush:true,hiddenFinish:true,stopDuringFinish:true,noLiveNoWatcher:true,loads,frames}));
} finally {await session.close();await http?.close();await hmr?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
