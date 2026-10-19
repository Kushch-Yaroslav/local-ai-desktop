// Real Chromium and production browser security/QA. No inference is mocked as vision.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),root=await mkdtemp('/tmp/lad-p2-qa-');
process.env.LOCAL_AI_RUNTIME_ROOT=join(root,'runtime');
const {ProjectBrowserSession}=require('../dist/main/web/project-browser.js');
const states=[],session=new ProjectBrowserSession(root,join(root,'evidence'),undefined,undefined,{status:s=>states.push(s)}),signal=new AbortController().signal;
const approve=async()=>({approved:true,reason:'once'});
const html=broken=>`<!doctype html><title>QA fixture</title><style>body{margin:0}canvas{display:block}button{padding:10px}</style><canvas width="640" height="300" tabindex="0"></canvas><button id="inc">Increment</button><output id="count">0</output><input id="message"><script>let active=true,n=0;const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');function frame(){if(!active)return;ctx.fillStyle='hsl('+(n++%360)+' 60% 50%)';ctx.fillRect(0,0,640,300);requestAnimationFrame(frame)}frame();canvas.onmousemove=()=>{${broken?"active=false;throw new Error('camera rotation defect');":"n+=2;"}};document.querySelector('#inc').onclick=()=>document.querySelector('#count').textContent='1';</script>`;
const checks=[{action:'click',selector:'#inc',expect:{selector:'#count',text:'1'}},{action:'fill',selector:'#message',value:'QA input',expect:{selector:'#message',value:'QA input'}}];
try{
 await writeFile(join(root,'index.html'),html(true));
 const first=await session.execute({action:'qa',checks},signal,approve);assert.equal(first.qa.status,'Failed');assert(first.qa.errors.some(e=>e.includes('camera rotation defect')));assert(first.qa.checks.some(c=>c.action==='canvas animation'&&c.status==='Failed'));assert.equal(first.visual_analysis,false);assert.equal(first.qa.visual.analyzed,false);assert.equal(JSON.parse(await readFile(first.qa.evidencePath,'utf8')).status,'Failed');
 await writeFile(join(root,'index.html'),html(false));
 const second=await session.execute({action:'qa',checks},signal,approve);assert.equal(second.qa.status,'Partially Verified',JSON.stringify(second));assert.equal(second.qa.errors.length,0);assert.notEqual(first.qa.sourceFingerprint,second.qa.sourceFingerprint);assert(second.qa.checks.some(c=>c.action==='canvas animation'&&c.status==='Verified'));assert.equal(second.qa.visual.analyzed,false,'functional Verified is not visual Verified');
 const capture=await session.execute({action:'screenshot',selector:'#inc'},signal,approve);assert(capture.capture.width<1280&&capture.capture.height<900);assert.equal(capture.capture.selector,'#inc');assert(capture.capture.sha256);
 const region=await session.execute({action:'screenshot',clip:{x:10,y:10,width:100,height:100}},signal,approve);assert.equal(region.capture.width,100);assert.equal(region.capture.region.x,10);
 const refused=await session.execute({action:'screenshot',clip:{x:-1,y:0,width:100,height:100}},signal,approve);assert(refused.error);
 const last=await session.execute({action:'qa'},signal,approve);assert.equal(last.qa.status,'Partially Verified','smoke test must not certify arbitrary application behaviour');
 assert.notEqual((await session.execute({action:'qa'},signal,approve)).code,'QA_LIMIT');for(let i=0;i<6;i++)assert(!(await session.execute({action:'screenshot'},signal,approve)).error);assert.equal((await session.execute({action:'screenshot'},signal,approve)).code,'SCREENSHOT_LIMIT');assert(session.reusable,'screenshot budget must not dispose the live Page');
 await session.close();
 await writeFile(join(root,'index.html'),'<title>Numeric fixture</title><button id="off" style="position:absolute;left:-300px">Offscreen</button><canvas width="400" height="200" tabindex="0"></canvas><script>const c=document.querySelector("canvas");window.__qaDiagnostics={camera:{x:NaN}};c.onkeydown=()=>Promise.reject(new Error("keyboard rejection"));let ctx=c.getContext("2d");function frame(){ctx.fillRect(0,0,100,100);requestAnimationFrame(frame)}frame();</script>');
 const numeric=new ProjectBrowserSession(root,join(root,'numeric'));try{const value=await numeric.execute({action:'qa'},signal,approve);assert.equal(value.qa.status,'Failed');assert(value.qa.errors.some(e=>e.includes('keyboard rejection')));assert(value.qa.checks.some(c=>c.action==='exposed numeric diagnostics'&&c.status==='Failed'));assert(value.qa.checks.some(c=>c.action==='layout'&&c.status==='Failed'));}finally{await numeric.close();}
 let analyzing,aborted=false;const reached=new Promise(r=>analyzing=r);const closing=new ProjectBrowserSession(root,join(root,'closing'),undefined,undefined,{analyze:(_capture,operationSignal)=>{analyzing();return new Promise((_resolve,reject)=>{operationSignal.addEventListener('abort',()=>{aborted=true;reject(new Error('closed'));},{once:true});});}});
 const pending=closing.execute({action:'qa'},signal,approve);await reached;await closing.close();await pending;assert(aborted,'closing the Page aborts its outstanding image analysis');
 console.log(JSON.stringify({result:'PASS',root,first:first.qa,second:second.qa,smokeStatus:last.qa.status,phases:states.map(s=>s.phase)},null,2));
}finally{await session.close();}
