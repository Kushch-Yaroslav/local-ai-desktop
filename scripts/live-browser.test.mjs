import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProjectBrowserSession } = require('../dist/main/web/project-browser.js');
const { LiveBrowserHub } = require('../dist/main/web/live-browser.js');
const { launchWebBrowser } = require('../dist/main/web/web-tools.js');
const root = await mkdtemp(join(tmpdir(), 'lad-live-browser-'));
const hub = new LiveBrowserHub(), events = [];
let autoack = true, launches = 0, browser, page, httpSession, server;
class Owner extends EventEmitter {
  constructor(id) { super(); this.id = id; }
  isDestroyed() { return false; }
  send(channel, event) { assert.equal(channel, 'live-browser:event'); events.push(event); if (event.type === 'frame' && autoack) hub.acknowledge(this, event.frame.sessionId, event.frame.sequence); }
}
const owner = new Owner(1), foreign = new Owner(2);
const approve = async () => ({ approved: true });
const observer = hub.observer(owner, 'chat-A', 'run-A');
const session = new ProjectBrowserSession(root, join(root, 'captures'), async () => { launches++; browser = await launchWebBrowser(); return browser; }, { ...observer, ready(p) { page = p; observer.ready(p); } });
const signal = new AbortController().signal;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async condition => { const start=Date.now(); while (!condition()) { if(Date.now()-start>6000)throw Error('condition timed out');await sleep(25); } };
const frames = () => events.filter(e => e.type === 'frame');
const exec = async args => { const result=await session.execute(args,signal,approve);assert(!result.error,JSON.stringify(result));return result; };
try {
  await writeFile(join(root,'index.html'),`<!doctype html><title>Shared Page</title><style>body{margin:0;background:#162331;color:white}canvas{display:block}footer{margin-top:1400px}</style><canvas width="900" height="400"></canvas><a id="next" href="#second">Next</a><input id="field"><footer>Footer</footer><script>const c=document.querySelector('canvas').getContext('2d');let n=0;function draw(){c.fillStyle='hsl('+(n++%360)+' 65% 40%)';c.fillRect(0,0,900,400);c.fillStyle='white';c.fillRect(n%850,100,50,50);requestAnimationFrame(draw)}draw();window.identity=Math.random();</script>`);
  hub.watch(owner,'chat-A',true);
  assert.throws(()=>hub.watch(owner,{},true));
  await exec({action:'open'}); await wait(()=>frames().length>=5);
  const identity=await page.evaluate(()=>window.identity);
  assert.equal(launches,1);assert.equal(browser.contexts().length,1);assert.equal(browser.contexts()[0].pages().length,1);
  const start=frames().length,time=Date.now();await sleep(2200);
  const measured=(frames().length-start)/((Date.now()-time)/1000);
  assert(measured>3 && measured<=13,`FPS ${measured}`);assert(new Set(frames().slice(-5).map(e=>e.frame.data)).size>=4,'animation frames differ');
  await exec({action:'click',selector:'#next'});assert.match((await exec({action:'read'})).url,/#second$/);
  await exec({action:'back'});assert(!(await exec({action:'read'})).url.includes('#second'));
  await exec({action:'forward'});assert.match((await exec({action:'read'})).url,/#second$/);
  await exec({action:'fill',selector:'#field',value:'same page'});assert.equal(await page.locator('#field').inputValue(),'same page');
  await exec({action:'scroll',delta_y:600});assert(await page.evaluate(()=>scrollY)>0);
  const actions=events.filter(e=>e.type==='state').map(e=>e.state.action?.kind);for(const kind of ['click','fill','scroll','back','forward'])assert(actions.includes(kind));
  await exec({action:'scroll',delta_y:-600});
  hub.watch(owner,'chat-A',false);await sleep(250);const hidden=frames().length;await sleep(550);assert.equal(frames().length,hidden,'hidden screencast stops');
  assert.equal(await page.evaluate(()=>window.identity),identity,'hide preserves Page state');
  hub.watch(owner,'chat-A',true);await wait(()=>frames().length>hidden+2);assert.equal(launches,1);
  autoack=false;const before=frames().length;await sleep(600);assert(frames().length-before<=1,'bounded renderer backpressure');
  autoack=true;const latest=frames().at(-1).frame;hub.acknowledge(owner,latest.sessionId,latest.sequence);await wait(()=>frames().length>before+2);
  hub.watch(owner,'chat-B',true);await sleep(250);const switched=frames().length;await sleep(350);assert.equal(frames().length,switched,'no chat-A frames in chat-B');
  hub.watch(foreign,'chat-A',true);await sleep(200);assert.equal(frames().length,switched,'foreign owner cannot subscribe');
  hub.watch(owner,'chat-A',true);
  // White-box fault injection detaches only the observation channel, never the Page.
  const feed=[...hub.entries.values()].find(entry=>entry.state.conversationId==='chat-A');await feed.cdp.detach();
  await wait(()=>events.some(e=>e.type==='state'&&e.state.sessionId===feed.state.sessionId&&e.state.status==='error'));
  const disconnected=frames().length;hub.watch(owner,'chat-A',true);await wait(()=>frames().length>disconnected+2);assert.equal(launches,1,'reconnect observes the existing browser');
  await writeFile(join(root,'index.html'),'<title>Edited</title><style>body{background:lime}</style><h1>Updated project</h1>');
  assert.equal((await exec({action:'reload'})).title,'Edited');assert.equal(launches,1);
  const stop = new AbortController(); const pending=session.execute({action:'click',selector:'#never-exists'},stop.signal,approve);setTimeout(()=>stop.abort(),100);assert((await pending).error);
  await wait(()=>!browser.isConnected());await wait(()=>events.some(e=>e.type==='state'&&e.state.status==='ended'));
  const final=frames().at(-1).frame;hub.watch(owner,'chat-A',true);assert.equal(frames().at(-1).frame.sessionId,final.sessionId,'final frame retained');
  const crashObserver = hub.observer(owner,'chat-A','new-run');let crashBrowser;
  const crash = new ProjectBrowserSession(root,join(root,'captures'),async()=>{crashBrowser=await launchWebBrowser();return crashBrowser;},crashObserver);
  const replacement=await crash.execute({action:'open'},signal,approve);assert(!replacement.error);
  const newState=events.findLast(e=>e.type==='state').state;assert.notEqual(newState.sessionId,final.sessionId,'new run has a new session identity');
  await crashBrowser.close();await wait(()=>events.some(e=>e.type==='state'&&e.state.sessionId===newState.sessionId&&e.state.status==='error'));await crash.close();
  const unavailableSession = new ProjectBrowserSession(root,join(root,'captures'),async()=>{throw Error('missing browser fixture');},hub.observer(owner,'missing','missing-run'));
  hub.watch(owner,'missing',true);assert.equal((await unavailableSession.execute({action:'open'},signal,approve)).code,'BROWSER_UNAVAILABLE');assert(events.some(e=>e.type==='state'&&e.state.conversationId==='missing'&&e.state.status==='error'));
  server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<title>Loopback Live</title><canvas></canvas><script>let n=0,c=document.querySelector("canvas").getContext("2d");function draw(){c.fillStyle="hsl("+(n++%360)+" 80% 50%)";c.fillRect(0,0,300,150);requestAnimationFrame(draw)}draw()</script>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  httpSession=new ProjectBrowserSession(root,join(root,'captures'),launchWebBrowser,hub.observer(owner,'http-chat','http-run'));
  hub.watch(owner,'http-chat',true);
  const loopback=await httpSession.execute({action:'open',url:`http://127.0.0.1:${server.address().port}/`},signal,approve);assert(!loopback.error,JSON.stringify(loopback));assert.equal(loopback.title,'Loopback Live');
  await wait(()=>frames().filter(e=>e.frame.conversationId==='http-chat').length>=4);
  assert(new Set(frames().filter(e=>e.frame.conversationId==='http-chat').map(e=>e.frame.data)).size>=3,'approved HTTP loopback animates in the same stream');
  console.log(JSON.stringify({result:'PASS',fps:Number(measured.toFixed(2)),frames:frames().length,uniqueFrames:new Set(frames().map(e=>e.frame.data)).size,launches,samePage:true,backpressure:true,hidden:true,isolation:true,stop:true,editReload:true,loopback:true,reconnect:true}));
} finally { await httpSession?.close();await new Promise(resolve=>server ? server.close(resolve) : resolve());await session.close();await rm(root,{recursive:true,force:true}); }
