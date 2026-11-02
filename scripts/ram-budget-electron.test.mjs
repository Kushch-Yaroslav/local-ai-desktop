// RAM warning/error rendering with mocked telemetry, no model allocation.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const file=resolve('runtime/app-data/runtime-settings.json'),before=await readFile(file,'utf8'),config=JSON.parse(before);
const profile=config.models.find(m=>m.id==='custom:e58faa02-8fe3-4217-9c3d-da322326cedc');assert(profile);
const root=await mkdtemp('/tmp/lad-ram-budget-ui-');await mkdir(join(root,'app-data'));await writeFile(join(root,'app-data/runtime-settings.json'),JSON.stringify({...config,models:[profile]}));
let app;
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:['--disable-gpu',resolve('dist/main/index.js')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});const page=await app.firstWindow();page.setDefaultTimeout(30000);
 async function open(){await page.locator('.runtime-setup-action:not([disabled])').click();await page.locator('.runtime-model-select').filter({hasText:profile.displayName}).click();await page.getByRole('button',{name:/^(Advanced|Расширенный режим)$/}).click();await page.locator('.host-memory-budget').waitFor();}
 await open();const preview=await page.evaluate(({profile,path})=>window.localAi.settings.placement(profile,path),{profile,path:config.llamaServerPath});
 for(const availableRamMiB of [50000,8000]){
  await app.evaluate(({ipcMain},snapshot)=>{ipcMain.removeHandler('settings:placement');ipcMain.handle('settings:placement',()=>snapshot);},{...preview,availableRamMiB});
  await page.reload();await page.locator('.runtime-setup-action:not([disabled])').waitFor();await open();const budget=page.locator('.host-memory-budget');
  if(availableRamMiB===50000){assert.equal(await budget.locator('[role="alert"]').count(),0);assert.match(await budget.innerText(),/Полный рабочий набор|full mmap working set/);}
  else {await budget.locator('[role="alert"]').waitFor();assert.match(await budget.innerText(),/mandatory allocations=.*anonymous weights=.*MemoryMax=/);}
  assert.equal(await page.locator('[aria-label="Expert cache budget"], [aria-label="Размер кэша экспертов"]').inputValue(),'16384');assert.equal(await page.locator('[aria-label="Profile context"], [aria-label="Контекст профиля"]').inputValue(),'65536');
 }
 assert.deepEqual(JSON.parse(await readFile(join(root,'app-data/runtime-settings.json'),'utf8')).models[0],profile);
 console.log('PASS Electron RAM: mmap working-set warning, mandatory-memory error, reload/profile persistence');
} finally {if(app)await app.close();assert.equal(await readFile(file,'utf8'),before);}
