// Actual Electron main/renderer/IPC/SQLite and files. No model process or inference.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-model-features-ui-'),modelsPath=join(root,'models'),file=join(root,'app-data/runtime-settings.json');
await mkdir(modelsPath);await mkdir(join(root,'app-data'));
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},str=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
async function gguf(name,fields,tensors=[]){let offset=0;const th=tensors.flatMap(([k,shape])=>{const at=offset;offset+=shape.reduce((a,b)=>a*b,1)*4;return [str(k),u32(shape.length),...shape.map(u64),u32(0),u64(at)];});const h=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(tensors.length),u64(Object.keys(fields).length),...Object.entries(fields).flatMap(([k,v])=>[str(k),u32(typeof v==='string'?8:typeof v==='boolean'?7:4),typeof v==='string'?str(v):typeof v==='boolean'?Buffer.from([Number(v)]):u32(v)]),...th]);const path=join(modelsPath,name);await writeFile(path,Buffer.concat([h,Buffer.alloc((32-h.length%32)%32),Buffer.alloc(offset)]));return path;}
const qwen=await gguf('qwen.gguf',{'general.architecture':'qwen35','qwen35.embedding_length':4,'qwen35.context_length':65536});
const gpt=await gguf('gpt.gguf',{'general.architecture':'gpt-oss','gpt-oss.context_length':131072});
const projector=await gguf('projector.gguf',{'general.architecture':'clip','clip.has_vision_encoder':true,'clip.projector_type':'qwen3vl_merger'},[['mm.2.weight',[4,4]]]);
const binary=join(root,'fixture-server');await writeFile(binary,'#!/bin/sh\necho "--model --ctx-size --port --mmproj --spec-type none,draft-mtp"\n',{mode:0o700});
const ids=['custom:123e4567-e89b-42d3-a456-426614174201','custom:123e4567-e89b-42d3-a456-426614174202'];
const models=ids.map((id,i)=>({id,displayName:i?'Text fixture':'Vision fixture',modelPath:i?gpt:qwen,mmprojPath:i?'':projector,gpuLayers:0,supportsTools:true,toolCallingMode:'manual',speculative:'none',mtpMode:'off',builtin:false}));
await writeFile(file,JSON.stringify({schemaVersion:2,modelsPath,models,llamaServerPath:binary,gpuLayers:0,setupDismissed:true,language:'en',browserVision:'off',autonomousBrowserQa:false}));
let app,page;
const launch=async()=>{app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:['--disable-gpu',resolve('dist/main/index.js')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_LAUNCHER_MANAGED:'1',LOCAL_AI_LLAMA_CPP_URL:'http://127.0.0.1:19764'}});page=await app.firstWindow();page.setDefaultTimeout(20000);await page.locator('.runtime-setup-action:not([disabled])').waitFor();};
try{
 await launch();
 const chats=await page.evaluate(async ids=>{const chats=[];for(let i=0;i<ids.length;i++){const c=await window.localAi.conversations.create(ids[i]);await window.localAi.conversations.update(c.id,{title:i?'Text chat':'Vision chat'});chats.push(c.id);}return chats;},ids);
 await page.reload();await page.locator('.runtime-setup-action:not([disabled])').waitFor();
 if(await page.locator('.panel-mode-toggle').getAttribute('aria-expanded')==='false')await page.locator('.panel-mode-toggle').click();
 const choose=async(name)=>{await page.locator('.chat-select').filter({hasText:name}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Vision"]')?.disabled!==undefined);};
 await choose('Text chat');const vision=page.getByRole('combobox',{name:'Vision',exact:true}),mtp=page.getByRole('combobox',{name:'MTP',exact:true});
 await page.waitForFunction(()=>document.querySelector('.vision-control [role="status"]')?.textContent==='Unsupported');assert(await vision.isDisabled());assert(await mtp.isDisabled());
 assert(await page.locator('.control select').filter({has:page.locator('option[value="deep"]')}).isEnabled(),'Agent Strategy stays available without Vision');
 assert((await page.evaluate(()=>window.localAi.models.list())).every(m=>m.supportsTools),'tool calling is independent from image support');
 assert(await page.getByRole('switch',{name:'Autonomous Browser QA'}).isEnabled(),'functional QA remains available for text model');
 const bad=await page.evaluate(async id=>{try{await window.localAi.browserQa.configure('on',false,true,id);return '';}catch(e){return String(e);}},chats[1]);assert.match(bad,/text input|visual encoder/);
 const before=await readFile(file,'utf8');
 await choose('Vision chat');await page.waitForFunction(()=>!document.querySelector('[aria-label="Vision"]').disabled);
 await vision.selectOption('on');await page.waitForFunction(()=>document.querySelector('[aria-label="Vision"]')?.value==='on');
 await page.waitForFunction(async id=>(await window.localAi.conversations.list()).find(c=>c.id===id).visionMode==='on',chats[0]);
 assert.equal(await readFile(file,'utf8'),before,'Vision preference does not change GGUF profile or restart settings');
 const state=await page.evaluate(id=>window.localAi.browserQa.status(id),chats[0]);assert.equal(state.capability.state,'supported');assert.equal(state.available,false);assert.equal(state.capability.backendVerified,false,'offline is not active Vision');
 await page.getByRole('switch',{name:'Autonomous Browser QA'}).click();await page.waitForFunction(async id=>(await window.localAi.browserQa.status(id)).autonomous,chats[0]);assert.equal((await page.evaluate(id=>window.localAi.browserQa.status(id),chats[0])).mode,'on','QA toggle preserves new Vision preference');
 await vision.selectOption('auto');await page.waitForFunction(async id=>(await window.localAi.browserQa.status(id)).mode==='auto',chats[0]);assert((await page.evaluate(id=>window.localAi.browserQa.status(id),chats[0])).autonomous,'Vision toggle preserves QA preference');
 await page.evaluate(id=>window.localAi.mtp.apply('custom:123e4567-e89b-42d3-a456-426614174201','off',true,id),chats[0]);
 await choose('Text chat');await page.waitForFunction(()=>document.querySelector('.vision-control [role="status"]')?.textContent==='Unsupported');assert.equal(await vision.inputValue(),'off');
 await choose('Vision chat');await page.waitForFunction(()=>document.querySelector('[aria-label="Vision"]')?.value==='auto');
 await rename(projector,projector+'.missing');await page.waitForFunction(()=>document.querySelector('.vision-control [role="status"]')?.textContent==='Needs configuration');assert(await vision.isDisabled());
 await rename(projector+'.missing',projector);await page.waitForFunction(()=>!document.querySelector('[aria-label="Vision"]').disabled);
 await app.close();app=null;await launch();
 const persisted=await page.evaluate(()=>window.localAi.conversations.list());assert.equal(persisted.find(c=>c.id===chats[0]).visionMode,'auto');assert.equal(persisted.find(c=>c.id===chats[0]).mtpMode,'off');assert.equal(persisted.find(c=>c.id===chats[1]).visionMode,null);
 await page.evaluate(()=>window.localAi.settings.setLanguage('ru'));await choose('Text chat');await page.waitForFunction(()=>document.querySelector('.vision-control [role="status"]')?.textContent==='Не поддерживается');
 await page.locator('.vision-control .help-trigger').focus();assert.match(await page.getByRole('tooltip').innerText(),/текстовый ввод/);
 console.log(JSON.stringify({result:'PASS',root,scope:'Real Electron/SQLite/UI; synthetic GGUFs and CLI help fixture, no inference',checks:['text Vision/MTP disabled with causes','QA independent','On rejected when unsupported','unloaded capability separate from active','chat scope and legacy inheritance','no GGUF profile rewrite','QA/Vision preferences independent','file disappears/returns','Electron restart']}));
}finally{await app?.close();}
