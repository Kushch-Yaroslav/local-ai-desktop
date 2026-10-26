// Real Chromium + production ProjectBrowserSession. Optional Vision below is explicitly a fixture.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const root=await mkdtemp('/tmp/lad-responsive-qa-');process.env.LOCAL_AI_RUNTIME_ROOT=join(root,'runtime');
const require=createRequire(import.meta.url);
const {ProjectBrowserSession}=require('../dist/main/web/project-browser.js');
const {qaScenarios}=require('../dist/main/web/browser-scenarios.js');
const {responsiveOptions}=require('../dist/main/web/responsive-qa.js');
const fixture=broken=>`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Responsive fixture</title>
<style>*{box-sizing:border-box}body{margin:0;background:#182030;color:white}main{width:100%;padding:12px}button,input{max-width:100%;padding:8px}#links{display:none}#menu{display:none}@media(max-width:600px){#menu{display:block}}@media(max-width:360px){main{${broken?'min-width:420px':''}}}.carousel{width:100%;overflow-x:auto}.track{width:1000px;height:20px;background:purple}.tall{height:1800px}</style>
<main><h1>Landing</h1><button id="menu">Menu</button><nav id="links"><a href="#contact">Contact</a></nav><input id="name"><button id="modal">Open modal</button><dialog><p>Details</p><button id="close">Close</button></dialog><div class="carousel"><div class="track">Intentionally scrollable</div></div><div class="tall"></div></main><script>window.identity=Math.random();document.querySelector('#menu').onclick=()=>document.querySelector('#links').style.display='block';document.querySelector('#modal').onclick=()=>document.querySelector('dialog').showModal();document.querySelector('#close').onclick=()=>document.querySelector('dialog').close();</script>`;
await writeFile(join(root,'index.html'),fixture(true));
await writeFile(join(root,'unrelated.html'),'<p>unrelated route</p>');
const signal=AbortSignal.timeout(120000),approve=async()=>({approved:true,reason:'once'});
let mainPage,ownership;const progressEvents=[];const qaOptions={status:state=>progressEvents.push(state)};
const observer={ready:p=>{mainPage=p;},ownership:o=>{ownership=o;},state(){},action(){},closed(){}};
const session=new ProjectBrowserSession(root,join(root,'captures'),undefined,observer,qaOptions);
const execute=args=>session.execute(args,signal,approve);
const scenario=(id,viewport='mobile',patch={})=>({id,goal:id,target:'/index.html',viewport,preconditions:[],required_state:[],steps:[],assertion:{source:'layout',operator:'equals',expected:0},timeout_ms:6000,...patch});
try{
  assert.throws(()=>responsiveOptions({reason:'test',viewports:['mobile','mobile']}),/Duplicate/);
  assert.throws(()=>qaScenarios([scenario('bad',{width:100,height:600})]),/Viewport/);
  await execute({action:'open'});
  await mainPage.locator('#name').fill('preserved user input');await mainPage.evaluate(()=>{location.hash='user-route';scrollTo(0,200);});
  await session.finishRun(false);
  const before=await mainPage.evaluate(()=>({url:location.href,identity:window.identity,value:document.querySelector('#name').value,scroll:scrollY,width:innerWidth,height:innerHeight}));
  const contexts=session.browser.contexts().length;
  const checked=await execute({action:'qa',scenarios:[scenario('narrow',{width:360,height:800}),scenario('normal')]});
  assert(checked.qa,JSON.stringify(checked));
  assert(progressEvents.some(state=>state.phase==='interacting'&&state.responsive?.viewport.width===360),'Viewport progress is available during interaction');
  assert.equal(progressEvents.findLast(state=>state.phase==='complete').responsive.checked,2,'Checked viewport count survives generic phase events');
  assert.equal(checked.qa.scenarios[0].status,'Failed',JSON.stringify(checked.qa.scenarios));
  assert(checked.qa.scenarios[0].responsive.findings.some(f=>f.kind==='horizontal-overflow'&&f.confidence==='confirmed'));
  assert.equal(checked.qa.scenarios[1].status,'Verified','A carousel is not a document overflow failure');
  assert.equal(checked.qa.captures.length,0,'DOM-only layout proof with Vision Off must not depend on raster capture');for(const s of checked.qa.scenarios){assert.equal(s.observations.at(-1).captureId,undefined);assert.deepEqual(s.responsive.viewport,s.viewport);assert.equal(s.responsive.url,'https://project-preview.invalid/index.html');}
  assert.deepEqual(await mainPage.evaluate(()=>({url:location.href,identity:window.identity,value:document.querySelector('#name').value,scroll:scrollY,width:innerWidth,height:innerHeight})),before,'Responsive QA preserves the active page state');
  assert.equal(ownership,'user');assert.equal(session.browser.contexts().length,contexts,'Temporary context is closed');
  const cached=await execute({action:'qa',scenarios:[scenario('same-name-does-not-reset',{width:360,height:800}),scenario('normal')]});
  assert.equal(cached.reused_evidence,true,'Unchanged responsive observation is reused, not re-executed');
  await writeFile(join(root,'unrelated.html'),'<p>changed independent route</p>');
  assert.equal((await execute({action:'qa',scenarios:[scenario('narrow',{width:360,height:800}),scenario('normal')]})).reused_evidence,true,'Independent page edits do not invalidate unrelated responsive checks');
  const routes=[scenario('route-one'),scenario('route-two','mobile',{target:'/unrelated.html'})];
  const multi=await execute({action:'qa',scenarios:routes});assert(multi.qa);
  await writeFile(join(root,'unrelated.html'),'<p>changed a dependency of the second tested route</p>');
  assert(!(await execute({action:'qa',scenarios:routes})).reused_evidence,'Cache must track dependencies of every tested route, not just the initial document');
  const probes=await execute({action:'qa',responsive:{reason:'Investigate the reproduced narrow overflow',vision:'off',breakpoint:{minWidth:320,maxWidth:430,attempts:4}}});
  assert.equal(probes.qa.scenarios.length,4,JSON.stringify(probes));assert(probes.qa.scenarios.every(s=>!s.deliverableId));assert.match(probes.qa.reason,/not CSS breakpoint inference/);
  const menu=await execute({action:'qa',scenarios:[scenario('mobile menu','mobile',{preconditions:[{source:'visible',selector:'#menu',operator:'equals',expected:true}],steps:[{action:'click',selector:'#menu'}],assertion:{source:'visible',selector:'#links',operator:'equals',expected:true}})]});
  assert.equal(menu.qa.scenarios[0].status,'Verified');assert.equal(menu.qa.scenarios[0].evidenceKind,'interaction');
  const modal=await execute({action:'qa',scenarios:[scenario('mobile modal','mobile',{steps:[{action:'click',selector:'#modal'}],assertion:{source:'visible',selector:'dialog[open]',operator:'equals',expected:true}})]});assert.equal(modal.qa.scenarios[0].status,'Verified');
  await writeFile(join(root,'index.html'),fixture(false));
  const fixed=await execute({action:'qa',scenarios:[scenario('narrow',{width:360,height:800}),scenario('normal')]});
  assert(!fixed.reused_evidence);assert.equal(fixed.qa.functionalStatus,'Verified');assert.notEqual(fixed.qa.revisionFingerprint,checked.qa.revisionFingerprint);
  const slow=scenario('abort isolated operation','mobile',{steps:[{action:'wait',duration_ms:2000}],assertion:{source:'visible',selector:'#menu',operator:'equals',expected:true}});
  const stop=new AbortController();const pending=session.execute({action:'qa',scenarios:[slow]},stop.signal,approve);setTimeout(()=>stop.abort(),250);await pending;
  assert(!mainPage.isClosed());assert.equal(session.browser.contexts().length,contexts);assert.equal(ownership,'user');
  const pause=new AbortController();qaOptions.signal=pause.signal;
  const pausing=execute({action:'qa',scenarios:[slow]});setTimeout(()=>{pause.abort();void session.pauseRun();},250);await pausing;
  assert(!mainPage.isClosed());assert.equal(ownership,'paused');assert.equal(session.browser.contexts().length,contexts);
  qaOptions.signal=undefined;session.beginRun(observer,qaOptions);assert((await execute({action:'read'})).content.includes('Landing'));
  await session.finishRun(false);
  assert.equal(await mainPage.locator('#name').inputValue(),'preserved user input');
  const stored=JSON.parse(await readFile(fixed.qa.evidencePath,'utf8'));assert.equal(stored.scenarios[0].viewport.width,360);assert(stored.scenarios[0].sourceRevisions);
  console.log('PASS real Chromium: isolated responsive layout/overflow/carousel, per-viewport DOM evidence, menu/modal actions, bounded breakpoint search, cache/dependency freshness, Stop/Pause cleanup and preserved active Native Browser contract.');
}finally{await session.close();}

let analyses=0;
await writeFile(join(root,'canvas.html'),'<style>body{margin:0}canvas{max-width:100%}</style><canvas width="200" height="100"></canvas>');
const canvas=new ProjectBrowserSession(root,join(root,'vision'),undefined,undefined,{analyze:async capture=>{analyses++;assert.equal(capture.viewport.width,390);return {analyzed:true,status:'Failed',summary:'Fixture Vision candidate; not real inference',confidence:.6};}});
try{
 const result=await canvas.execute({action:'qa',path:'canvas.html',responsive:{reason:'Canvas mobile rendering inspection',viewports:['mobile']}},signal,approve);
 assert.equal(analyses,1,JSON.stringify(result));assert.equal(result.qa.scenarios[0].status,'Verified','DOM bounds can pass independently of a probabilistic Vision finding');assert.equal(result.qa.scenarios[0].visual.status,'Failed');
 console.log('PASS real Chromium capture + fixture Vision routing: Canvas image is analyzed; visual assessment remains separate from deterministic DOM evidence. No real Vision inference claimed.');
}finally{await canvas.close();}
