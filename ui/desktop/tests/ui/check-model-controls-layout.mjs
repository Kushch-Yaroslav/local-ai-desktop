// Real Chromium geometry/occlusion checks against the actual React components.
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdtemp, writeFile, readFile, readdir, copyFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(join(tmpdir(), 'lad-controls-layout-'));
const fixture = resolve('tests/ui/model-controls-fixtures.tsx');
const replaced = /(?:acp\/(?:chatSessionStore|acpConnection|providers|managedLocalProfiles)|ModelAndProviderContext|models\/modelInterface|\.\.\/modelInterface|localInference\/ModelSettingsPanel|utils\/analytics)$/;
try {
 await build({ entryPoints:[resolve('tests/ui/model-controls-layout.tsx')], bundle:true, outfile:join(temp,'fixture.js'), platform:'browser', format:'iife', jsx:'automatic', plugins:[{name:'fixture-boundaries',setup(b){b.onResolve({filter:replaced},()=>({path:fixture}));}}] });
 const assets=resolve('.vite/renderer/main_window/assets');
 for(const file of (await readdir(assets)).filter(f=>f.endsWith('.css'))) await copyFile(join(assets,file),join(temp,file));
 const css=(await Promise.all((await readdir(temp)).filter(f=>f.endsWith('.css')).map(async f=>`<style>${await readFile(join(temp,f),'utf8')}</style>`))).join('');
 await writeFile(join(temp,'index.html'),`<!doctype html><html class="dark"><head>${css}</head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
 const browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,chromiumSandbox:true});
 try {
  for(const theme of ['dark','light']) for(const width of [360,1280]) {
   const page=await browser.newPage({viewport:{width,height:800},reducedMotion:'reduce'});
   await page.goto('file://'+join(temp,'index.html')+'?theme='+theme);
   const trigger=page.getByRole('button',{name:'Настройки сеанса'});
   await trigger.click();
   const dialog=page.getByRole('dialog',{name:'Настройки сеанса'});await dialog.waitFor();
   await page.getByRole('group',{name:'Контекст'}).waitFor();
   // Wait for Radix collision placement and CSS measurement to settle.
   await page.waitForFunction(()=>{const e=document.querySelector('[role="dialog"]');if(!e)return false;const b=e.getBoundingClientRect();return b.height>100&&b.top>=0&&b.left>=0&&b.bottom<=innerHeight&&b.right<=innerWidth;});
   const geometry=await dialog.evaluate(e=>{const b=e.getBoundingClientRect(),ancestor=document.querySelector('[data-testid="clipping-ancestor"]').getBoundingClientRect();const hit=document.elementFromPoint(b.left+b.width/2,b.top+20);return {left:b.left,top:b.top,right:b.right,bottom:b.bottom,ancestorTop:ancestor.top,hit:e.contains(hit)};});
   assert(geometry.left>=0 && geometry.right<=width && geometry.top>=0 && geometry.bottom<=800,JSON.stringify(geometry));
   assert(geometry.top<geometry.ancestorTop && geometry.hit,'popover clipped or obscured');
   await page.getByLabel('Режим агента').selectOption('approve');
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Настройки сеанса');
   await trigger.click();await dialog.waitFor();await page.getByTestId('outside').click();await dialog.waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Выбрать модель'}).click();
   await page.getByRole('group',{name:'GGUF 00'}).waitFor();
   const list=page.getByRole('group',{name:'GGUF 00'}).locator('..');
   assert(await list.evaluate(e=>e.scrollHeight>e.clientHeight),'model list not scroll bounded');
   await mkdir(resolve('../../docs/screenshots'),{recursive:true});
   await page.screenshot({path:resolve(`../../docs/screenshots/model-selector-fixture-${theme}-${width}.png`)});
   await page.getByRole('button',{name:'API / Cloud',exact:true}).click();
   await page.getByRole('group',{name:'Cloud Model',exact:true}).waitFor();
   await page.screenshot({path:resolve(`../../docs/screenshots/model-selector-api-fixture-${theme}-${width}.png`)});
   await page.keyboard.press('Escape');await trigger.click();await dialog.waitFor();
   await page.waitForFunction(()=>{const e=document.querySelector('[role="dialog"]');if(!e)return false;const b=e.getBoundingClientRect();return b.top>=0 && b.left>=0 && b.bottom<=innerHeight && b.right<=innerWidth;});
   await dialog.evaluate(e=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.getByRole('button',{name:'100K · FP16'}).waitFor();
   await page.getByRole('button',{name:'172K · Q8'}).click();
   assert.equal(await page.getByLabel('Точность контекста (KV)').inputValue(),'q8_0');
   assert.equal(await page.getByRole('button',{name:'172K · Q8'}).getAttribute('aria-pressed'),'true');
   await page.getByRole('button',{name:'172K · Q8'}).evaluate(e=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(e)))));
   assert.notEqual(await page.getByRole('button',{name:'172K · Q8'}).evaluate(e=>getComputedStyle(e).borderColor),'oklab(0 0 0 / 0)','selected maximum must retain a visible border');
   await page.screenshot({path:resolve(`../../docs/screenshots/session-popover-fixture-${theme}-${width}.png`)});
   console.log(`PASS ${theme} ${width}px: portal outside clipping ancestor, visible hit target, viewport fit, RU interaction, Escape/focus, outside click, scrollable unified menu`);
   await page.close();
  }
 } finally { await browser.close(); }
} finally { await rm(temp,{recursive:true,force:true}); }
