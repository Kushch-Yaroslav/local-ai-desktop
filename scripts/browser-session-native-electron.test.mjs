// Scripted provider; actual Rust Agent Runtime, Electron, Native WebContentsView/CDP and ApprovalBroker.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-session-native-');await mkdir(join(root,'project'));await writeFile(join(root,'project/index.html'),'<title>Session native</title><input id="text"><script>window.identity=Math.random()</script>');
let app,phase='a',turn=0,waitingControl=false,fixtureError;let commandSerial=0;
const command=async(action)=>{
 const id='session-command-'+(++commandSerial);await writeFile(join(root,'native-command.tmp'),JSON.stringify({id,action}));await rename(join(root,'native-command.tmp'),join(root,'native-command.json'));
 for(let i=0;i<200;i++){let ack;try{ack=JSON.parse(await readFile(join(root,'native-command-ack.json'),'utf8'));}catch{/* File not published yet. */}if(ack?.id===id){assert(!ack.error,ack.error);return ack;}await new Promise(r=>setTimeout(r,20));}throw Error('Fixture command timeout '+action);
};
const frame=(delta,reason)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:reason}]})}\n\n`;
const server=createServer(async(req,res)=>{try{
 if(req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Loopback fixture</title><p>Approved project preview</p>');return;}
 for await(const chunk of req)void chunk;
 if(['pause','stop'].includes(phase)&&turn>=1){waitingControl=true;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(frame({reasoning_content:'Waiting for explicit user control.'},null));return;}
 if(['recover','loopback-recover'].includes(phase)&&turn===1){await command('drop-browser');await new Promise(r=>setTimeout(r,200));}
 const actions=phase==='recover'?[{action:'open',path:'index.html#before'},{action:'read'},{action:'read'},{action:'open',path:'index.html#recovered'},{action:'read'},{action:'screenshot'}]:[{action:'open',path:'index.html#scene'},{action:'screenshot'}];
 if(phase==='loopback-recover')actions.splice(0,actions.length,{action:'open',url:`http://127.0.0.1:${server.address().port}/index.html#first`},{action:'open',path:'index.html#restored'},{action:'screenshot'});
 if(phase==='foreign')actions.splice(1,0,{action:'open',project:2});
 if(phase==='a')actions.splice(1,0,{action:'qa'});
 const args=actions[turn++];res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(args?frame({tool_calls:[{index:0,id:phase+'-'+turn,type:'function',function:{name:'web_project',arguments:JSON.stringify(args)}}]},'tool_calls')+'data: [DONE]\n\n':frame({content:'Read-only browser check complete.'},'stop')+'data: [DONE]\n\n');
}catch(error){fixtureError=error;res.writeHead(500);res.end('Fixture control failed');}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${server.address().port}/v1/chat/completions`;
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/native-browser/workspace-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});await (await app.firstWindow()).locator('.conversation').waitFor();
 const start=async(name,options={})=>{phase=name;turn=0;waitingControl=false;await app.evaluate((_,args)=>global.nativeFixture.startRealAgent(args.endpoint,'scripted-browser',`Read-only: open the selected project and capture a screenshot. ${args.name}. Finish without editing files.`,32768,args.options.memory,args.options),{endpoint,name,options:{vision:'off',qa:false,sessionApproval:true,...options}});};
 let approvedCount=0;
 const finish=async(terminal='done',failure=false)=>{for(let i=0;i<600;i++){
   assert(!fixtureError,String(fixtureError));
   try{const pending=JSON.parse(await readFile(join(root,'browser-approvals.json'),'utf8'));if(pending.length>approvedCount){await command('approve-preview');approvedCount=pending.length;}}catch{/* Fixture state/ack file is not written yet. */}
   const status=JSON.parse(await readFile(join(root,'agent-status.json'),'utf8'));if(status.finished){const result=JSON.parse(await readFile(join(root,'agent-result.json'),'utf8'));assert(!result.error,JSON.stringify(result));assert(result.events.some(e=>e.type===terminal),JSON.stringify(result));assert.equal(result.events.some(e=>e.type==='tool'&&e.activity?.state==='error'),failure,JSON.stringify(result));return result;}await pause(50);
 }throw Error('Native scripted run timed out');};
 await start('a');const a=await finish();assert.equal(a.ownership,'user');const first=await app.evaluate(()=>global.nativeFixture.runtimeInfo());assert.equal(await app.evaluate(()=>global.nativeFixture.approvalRequests.length),1);
 await start('b');const b=await finish();assert.equal(b.ownership,'user');const second=await app.evaluate(()=>global.nativeFixture.runtimeInfo());assert.equal(first.nativeId,second.nativeId,'Run B reuses the same native Page');assert.equal(await app.evaluate(()=>global.nativeFixture.approvalRequests.length),1,'Chat grant survives runtime completion');
 await start('recover');const recovered=await finish('done',true);const outputs=recovered.events.filter(e=>e.type==='tool'&&e.activity?.output).map(e=>e.activity.output);assert(outputs.some(output=>output.includes('"recovered":true')),JSON.stringify(recovered));assert(outputs.some(output=>output.includes('DUPLICATE_FAILED_OPERATION')),'Unchanged failing read remains blocked');assert(recovered.events.some(e=>e.type==='tool'&&e.activity?.id==='recover-5'&&e.activity.state==='completed'),'The same read is allowed after actual Page recreation');assert.notEqual((await app.evaluate(()=>global.nativeFixture.runtimeInfo())).nativeId,second.nativeId,'Lost transport gets a new owned Page, once');
 await app.evaluate(()=>global.nativeFixture.closeRuntimePage());await start('after-user-close');await finish();assert((await app.evaluate(()=>global.nativeFixture.runtimeInfo())).identity.usable);
 for(const intent of ['pause','stop']){
   await start(intent);for(let i=0;!waitingControl&&i<300;i++)await pause(30);assert(waitingControl);await command(intent);const controlled=await finish(intent==='pause'?'paused':'cancelled');assert.equal(controlled.ownership,intent==='pause'?'paused':'user');
   const memory=controlled.events.findLast(e=>e.type==='task-memory')?.memory;await start('resume-'+intent,{memory});await finish();assert.equal(await app.evaluate(()=>global.nativeFixture.approvalRequests.length),1,'Pause/Stop continuation keeps chat grant and uses fresh signals');
 }
 await start('foreign');const foreign=await finish('done',true);assert(foreign.events.some(e=>e.type==='tool'&&e.activity?.output&&/Project 2 is not selected|Select an authorized project first/.test(e.activity.output)),'Unknown project is refused before preview approval');
 const approvals=await app.evaluate(()=>global.nativeFixture.approvalRequests.length);await start('autonomous',{mode:'autonomous'});await finish();assert.equal(await app.evaluate(()=>global.nativeFixture.approvalRequests.length),approvals,'Absolute autopilot does not prompt for registered read-only preview');
 await app.evaluate(()=>global.nativeFixture.closeRuntimePage());await start('loopback-recover',{mode:'autonomous'});await finish();assert.equal((await app.evaluate(()=>global.nativeFixture.runtimeInfo())).identity.origin,`http://127.0.0.1:${server.address().port}`,'Recreate must retain the approved localhost origin for project-relative navigation');
 console.log('PASS actual Electron/Rust/CDP with SCRIPTED provider: run A → user ownership → run B screenshot, one chat-session approval, same native Page, transport-loss bounded recreate within a run, duplicate failed read blocked then released only after real recreation, user close → authorized new run, real Pause/Resume and Stop/continuation, unregistered project refused, scoped autopilot without preview prompt, localhost origin retained through CDP recreation. No real Qwen/Vision inference.');
}finally{await app?.evaluate(async()=>global.nativeFixture.close()).catch(()=>{});await app?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
