// Scripted provider; real Rust, Chromium, served asset hashes and filesystem writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const root=await mkdtemp('/tmp/lad-scenario-gate-');process.env.LOCAL_AI_RUNTIME_ROOT=join(root,'runtime');
const require=createRequire(import.meta.url);require('../dist/main/services/paths.js').ensureAppDirectories();
const settings=require('../dist/main/services/runtime-settings.js');settings.saveRuntimeConfiguration({...settings.loadRuntimeConfiguration(),browserVision:'off',autonomousBrowserQa:false});
const source=n=>`window.__qaDiagnostics={camera:0};onkeydown=e=>{if(e.key==='w')window.__qaDiagnostics.camera+=${n}};`;
await writeFile(join(root,'index.html'),'<title>Camera</title><canvas tabindex="0"></canvas><script src="app.js"></script>');await writeFile(join(root,'app.js'),source(1));
const spec={target:'/index.html',preconditions:[{source:'visible',selector:'canvas',operator:'equals',expected:true}],required_state:[],steps:[{action:'hold',key:'w',selector:'canvas',duration_ms:450}],assertion:{source:'diagnostic',path:'camera',operator:'increased'},timeout_ms:3000};
const events=[],requests=[],reports=[];let queue=[],index=0,memory,oldProof;
const call=(name,args)=>[name,args],deliver=args=>call('deliverables',args);
const proof=()=>memory?.verification?.records.findLast(r=>r.pass&&r.coverage?.some(c=>c.deliverable_id==='camera'))?.id;
const frame=(delta,reason)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:reason}]})}\n\n`;
const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const request=JSON.parse(Buffer.concat(chunks));requests.push(request);res.writeHead(200,{'Content-Type':'text/event-stream'});let action=queue[index++];if(typeof action==='function')action=action();res.end(action?frame({tool_calls:[{index:0,id:'gate-'+index,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]},'tool_calls')+'data: [DONE]\n\n':frame({content:'Only the mapped camera criterion was checked. Other visual and temporal properties remain unverified.'},'stop')+'data: [DONE]\n\n');});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const{RustAgentRuntime}=require('../dist/main/services/rust-agent-runtime.js');const runtime=new RustAgentRuntime(`http://127.0.0.1:${server.address().port}/v1/chat/completions`);
 const run=async saved=>{for await(const event of runtime.stream('qwen3.8:27b-q4_K_M',[{id:'u',conversationId:'scenario-gate',role:'user',content:'Check exactly the forward camera requirement. Preserve independent evidence and explain limitations.',createdAt:new Date().toISOString()}],[{id:'p',slot:1,root,label:'fixture'}],AbortSignal.timeout(120000),65536,'fast','auto','scenario-gate',saved,undefined,true,{},[],undefined,async()=>({approved:true,reason:'once'}),undefined,{mode:'autonomous',trusted_roots:[]},undefined,undefined,status=>{if(status.report)reports.push(status.report)})){events.push(event);if(event.type==='task-memory')memory=event.memory;}};
 queue=[
  deliver({action:'add',id:'camera',text:'Holding forward changes the camera',check:'browser',criteria:[{id:'forward',description:'Actual camera response after a bounded hold',kind:'interaction',scenario:spec}]}),
  deliver({action:'implemented',id:'camera',evidence:'index.html and app.js inspected'}),
  call('web_project',{action:'open',path:'index.html',deliverable_id:'camera',criterion_id:'forward'}),
  call('web_project',{action:'qa',scenario_refs:[{deliverable_id:'camera',criterion_id:'forward'}]}),
  ()=>{oldProof=proof();assert(oldProof);return deliver({action:'verify',id:'camera',evidence_ids:[oldProof]});},
  call('write_file',{path:'independent.html',content:'<title>Independent document</title>'}),
  ()=>deliver({action:'verify',id:'camera',evidence_ids:[oldProof]}),
  call('write_file',{path:'app.js',content:source(2)}),
  ...Array.from({length:3},()=>()=>deliver({action:'verify',id:'camera',evidence_ids:[oldProof]})),
  call('read_file',{path:'app.js'}),
  call('web_project',{action:'qa',scenario_refs:[{deliverable_id:'camera',criterion_id:'forward'}]}),
  ()=>deliver({action:'verify',id:'camera',evidence_ids:[proof()]})
 ];await run();
 const results=requests.flatMap(r=>r.messages.filter(m=>m.role==='tool').map(m=>m.content));const combined=results.join('\n');
 assert.match(combined,/Browser open can prove only load/);assert.match(combined,/EVIDENCE_STALE/);assert.match(combined,/VERIFY_NO_PROGRESS/);
 assert.equal(memory.deliverables.items[0].status,'verified',JSON.stringify(memory.deliverables));assert.notEqual(proof(),oldProof);assert.equal(reports.length,2);assert(reports.every(r=>r.scenarios[0].status==='Verified'));
 const checkpoint=memory;const mark=events.length;index=0;requests.length=0;queue=[()=>deliver({action:'verify',id:'camera',evidence_ids:[proof()]}),call('web_project',{action:'qa',scenario_refs:[{deliverable_id:'camera',criterion_id:'forward'}]}),()=>deliver({action:'verify',id:'camera',evidence_ids:[proof()]})];await run(checkpoint);
 assert.match(requests.flatMap(r=>r.messages.filter(m=>m.role==='tool').map(m=>m.content)).join('\n'),/EVIDENCE_STALE/);assert.equal(memory.deliverables.items[0].status,'verified');assert.equal(memory.deliverables.items[0].criteria[0].scenario.steps[0].duration_ms,450);assert(events.slice(mark).some(e=>e.type==='done'));
 const output=resolve('docs/test-results/scenario-qa');await mkdir(output,{recursive:true});await writeFile(join(output,'gate-runtime.json'),JSON.stringify({result:'PASS',root,provider:'scripted; real Rust/Chromium/filesystem',checks:['open cannot prove interaction','immutable scenario_refs','actual 450ms hold','independent edit retains proof','served app.js edit stales proof','identical verify loop blocked','other tools continue','fresh retest verifies','next run retains criteria but requires fresh execution'],reports,memory},null,2));console.log('PASS scenario gate: scoped proof, relevant freshness, verify loop, retest and next run');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
