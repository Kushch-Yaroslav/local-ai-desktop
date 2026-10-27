// Real Rust/Chromium: equivalent validation failures pause and remain bounded on Continue.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const root=await mkdtemp('/tmp/lad-invalid-qa-');process.env.LOCAL_AI_RUNTIME_ROOT=await mkdtemp('/tmp/lad-isolated-invalid-qa-continuation-app-');
const require=createRequire(import.meta.url);require('../dist/main/services/paths.js').ensureAppDirectories();
const settings=require('../dist/main/services/runtime-settings.js');settings.saveRuntimeConfiguration({...settings.loadRuntimeConfiguration(),browserVision:'off'});
await writeFile(join(root,'index.html'),'<div id="target" style="font-family:Georgia">Fixture</div>');
const {RustAgentRuntime}=require('../dist/main/services/rust-agent-runtime.js');
let actions=[],requests=0,memory;const events=[];
const invalid=()=>['web_project',{action:'qa',scenarios:[{id:'font-'+requests,goal:'Requested font',target:'/index.html',viewport:{width:1280,height:900},preconditions:[],required_state:[],steps:[],assertion:{source:'style',path:'font-family',operator:'equals',expected:'Georgia'},timeout_ms:5000}]}];
const server=createServer(async(req,res)=>{for await(const _ of req){void _;}requests++;let a=actions.shift();if(typeof a==='function')a=a();const delta=a?{tool_calls:[{index:0,id:'invalid-'+requests,type:'function',function:{name:a[0],arguments:JSON.stringify(a[1])}}]}:{content:'No valid criterion check ran.'};res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:a?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 const runtime=new RustAgentRuntime(`http://127.0.0.1:${server.address().port}/v1/chat/completions`);
 const run=async(saved,runId)=>{for await(const e of runtime.stream('fixture',[{id:runId,conversationId:'invalid',role:'user',content:'Check the registered font requirement. Report no unsupported verification.',logicalTaskId:'invalid-task',createdAt:new Date().toISOString()}],[{id:'project',slot:1,root,label:'temporary fixture'}],AbortSignal.timeout(60000),65536,'fast','auto',runId,saved,'invalid',true,{},[],undefined,async()=>({approved:true,reason:'once'}),undefined,{mode:'autonomous',trusted_roots:[]},'invalid-task')){events.push(e);if(e.type==='task-memory')memory=e.memory;}};
 const spec={target:'/index.html',viewport:{width:1280,height:900},preconditions:[],required_state:[],steps:[],assertion:{source:'style',selector:'#target',path:'font-family',operator:'equals',expected:'Georgia'},timeout_ms:5000};
 actions=[['deliverables',{action:'add',id:'font',text:'Registered font criterion',check:'browser',criteria:[{id:'computed-font',description:'Measured font',kind:'runtime',scenario:spec}]}],['deliverables',{action:'implemented',id:'font',evidence:'Fixture exists, verification still required'}],['web_project',{action:'open',path:'index.html'}],invalid,invalid,invalid,invalid];
 await run(undefined,'invalid-first');assert.equal(memory.stop_reason,'repeated_tool_failure');assert.equal(memory.deliverables.items[0].status,'implemented');assert.equal(actions.length,0);const firstRequests=requests;
 const first=structuredClone(memory);actions=[invalid];await run(first,'invalid-continue');assert.equal(requests-firstRequests,1,'Continuation cannot reset equivalent-failure guard');assert.equal(memory.stop_reason,'repeated_tool_failure');assert.equal(memory.deliverables.items[0].status,'implemented');assert(!memory.verification.records.some(r=>r.pass&&r.coverage?.some(c=>c.deliverable_id==='font')));
 const result={result:'PASS',provider:'scripted; real Rust and Chromium',invalidCallsFirstRun:4,invalidCallsAfterContinue:1,stopReason:memory.stop_reason,status:memory.deliverables.items[0].status,loopEvents:events.filter(e=>e.type==='loop-event').length};await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,root}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
