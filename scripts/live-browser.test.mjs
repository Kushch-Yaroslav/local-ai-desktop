// State/ownership contract with real Chromium. Native rendering/input is tested by native-browser.test.mjs.
import assert from 'node:assert/strict';import{EventEmitter}from'node:events';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{createRequire}from'node:module';
const require=createRequire(import.meta.url),{ProjectBrowserSession}=require('../dist/main/web/project-browser.js'),{LiveBrowserHub}=require('../dist/main/web/live-browser.js');
const root=await mkdtemp('/tmp/lad-browser-state-'),hub=new LiveBrowserHub(),events=[];
class Owner extends EventEmitter{constructor(id){super();this.id=id}isDestroyed(){return false}send(channel,event){assert.equal(channel,'live-browser:event');events.push(event)}}
const owner=new Owner(1),foreign=new Owner(2),observer=hub.observer(owner,'chat','run'),signal=new AbortController().signal;let page,approvals=0;
const session=new ProjectBrowserSession(root,join(root,'captures'),undefined,{...observer,ready(p,visible,controls){page=p;observer.ready(p,visible,controls)}});
const approve=async()=>{approvals++;return{approved:true}};const call=async args=>{const r=await session.execute(args,signal,approve);assert(!r.error,JSON.stringify(r));return r};
try{
 await writeFile(join(root,'index.html'),'<title>Shared Page</title><a id="next" href="#next">Next</a><input id="field"><script>window.identity=Math.random()</script>');hub.watch(owner,'chat',true);assert.throws(()=>hub.watch(owner,{},true));await call({action:'open'});const identity=await page.evaluate(()=>window.identity);const state=()=>events.at(-1).state;
 assert.equal(page.context().pages().length,1);assert(events.every(e=>e.type==='state'),'no image/frame transport');
 await call({action:'click',selector:'#next'});assert.match(state().url,/#next$/);await call({action:'back'});assert(!page.url().includes('#next'));await call({action:'forward'});assert.match(page.url(),/#next$/);
 await session.finishRun();assert.equal(state().ownership,'user');await hub.input(owner,state().sessionId,{kind:'text',text:'hello'});await assert.rejects(hub.input(foreign,state().sessionId,{kind:'reload'}));
 hub.watch(owner,'chat',false);await assert.rejects(hub.input(owner,state().sessionId,{kind:'reload'}));assert.equal(await page.evaluate(()=>window.identity),identity);hub.watch(owner,'other',true);const n=events.length;await call({action:'read'});assert.equal(events.length,n,'other chat does not receive state');hub.watch(owner,'chat',true);
 session.beginRun(hub.observer(owner,'chat','next-run'));await call({action:'read'});assert.equal(approvals,2);assert.equal(await page.evaluate(()=>window.identity),identity);assert.equal(state().ownership,'agent');await assert.rejects(hub.input(owner,state().sessionId,{kind:'reload'}));await session.pauseRun();assert.equal(state().ownership,'paused');
 await call({action:'fill',selector:'#field',value:'works'});assert.equal(await page.locator('#field').inputValue(),'works');const cancel=new AbortController();const pending=session.execute({action:'click',selector:'#missing'},cancel.signal,approve);setTimeout(()=>cancel.abort(),50);assert((await pending).error);assert(!session.reusable);await session.close();assert.equal(state().ownership,'closed');
 console.log('PASS state-only browser hub: same Page, ownership/paused, repeated run approval, navigation, chat/window isolation, hidden input deny and in-flight cancellation.');
}finally{await session.close();await rm(root,{recursive:true,force:true})}
