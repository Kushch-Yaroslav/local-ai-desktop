// Actual Electron IPC/renderer/SQLite. Mount timing is simulated with fixture directories.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-path-audit-'),outside=await mkdtemp('/tmp/lad-path-other-');
await mkdir(join(root,'app-data'));await mkdir(join(root,'primary'));await mkdir(join(root,'volume-offline'));
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},str=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
const tiny=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(1),str('general.architecture'),u32(8),str('llama')]);
const primary=join(root,'primary','model.gguf'),external=join(outside,'モデル identical path.gguf'),mounted=join(root,'volume','model.gguf');
await writeFile(primary,tiny);await writeFile(external,tiny);await writeFile(join(root,'volume-offline','model.gguf'),tiny);
const binary=join(root,'server');await writeFile(binary,'#!/bin/sh\necho "--model --ctx-size --port --fit"\n',{mode:0o700});
const ids=[1,2,3].map(n=>'custom:123e4567-e89b-42d3-a456-42661417400'+n);
const config={schemaVersion:2,llamaServerPath:binary,modelsPath:join(root,'absent-default-directory'),gpuLayers:0,setupDismissed:true,language:'en',models:[primary,external,mounted].map((modelPath,i)=>({id:ids[i],displayName:['Primary fixture','External fixture','Mount fixture'][i],modelPath,mmprojPath:'',gpuLayers:0,supportsTools:false,speculative:'none',mtpMode:'off',builtin:false}))};
const file=join(root,'app-data/runtime-settings.json');await writeFile(file,JSON.stringify(config));
let app,ui;const stages=[];
async function launch(){app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:['--disable-gpu',resolve('dist/main/index.js')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_LAUNCHER_MANAGED:'1',LOCAL_AI_LLAMA_PORT:'19792'}});ui=await app.firstWindow();await ui.locator('.conversation').waitFor();}
const list=()=>ui.evaluate(()=>window.localAi.models.list());
const refresh=async()=>{await ui.getByRole('button',{name:'Refresh model availability',exact:true}).click();};
try{
 await launch();const cold=await list();assert(cold.find(m=>m.id===ids[0]).installed);assert(cold.find(m=>m.id===ids[1]).installed);assert(!cold.find(m=>m.id===ids[2]).installed);
 if(await ui.locator('.panel-mode-toggle').getAttribute('aria-expanded')==='false')await ui.locator('.panel-mode-toggle').click();
 const option=id=>ui.locator(`select[aria-label="Model"] option[value="${id}"]`);
 const saved=await readFile(file,'utf8');
 stages.push({stage:'before-picker',mounted:false,available:false,savedPathUnchanged:true});
 // A volume appearing after cold start must recover through Refresh without Save.
 await rename(join(root,'volume-offline'),join(root,'volume'));await refresh();await ui.waitForFunction(id=>!document.querySelector(`select[aria-label="Model"] option[value="${id}"]`)?.disabled,ids[2]);assert.equal(await readFile(file,'utf8'),saved);
 await rename(join(root,'volume'),join(root,'volume-offline'));await refresh();await ui.waitForFunction(id=>document.querySelector(`select[aria-label="Model"] option[value="${id}"]`)?.disabled,ids[2]);
 assert(await option(ids[2]).isDisabled());
 await ui.locator('.runtime-setup-action').click();await ui.locator('.runtime-model-select').nth(2).click();
 await ui.waitForFunction(()=>document.querySelector('[data-testid=runtime-readiness]')?.getAttribute('data-state')==='ready',null,{timeout:3000});
 assert.equal(await ui.getByText('Default folder for choosing GGUF',{exact:true}).count(),0);
 await app.evaluate(async({dialog},paths)=>{const fs=process.getBuiltinModule('fs');global.pathPickerAudit=[];dialog.showOpenDialog=async(_window,options)=>{global.pathPickerAudit.push({sameDefault:options.defaultPath===paths.directory});if(!fs.existsSync(paths.directory))fs.renameSync(paths.offline,paths.directory);return {canceled:false,filePaths:[paths.file]};};},{directory:join(root,'volume'),offline:join(root,'volume-offline'),file:mounted});
 const editor=ui.locator('.runtime-model-editor');await editor.getByRole('button',{name:'Select…',exact:true}).first().click();
 await ui.waitForFunction(async id=>(await window.localAi.models.list()).find(m=>m.id===id)?.installed,ids[2]);
 await ui.waitForFunction(()=>document.querySelectorAll('.runtime-model-list li')[2]?.classList.contains('model-ready'),null,{timeout:3000});
 assert.equal(await readFile(file,'utf8'),saved,'Picker recovery must not require saving the profile');
 stages.push({stage:'after-picker-before-save',mountSimulated:true,available:true,savedPathUnchanged:true});
 await ui.evaluate(async()=>{const state=await window.localAi.settings.get();await window.localAi.settings.save(state.setup.config);});
 const after=JSON.parse(await readFile(file,'utf8'));assert.equal(after.models[2].modelPath,mounted);assert.equal(after.models[1].modelPath,external);assert.equal(after.modelsPath,config.modelsPath);
 stages.push({stage:'after-save',available:true,savedPathUnchanged:true});
 await editor.getByRole('button',{name:'Select…',exact:true}).first().click();assert.equal(await app.evaluate(()=>global.pathPickerAudit.at(-1).sameDefault),true);
 // Delay an old unavailable snapshot, then publish a newer available snapshot.
 await app.evaluate(async({ipcMain})=>{const {runtimeDraftAvailability}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('./dist/main/services/runtime-settings.js');global.pathDraftRace={count:0,completed:false};ipcMain.removeHandler('settings:validateDraft');ipcMain.handle('settings:validateDraft',async(_event,config)=>{const result=runtimeDraftAvailability(config);const n=++global.pathDraftRace.count;if(n===1)await new Promise(resolve=>{global.pathDraftRace.release=resolve;});if(n===1)global.pathDraftRace.completed=true;return result;});});
 await rename(external,external+'.offline');await ui.evaluate(()=>window.dispatchEvent(new Event('focus')));for(let i=0;i<100&&!await app.evaluate(()=>global.pathDraftRace.count>=1);i++)await ui.waitForTimeout(20);
 assert.equal(await app.evaluate(()=>global.pathDraftRace.count>=1),true);await rename(external+'.offline',external);await ui.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await ui.waitForFunction(()=>document.querySelectorAll('.runtime-model-list li')[1]?.classList.contains('model-ready'));
 await app.evaluate(()=>global.pathDraftRace.release());await ui.waitForTimeout(150);assert(await ui.locator('.runtime-model-list li').nth(1).evaluate(e=>e.classList.contains('model-ready')),'Old unavailable draft response cannot overwrite fresh availability');
 stages.push({stage:'out-of-order-draft-validation',lateUnavailableIgnored:true});
 await ui.evaluate(()=>window.localAi.settings.setLanguage('ru'));await ui.getByRole('heading',{name:'Мои модели',exact:true}).waitFor();await ui.evaluate(()=>window.localAi.settings.setLanguage('en'));await ui.getByRole('heading',{name:'My models',exact:true}).waitFor();
 await app.close();app=null;await launch();assert((await list()).every(m=>m.installed));
 assert.equal((await ui.evaluate(()=>window.localAi.settings.get())).llamaRuntime.status,'offline','Availability does not load a model');
 const result={result:'PASS',root,stages,checks:['Cold start two individual directories outside missing default folder','Unavailable volume becomes available without Save','Available becomes unavailable on Refresh','Same absolute Unicode path picker recovery before Save','Legacy modelsPath retained internally, no mandatory directory','Last selected directory seeds next picker','Cold process restart retains availability; no model loaded'],automount:'Simulated in fixture; no real disk mounted or unmounted'};
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({result:'PASS',root}));
}finally{await app?.close();}
