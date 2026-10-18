// Real Rust + Chromium; scripted provider deliberately attempts a premature final.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const root=await mkdtemp('/tmp/lad-p2-gate-');process.env.LOCAL_AI_RUNTIME_ROOT=join(root,'runtime');const require=createRequire(import.meta.url);
const {ensureAppDirectories}=require('../dist/main/services/paths.js');ensureAppDirectories();
const {loadRuntimeConfiguration,saveRuntimeConfiguration}=require('../dist/main/services/runtime-settings.js');saveRuntimeConfiguration({...loadRuntimeConfiguration(),autonomousBrowserQa:true,browserVision:'off'});
await writeFile(join(root,'index.html'),'<title>Gate fixture</title><button id="inc" onclick="this.textContent=\'Done\'">Run</button>');
const requests=[],reports=[],events=[];let approvals=0;
const frame=(delta,finish=null)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});const n=requests.length;
 if(n===1||n===3){const args=n===1?{action:'open'}:{action:'qa',checks:[{action:'click',selector:'#inc',expect:{selector:'#inc',text:'Done'}}]};res.end(frame({tool_calls:[{index:0,id:`browser-${n}`,type:'function',function:{name:'web_project',arguments:JSON.stringify(args)}}]})+frame({},'tool_calls')+'data: [DONE]\n\n');}
 else res.end(frame({content:n===2?'Everything is visually verified.':'Functional checks passed; no image analysis was performed.'})+frame({},'stop')+'data: [DONE]\n\n');
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const {RustAgentRuntime}=require('../dist/main/services/rust-agent-runtime.js');const runtime=new RustAgentRuntime(`http://127.0.0.1:${server.address().port}/v1/chat/completions`);
 for await(const e of runtime.stream('qwen3.8:27b-q4_K_M',[{id:'u',conversationId:'gate',role:'user',content:'Check the local web app.',createdAt:new Date().toISOString()}],[{id:'p',root,slot:1,label:'fixture'}],AbortSignal.timeout(45000),32768,'fast','auto','gate-real-runtime',undefined,undefined,true,{},[],undefined,async()=>{approvals++;return{approved:true,reason:'once'};},undefined,{mode:'strict',trusted_roots:[]},undefined,undefined,s=>{if(s.report)reports.push(s.report);}))events.push(e);
 assert(requests.length>=4);assert(JSON.stringify(requests[2].messages).includes('Autonomous Browser QA review'));assert.equal(reports[0].status,'Verified');assert.equal(reports[0].visual.analyzed,false);assert.equal(approvals,1);assert(events.some(e=>e.type==='task-memory'&&e.memory.browser_qa?.status==='Verified'));assert(events.some(e=>e.type==='done'));assert(!events.filter(e=>e.type==='token').some(e=>e.content.includes('Everything is visually verified')),'premature final withheld');
 console.log(JSON.stringify({result:'PASS',provider:'scripted SSE, actual Rust and Chromium',requests:requests.length,approvals,qa:reports[0].status,visual:reports[0].visual.status}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
