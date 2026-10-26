// Same scripted sequence for four configurations; real Rust, Chromium and Ledger.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const root=await mkdtemp('/tmp/lad-css-qa-matrix-');process.env.LOCAL_AI_RUNTIME_ROOT=join(root,'runtime');
const require=createRequire(import.meta.url);require('../dist/main/services/paths.js').ensureAppDirectories();
const settings=require('../dist/main/services/runtime-settings.js');settings.saveRuntimeConfiguration({...settings.loadRuntimeConfiguration(),browserVision:'off'});
const {RustAgentRuntime}=require('../dist/main/services/rust-agent-runtime.js');
let actions=[],memory,requests=[],finals=0;
const frame=(delta,reason)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:reason}]})}\n\n`;
const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const payload=JSON.parse(Buffer.concat(chunks));requests.push(payload);let action=actions.shift();if(typeof action==='function')action=action();if(!action)finals++;res.writeHead(200,{'content-type':'text/event-stream'});res.end((action?frame({tool_calls:[{index:0,id:'matrix-'+requests.length,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]},'tool_calls'):frame({content:'Computed CSS matches the registered criterion. PNG capture alone is not visual observation.'},'stop'))+'data: [DONE]\n\n');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const results=[];
try{
 for(const scenario of ['background','grayscale'])for(const enabled of [true,false]){
  const project=join(root,scenario+'-'+enabled);await mkdir(project);
  const old=scenario==='background'?'background:#fd03b9':'filter:grayscale(1)',replacement=scenario==='background'?'background:#fff':'',property=scenario==='background'?'background-color':'filter',expected=scenario==='background'?'rgb(255, 255, 255)':'none';
  await writeFile(join(project,'style.css'),`#target{width:120px;height:120px;background:red;${old}}`);
  await writeFile(join(project,'index.html'),'<link rel="stylesheet" href="style.css"><div id="target">Fixture</div>');
  const specification={target:'/index.html',viewport:{width:1280,height:900},preconditions:[],required_state:[],steps:[],assertion:{source:'style',selector:'#target',path:property,operator:'equals',expected},timeout_ms:5000};
  memory=undefined;requests=[];finals=0;
  actions=[['deliverables',{action:'add',id:'css',text:'Correct the selected CSS property',check:'browser',paths:[join(project,'style.css')],criteria:[{id:'computed',description:'Expected computed CSS at the original viewport',kind:'runtime',scenario:specification}]}],['read_file',{path:'style.css'}],['replace_text',{path:'style.css',old_text:old,new_text:replacement}],['web_project',{action:'open',path:'index.html'}],['web_project',{action:'inspect',selector:'#target'}],['web_project',{action:'screenshot',analyze:false}],['deliverables',{action:'implemented',id:'css',evidence:'Changed style.css and observed current computed CSS'}],['web_project',{action:'qa',scenario_refs:[{deliverable_id:'css',criterion_id:'computed'}]}],()=>{const proof=memory.verification.records.findLast(r=>r.pass&&r.coverage?.some(c=>c.deliverable_id==='css'&&c.criterion_id==='computed'));if(!proof){writeFileSync(join(root,'failed-evidence.json'),JSON.stringify({memory,tools:requests.flatMap(p=>p.messages.filter(m=>m.role==='tool').map(m=>m.content))},null,2));console.error('Fixture evidence:',root);}assert(proof);return ['deliverables',{action:'verify',id:'css',evidence:proof.id}];}];
  const runtime=new RustAgentRuntime(`http://127.0.0.1:${server.address().port}/v1/chat/completions`),events=[];
  for await(const event of runtime.stream('fixture',[{id:'user',conversationId:'matrix',role:'user',content:'Correct this CSS property and use the registered computed CSS criterion. State evidence honestly.',createdAt:new Date().toISOString()}],[{id:'project',slot:1,root:project,label:'temporary fixture'}],AbortSignal.timeout(120000),65536,'fast','auto','matrix-'+scenario+'-'+enabled,undefined,'matrix',true,{},[],undefined,async()=>({approved:true,reason:'once'}),undefined,{mode:'autonomous',trusted_roots:[]},'matrix-task-'+scenario+'-'+enabled,undefined,undefined,'off',enabled)){
   events.push(event);if(event.type==='task-memory')memory=event.memory;
  }
  assert(events.some(e=>e.type==='done'));assert.equal(memory.deliverables.items[0].status,'verified');
  const wire=JSON.stringify(requests);assert.equal(wire.includes('Adaptive verification:'),enabled);assert(!wire.includes('data:image/'));assert(!wire.includes('"type":"image_url"'));
  const tools=events.filter(e=>e.type==='tool').map(e=>e.activity).filter(Boolean);
  const toolResults=requests.flatMap(p=>p.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content.split('\n[observation')[0]);}catch{return null;}})).filter(Boolean);
  assert.equal(toolResults.find(r=>r.inspection)?.inspection?.elements?.[0]?.styles?.[property],expected);
  const capture=toolResults.find(r=>r.screenshot_path);assert(capture);assert.equal(capture.pixels_available_to_task_model,false);assert.equal(capture.vision_input.state,'not-sent');assert.equal(capture.qa.status,'Not Verified');
  results.push({scenario,qaEnabled:enabled,additionalPolicy:enabled,tools:requests[0].tools.map(t=>t.function.name),toolSequence:tools.filter(t=>t.state==='running').map(t=>({tool:t.toolName,action:t.arguments?.action??null})),inspection:toolResults.find(r=>r.inspection)?.inspection?.elements?.[0]?.styles?.[property],screenshotCalls:1,imageAttachments:0,criterionIds:memory.deliverables.items[0].criteria.map(c=>c.id),evidence:memory.verification.records.map(r=>({id:r.id,kind:r.kind,pass:r.pass,outcome:r.outcome,coverage:r.coverage,sourceRevisions:Object.values(r.source_revisions??{})})),verification:memory.deliverables.items[0].status,additionalReviews:finals-1});
 }
 for(const i of [0,2]){assert.deepEqual(results[i].tools,results[i+1].tools);assert.deepEqual(results[i].toolSequence,results[i+1].toolSequence);assert.equal(results[i].screenshotCalls,results[i+1].screenshotCalls);}
 assert.equal(results[0].additionalReviews,results[1].additionalReviews);assert.equal(results[2].additionalReviews,results[3].additionalReviews);
 await writeFile(join(root,'result.json'),JSON.stringify({result:'PASS',provider:'deterministic; real Rust and Chromium, Vision Off',results},null,2));console.log(JSON.stringify({result:'PASS',root,cases:results.length}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
