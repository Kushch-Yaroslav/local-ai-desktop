// Actual Chromium + production approvals/session/loader. No LLM inference.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const root=await mkdtemp('/tmp/lad-session-chromium-');process.env.LOCAL_AI_RUNTIME_ROOT=join(root,'runtime');
const require=createRequire(import.meta.url);require('../dist/main/services/paths.js').ensureAppDirectories();
const {ProjectBrowserSession}=require('../dist/main/web/project-browser.js'),{ApprovalBroker}=require('../dist/main/services/approval-broker.js'),{LiveBrowserHub}=require('../dist/main/web/live-browser.js');
await writeFile(join(root,'index.html'),'<title>Session A</title><input><script>window.identity=Math.random()</script>');
const broker=new ApprovalBroker(1000),hub=new LiveBrowserHub(),states=[];let prompts=0,decision='session',run='a';
class Sender extends EventEmitter{id=1;isDestroyed(){return false}send(channel,e){if(channel==='chat:stream'&&e.type==='approval-request'){prompts++;queueMicrotask(()=>broker.reply(1,{conversationId:'chat',generationId:e.generationId,approvalId:e.approval.approvalId,decision}));}if(channel==='live-browser:event')states.push(e.state);}}
const sender=new Sender();hub.watch(sender,'chat',true);
const conf=()=>broker.forRun(sender,'chat',run,{mode:'strict',roots:[root]});
let confirm=conf(),controller=new AbortController(),page;
const observer=()=>{const o=hub.observer(sender,'chat',run);return {...o,ready(p,v,c){page=p;o.ready(p,v,c)}}};
const session=new ProjectBrowserSession(root,join(root,'captures'),undefined,observer(),{projectId:'p1',securityMode:'strict'});
const call=async args=>{const result=await session.execute(args,controller.signal,confirm);assert(!result.error,JSON.stringify(result));return result;};
try{
 await call({action:'open',path:'index.html#scene'});const identity=await page.evaluate(()=>window.identity);await call({action:'qa'});await session.finishRun(false);assert.equal(states.at(-1).ownership,'user');broker.endRun(run);controller.abort();
 const readChat=hub.chatDiagnosticReader(sender,'chat');assert(readChat,'Approved static Browser must be readable in Chat');
 const diagnosticSignal=new AbortController().signal,priorUrl=page.url(),priorPrompts=prompts,diagnosticIdentity=await page.evaluate(()=>window.identity);
 assert(JSON.stringify(await readChat({action:'read'},diagnosticSignal)).includes('Session A'));
 await readChat({action:'inspect',selector:'input'},diagnosticSignal);
 for(const args of [{action:'click',selector:'input'},{action:'open',url:'https://example.com'},{action:'read',script:'document.body.remove()'}])await assert.rejects(readChat(args,diagnosticSignal),/read-only/);
 assert.equal(page.url(),priorUrl);assert.equal(await page.evaluate(()=>window.identity),diagnosticIdentity);assert.equal(states.at(-1).ownership,'user');assert.equal(prompts,priorPrompts);assert.equal(hub.chatDiagnosticReader(sender,'another-chat'),undefined);
 run='b';controller=new AbortController();confirm=conf();session.beginRun(observer(),{projectId:'p1',securityMode:'strict',signal:new AbortController().signal});await call({action:'open',path:'index.html#scene'});await call({action:'screenshot'});assert.equal(prompts,1,'Conversation grant spans runs and tools');assert.equal(states.at(-1).ownership,'agent');
 await session.pauseRun();assert.equal(states.at(-1).ownership,'paused');await session.finishRun(false);broker.endRun(run);
 run='resume';confirm=conf();session.beginRun(observer(),{projectId:'p1',securityMode:'strict'});await call({action:'read'});assert.equal(prompts,1);await session.finishRun(false);
 await writeFile(join(root,'index.html'),'<title>Session edited</title><input>');await new Promise(r=>setTimeout(r,1000));assert.equal(await page.title(),'Session edited','Live watcher remains usable after run handover');
 const bad=await session.execute({action:'open',url:'http://127.0.0.1:9/other'},controller.signal,confirm);assert(bad.error);assert(!page.isClosed());await session.finishRun(false);assert(!page.isClosed(),'A rejected operation must not destroy the previously approved user preview at run finish');await call({action:'read'});
 broker.revoke('chat');decision='once';const beforeOnce=prompts;await Promise.all([call({action:'read'}),call({action:'read'})]);assert.equal(prompts,beforeOnce+2,'Once permits just the requested operation');
 await session.close(false,'user_closed');await assert.rejects(readChat({action:'read'},diagnosticSignal),/unavailable/);const closed=await session.execute({action:'read'},controller.signal,confirm);assert.equal(closed.code,'BROWSER_SESSION_UNAVAILABLE');assert.equal(closed.browser_session.reason,'user_closed');
 console.log('PASS actual Chromium: run A/B, QA+screenshot, ended/aborted old signal, persistent chat grant, once per operation, ownership Pause/Resume, live reload, scoped origin refusal preserves Page, explicit close.');
 void identity;
}finally{await session.close();}
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Loopback</title><p>same project</p>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port,url=`http://127.0.0.1:${port}/index.html`,auto=new ProjectBrowserSession(root,join(root,'auto'),undefined,hub.observer(sender,'loopback-chat','loopback-run'),{projectId:'p1',securityMode:'autonomous'});
hub.watch(sender,'loopback-chat',true);
let calls=0;const forbidden=async()=>{calls++;return {approved:false,reason:'user_rejected'}};
try{
 const a=await auto.execute({action:'open',url},new AbortController().signal,forbidden);assert(!a.error,JSON.stringify(a));const b=await auto.execute({action:'open',path:'index.html#scene'},new AbortController().signal,forbidden);assert(!b.error,JSON.stringify(b));assert.equal(new URL(b.url).origin,new URL(url).origin,'Project-relative reopen preserves approved localhost');
 server.closeAllConnections();await new Promise(r=>server.close(r));await auto.page.reload({timeout:3000}).catch(()=>undefined);await new Promise(r=>setTimeout(r,200));await auto.operations;auto.beginRun(hub.observer(sender,'loopback-chat','loopback-next'),{projectId:'p1',securityMode:'autonomous'});assert.equal(states.at(-1).status,'error','A retained Chromium error page must not be advertised as live on the next run');assert(!auto.page.isClosed(),'A stopped preview server is not a permanently closed browser');await new Promise(r=>server.listen(port,'127.0.0.1',r));const recoveredServer=await auto.execute({action:'open',path:'index.html#server-back'},new AbortController().signal,forbidden);assert(!recoveredServer.error,JSON.stringify(recoveredServer));
 assert.equal(calls,0);assert((await auto.execute({action:'open',url:'https://example.com/'},new AbortController().signal,forbidden)).error);assert.equal(calls,0);
 const other=join(root,'other');await mkdir(other);await writeFile(join(other,'index.html'),'<p>other</p>');const strict=new ProjectBrowserSession(other,join(root,'other-captures'));const denied=await strict.execute({action:'open'},new AbortController().signal,forbidden);assert.equal(denied.code,'PERMISSION_DENIED');await strict.close();assert.equal(calls,1);
 console.log('PASS actual loopback Chromium: autopilot bypasses only scoped preview approval, external origin denied, other project still checked, path navigation stays on approved localhost, real server shutdown/restart recovers without destroying Page.');
}finally{await auto.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
