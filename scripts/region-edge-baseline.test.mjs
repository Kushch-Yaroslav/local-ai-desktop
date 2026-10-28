// Compare the preserved pre-task overlay with the fix in real Chromium.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {chromium} from 'playwright-core';
const require=createRequire(new URL('../dist/main/web/visual-selection.js',import.meta.url));
const ts=require('typescript'),module={exports:{}};
const baseline=execFileSync('git',['show','cf72f47:src/main/web/visual-selection.ts'],{encoding:'utf8'});
const js=ts.transpileModule(baseline,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(js,{module,exports:module.exports,require});
const current=require('./visual-selection.js');const browser=await chromium.launch({headless:true});
try{
 for(const dpr of [1,2]){
  const page=await browser.newPage({viewport:{width:800,height:500},deviceScaleFactor:dpr});await page.setContent('<main>Edge fixture</main>');const captures=[];await page.exposeBinding('__ladRegionSelect',(_source,rect)=>captures.push(rect));
  for(const [overlay,label]of [[module.exports.selectionOverlay,'before'],[current.selectionOverlay,'after']]){
   captures.length=0;await overlay(page,true,[]);await page.mouse.move(1,10);await page.mouse.down();await page.mouse.move(830,160,{steps:8});await page.mouse.up();await page.waitForTimeout(100);
   assert(captures.length,label+' pointerup');const rect=captures[0];if(label==='before')assert(rect.x+rect.width>800,'Old callback sent an out-of-viewport rectangle rejected by visualCapture');else assert.equal(rect.x+rect.width,800);
   captures.length=0;await overlay(page,true,[]);await page.mouse.move(1,10);await page.mouse.down();await page.mouse.move(790,160,{steps:8});await page.evaluate(()=>document.getElementById('__lad-visual-selection').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true})));await page.mouse.up();await page.waitForTimeout(100);assert.equal(captures.length,label==='before'?0:1,label+' cancellation handling');
  }
  await page.close();
 }
 console.log('PASS real Chromium DPR1/2: old out-of-viewport callback and cancelled-drag loss reproduced; new overlay clamps bounds and retains the last valid drag');
}finally{await browser.close();}
