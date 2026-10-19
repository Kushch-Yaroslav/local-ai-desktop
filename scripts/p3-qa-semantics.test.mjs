// Real Chromium interactions; explicitly scripted Vision opinions, not model inference.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{runBrowserQa,installQaInstrumentation}=require('../dist/main/web/browser-qa.js'),{launchWebBrowser}=require('../dist/main/web/web-tools.js');
const root=await mkdtemp('/tmp/lad-p3-qa-semantics-'),browser=await launchWebBrowser();
try {
 const page=await browser.newPage({viewport:{width:384,height:256}});await installQaInstrumentation(page);await page.goto('data:text/html,'+encodeURIComponent('<button id="run" onclick="this.textContent=\'Done\'">Run</button>'));
 // Wait for the data-URL fixture's first compositor frame before requesting a clipped PNG.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(null)))));
 let index=0;const capture=async()=>{const path=join(root,`${index++}.png`),bytes=await page.screenshot({path,type:'png',clip:{x:0,y:0,width:384,height:256},scale:'css'});return{id:String(index),path,sha256:createHash('sha256').update(bytes).digest('hex'),width:384,height:256,viewport:{width:384,height:256},region:{x:0,y:0,width:384,height:256},url:page.url(),capturedAt:new Date().toISOString(),bytes:bytes.length};};
 const check=async extra=>runBrowserQa({page,signal:AbortSignal.timeout(15000),steps:[{action:'click',selector:'#run',expect:{selector:'#run',text:'Done'}}],capture,errors:()=>[],...extra});
 const functional=await check({});assert.equal(functional.functionalStatus,'Verified',JSON.stringify(functional));assert.equal(functional.status,'Verified');assert.equal(functional.visual.analyzed,false);
 const opinion=await check({analyze:async()=>({analyzed:true,status:'Failed',confidence:.8,summary:'Scripted uncertain visual opinion',issues:[]})});assert.equal(opinion.functionalStatus,'Verified');assert.equal(opinion.status,'Partially Verified','Vision cannot manufacture a factual application failure');
 const timeout=await check({steps:[{action:'click',selector:'#missing'}]});assert.equal(timeout.status,'Blocked');assert.equal(timeout.reasonCode,'QA_TIMEOUT');assert.equal(timeout.functionalStatus,'Blocked');
 const failed=await check({steps:[{action:'click',selector:'#run',expect:{selector:'#run',text:'Wrong'}}]});assert.equal(failed.status,'Failed');assert.equal(failed.functionalStatus,'Failed');
 const visualOnly=await check({steps:[],scenarios:[{id:'layout',goal:'Declared visual layout',target:page.url(),preconditions:[],required_state:[],steps:[],assertion:{source:'pixels',operator:'changed'},timeout_ms:5000}],analyze:async()=>({analyzed:true,status:'Failed',confidence:.7,summary:'Scripted possible layout defect',issues:[]})});assert.equal(visualOnly.scenarios[0].reasonCode,'VISUAL_REQUIREMENT_FAILED');assert.notEqual(visualOnly.functionalStatus,'Failed','visual-only failure does not become a functional failure');
 const mixed=await check({steps:[],scenarios:[{id:'button',goal:'Button says Done',target:page.url(),preconditions:[],required_state:[],steps:[{action:'click',selector:'#run'}],assertion:{source:'text',selector:'#run',operator:'equals',expected:'Done'},timeout_ms:5000},{id:'appearance',goal:'Declared appearance',target:page.url(),preconditions:[],required_state:[],steps:[],assertion:{source:'pixels',operator:'changed'},timeout_ms:5000}]});assert.equal(mixed.functionalStatus,'Verified');assert.equal(mixed.status,'Partially Verified','an unverified declared visual criterion cannot make the combined QA Verified');
 await writeFile(join(root,'reports.json'),JSON.stringify({functional,opinion,timeout,failed},null,2));console.log(JSON.stringify({result:'PASS',root,functionalWithoutVision:true,probabilisticVision:true,timeoutSeparated:true,realFailure:true}));
}finally{await browser.close();}
