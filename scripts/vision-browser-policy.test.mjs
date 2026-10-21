// Real Chromium pixels + production provider; JSON responses are explicit fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const root=await mkdtemp('/tmp/lad-vision-browser-policy-');process.env.LOCAL_AI_RUNTIME_ROOT=join(root,'runtime');
const require=createRequire(import.meta.url),{ProjectBrowserSession}=require('../dist/main/web/project-browser'),{BrowserVisionProvider}=require('../dist/main/services/browser-vision');
let posts=0;const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;res.setHeader('Content-Type','application/json');if(req.url==='/v1/models')res.end(JSON.stringify({models:[{id:'fixture',capabilities:['multimodal']}]}));else{posts++;const request=JSON.parse(body);assert(request.messages[1].content.some(p=>p.type==='image_url'));assert(!request.chat_template_kwargs,'No Qwen-only request controls leak into generic image analysis');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'FIXTURE observation',confidence:.6,issues:[]})}}]}));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${server.address().port}/v1/chat/completions`,auto=new BrowserVisionProvider(endpoint,'fixture','auto'),off=new BrowserVisionProvider(endpoint,'fixture','off');
await writeFile(join(root,'index.html'),'<title>Capture policy</title><h1>DOM remains available</h1><button id="test">Click</button>');
const session=new ProjectBrowserSession(root,join(root,'captures'),undefined,undefined,{analyze:(capture,signal,before,question)=>auto.analyze(capture,signal,before,question)});
const signal=AbortSignal.timeout(60000),approve=async()=>({approved:true,reason:'once'});
try{
 await session.execute({action:'open',path:'index.html'},signal,approve);
 const capture=await session.execute({action:'screenshot'},signal,approve);assert.equal(capture.visual_analysis,false);assert.equal(posts,0);
 const analyzed=await session.execute({action:'screenshot',analyze:true},signal,approve);assert.equal(analyzed.visual_analysis,true,JSON.stringify(analyzed.visual));assert.equal(posts,1);
 await auto.analyze(analyzed.capture,signal,undefined,{goal:'explicit inspection',temporal:false,purpose:'requested'});assert.equal(posts,2,'A different question is a distinct analysis');
 await auto.analyze(analyzed.capture,signal,undefined,{goal:'explicit inspection',temporal:false,purpose:'requested'});assert.equal(posts,2,'identical capture/question reuses analysis');
 await off.analyze(analyzed.capture,signal,undefined,{goal:'explicit',temporal:false,purpose:'requested'});assert.equal(posts,2,'Off cannot be bypassed by a visual question');
 await session.execute({action:'screenshot',analyze:false},signal,approve);assert.equal(posts,2);
 await session.execute({action:'open',path:'index.html#another-route'},signal,approve);const another=await session.execute({action:'screenshot',analyze:true},signal,approve);assert.equal(another.capture.sha256,analyzed.capture.sha256);assert.equal(posts,3,'An identical image at another route cannot reuse scoped Vision evidence');
 const dom=await session.execute({action:'read'},signal,approve);assert(dom);console.log(JSON.stringify({result:'PASS',root,scope:'Real Chromium capture/provider HTTP; explicit fixture Vision response',checks:['Auto raw capture does not infer','explicit screenshot question sends real PNG','duplicate frame/question cache','Off suppresses inference','capture-only flag','DOM unaffected','route-aware cache prevents cross-route evidence reuse']}));
}finally{await session.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
