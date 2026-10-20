// Real Chromium production runner/capture/loader. Vision, when supplied, is explicitly a routing fixture.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const root=await mkdtemp('/tmp/lad-visual-layout-');process.env.LOCAL_AI_RUNTIME_ROOT=join(root,'runtime');
const require=createRequire(import.meta.url),{ProjectBrowserSession}=require('../dist/main/web/project-browser.js'),{qaScenarios}=require('../dist/main/web/browser-scenarios.js');
const fixture=({gap=0,seam=false,resize=true,animated=false,backing=true}={})=>`<!doctype html><title>Visual fixture</title><style>html,body{margin:0;background:#080810;overflow:hidden}canvas{display:block;width:100vw;height:calc(100vh - ${gap}px)}input{position:fixed;top:10px;left:10px}</style><canvas></canvas><input id="keep"><script>
window.identity=Math.random();const c=document.querySelector('canvas'),ctx=c.getContext('2d');let tick=0;
function size(){c.width=c.clientWidth*${backing?'devicePixelRatio':'1'};c.height=c.clientHeight*${backing?'devicePixelRatio':'1'};draw()}
function draw(){ctx.fillStyle='#7040a0';ctx.fillRect(0,0,c.width,c.height);${seam?"ctx.fillStyle='#101020';ctx.fillRect(0,0,c.width,c.height*.35);":''}${animated?"ctx.fillStyle='white';for(let i=0;i<20;i++)ctx.fillRect((i*51+tick)%c.width,(i*29+tick)%c.height,3,3);tick++;requestAnimationFrame(draw);":''}}
${resize?"addEventListener('resize',size);":''}size();</script>`;
await writeFile(join(root,'index.html'),fixture({gap:100}));
const signal=AbortSignal.timeout(180000),approve=async()=>({approved:true,reason:'once'});
let page;const session=new ProjectBrowserSession(root,join(root,'captures'),undefined,{ready:p=>{page=p;},state(){},action(){},closed(){}});
const scenario=(path='coverage',options={})=>({id:'visual',goal:'Fullscreen Canvas covers viewport; investigate bands and seams',target:'/index.html',viewport:{width:900,height:700},preconditions:[],required_state:[],steps:[],assertion:{source:'visual_layout',path,selector:'canvas',operator:'equals',expected:0},timeout_ms:12000,visual_layout:{vision:'off',...options}});
const run=async(s=scenario())=>{const result=await session.execute({action:'qa',scenarios:[s]},signal,approve);assert(result.qa,JSON.stringify(result));const first=result.qa.scenarios[0];assert(first.visualLayout,JSON.stringify(result.qa));return {report:result.qa,result:first,raw:result};};
try{
 assert.throws(()=>qaScenarios([scenario('coverage',{resize:['mobile','desktop','tablet']})]),/two/);
 assert.throws(()=>qaScenarios([{...scenario(),viewport:undefined}]),/viewport/);
 assert.throws(()=>qaScenarios([scenario('coverage',{baseline:{report_id:'../../outside',scenario_id:'visual'}})]),/Baseline/);
 await session.execute({action:'open'},signal,approve);await page.locator('#keep').fill('user state');await session.finishRun(false);
 const before=await page.evaluate(()=>({url:location.href,identity:window.identity,value:document.querySelector('#keep').value,size:[innerWidth,innerHeight]})),contexts=session.browser.contexts().length;
 const broken=await run();assert.equal(broken.result.status,'Failed');assert(broken.result.visualLayout.frames.every(f=>f.findings.some(f=>f.kind==='coverage'&&f.region.height===100)));assert.equal(broken.result.responsive.findings.length,0,'DOM overflow alone misses the band');
 assert.equal((await run()).raw.reused_evidence,true);
 const nonCanvas=await run({...scenario('backing'),assertion:{...scenario('backing').assertion,selector:'body'}});assert.equal(nonCanvas.result.status,'Blocked');assert.equal(nonCanvas.result.reasonCode,'UNSUPPORTED_OPERATION');
 await writeFile(join(root,'index.html'),fixture());
 const fixed=await run(scenario('coverage',{baseline:{report_id:broken.report.id,scenario_id:'visual'}}));assert.equal(fixed.result.status,'Verified');assert(fixed.result.visualLayout.comparison.matched);assert(fixed.result.visualLayout.comparison.resolved>0);
 const mismatched=await run({...scenario('coverage',{baseline:{report_id:broken.report.id,scenario_id:'visual'}}),viewport:'mobile'});assert.equal(mismatched.result.status,'Blocked');
 await writeFile(join(root,'index.html'),fixture({seam:true}));
 const seam=await run(scenario('seams'));assert.equal(seam.result.status,'Not Verified');assert(seam.result.visualLayout.frames.every(f=>f.findings.some(f=>f.kind==='horizontal-seam')));assert(!seam.result.visualLayout.frames.flatMap(f=>f.findings).some(f=>f.status==='Failed'),'Intentional or unexpected separator is a candidate, never an automatic failure');
 const regression=await run(scenario('coverage',{baseline:{report_id:fixed.report.id,scenario_id:'visual'}}));assert(regression.result.visualLayout.comparison.newCandidates>0,'New seam after a coverage fix is reported independently');
 await writeFile(join(root,'index.html'),fixture({animated:true}));
 const dynamic=await run(scenario('coverage'));assert.equal(dynamic.result.status,'Verified');assert(dynamic.result.visualLayout.frames.every(f=>!f.findings.some(f=>f.source==='pixels')),'Moving particles do not become persistent extended seams');
 for(const dpr of [1,2]){
  const resized=await run(scenario('backing',{dpr,resize:[{width:900,height:500},{width:390,height:844}]}));assert.equal(resized.result.status,'Verified',JSON.stringify(resized.result));assert.equal(resized.result.visualLayout.frames.length,6);assert(resized.result.visualLayout.frames.every(f=>f.screenshot.width===f.viewport.width&&f.screenshot.height===f.viewport.height));assert(resized.result.visualLayout.frames.every(f=>f.dpr===dpr&&Math.abs(f.backing.width-f.backing.expectedWidth)<=2&&Math.abs(f.backing.height-f.backing.expectedHeight)<=2));
 }
 await writeFile(join(root,'index.html'),fixture({resize:false}));
 const stale=await run(scenario('backing',{resize:[{width:900,height:500}]}));assert.equal(stale.result.status,'Not Verified');assert(stale.result.visualLayout.frames.some(f=>f.findings.some(f=>f.kind==='backing-store')));
 assert.notEqual(stale.report.revisionFingerprint,dynamic.report.revisionFingerprint,'Source changes invalidate evidence');
 await writeFile(join(root,'index.html'),fixture().replace('<input id="keep">','<input id="keep" value="different state">'));
 const uiMismatch=await run(scenario('coverage',{baseline:{report_id:fixed.report.id,scenario_id:'visual'}}));assert.equal(uiMismatch.result.status,'Blocked','Changed observed UI state prevents a false matched baseline');
 for(const pause of [false,true]){
  const abort=new AbortController();const promise=session.execute({action:'qa',scenarios:[{...scenario(),steps:[{action:'wait',duration_ms:2000}]}]},abort.signal,approve);setTimeout(()=>{abort.abort();if(pause)void session.pauseRun();},250);await promise;assert.equal(session.browser.contexts().length,contexts);assert(!page.isClosed());
 }
 assert.deepEqual(await page.evaluate(()=>({url:location.href,identity:window.identity,value:document.querySelector('#keep').value,size:[innerWidth,innerHeight]})),before);
 console.log('PASS real Chromium: bottom band despite zero overflow; correct coverage; persistent seam candidates; intentional divider never Failed; animation; before/after resolved and new regions; mismatched baseline blocked; six-frame resize; DPR 1/2; stale backing; cache/source freshness; Stop/Pause; unchanged primary page. No Vision inference.');
}finally{await session.close();}
await writeFile(join(root,'scroll.html'),'<style>body{margin:0}section{height:700px}section:nth-child(1){background:red}section:nth-child(2){background:blue}section:nth-child(3){background:green}</style><section></section><section></section><section></section>');
const scrolled=new ProjectBrowserSession(root,join(root,'scroll-captures'));
try{
 const value=await scrolled.execute({action:'qa',path:'scroll.html',scenarios:[{...scenario('seams'),target:'/scroll.html',assertion:{source:'visual_layout',path:'seams',operator:'equals',expected:0},steps:[{action:'scroll',delta_y:700}]}]},signal,approve);
 const frame=value.qa.scenarios[0].visualLayout.frames[0];assert(frame.scroll.y>=650);assert(frame.signature[2]>200&&frame.signature[0]<30,'Screenshot pixels must come from the actual scrolled viewport, not the document top');
 console.log('PASS actual scrolled viewport pixel capture and evidence coordinates.');
}finally{await scrolled.close();}
let calls=0;
await writeFile(join(root,'index.html'),fixture({gap:80,seam:true}));
const vision=new ProjectBrowserSession(root,join(root,'vision'),undefined,undefined,{analyze:async(capture,_signal,_before,context)=>{calls++;assert.match(context.goal,/bottom 20%/);assert.match(context.goal,/CSS viewport/);assert.equal(capture.viewport.width,900,'Target the actual suspect frame rather than the last resized frame');assert(capture.sha256);return {analyzed:true,status:'Verified',summary:'FIXTURE response, not real Vision inference'};}});
try{const result=await vision.execute({action:'qa',scenarios:[scenario('coverage',{vision:'on',resize:['mobile']})]},signal,approve);assert.equal(calls,1);assert.equal(result.qa.scenarios[0].status,'Failed','Generic Vision success cannot erase measured fullscreen failure');console.log('PASS targeted Vision routing with explicit fixture response; independent deterministic failure.');}finally{await vision.close();}
