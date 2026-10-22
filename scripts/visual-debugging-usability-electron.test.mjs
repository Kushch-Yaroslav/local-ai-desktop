import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-visual-usability-'),project=await mkdtemp('/tmp/lad-visual-usability-project-');
await writeFile(join(project,'index.html'),`<!doctype html><style>body{margin:20px;font:16px sans-serif}.clipped{display:block;width:60px;overflow:hidden;white-space:nowrap;margin:20px 0}#unrelated{position:absolute;top:320px;left:20px}section{height:1500px}</style><button id="clip" class="clipped">Long checkout button label</button><button id="other" class="clipped">Second clipped button label</button><p id="unrelated">Unrelated text far below the buttons</p><input type="password" value="PRIVATE-PASSWORD"><input value="PRIVATE-INPUT"><section></section>`);
let app;
try{
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/visual-debugging/main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_TEST_PROJECT_ROOT:project}});
 const ui=await app.firstWindow();await ui.locator('.conversation').waitFor();const chat=await app.evaluate(()=>global.visualFixture.chat);
 await ui.evaluate(chat=>window.localAi.visualDebug.open(chat),chat);
 const info=()=>app.evaluate(()=>global.visualFixture.info());const original=(await info()).id;assert(original);
 await ui.evaluate(chat=>window.localAi.conversations.update(chat,{modelId:'qwen3.8:27b-q4_K_M',contextWindow:32768}),chat);
 const afterModel=(await info()).id;
 await ui.evaluate(chat=>window.localAi.chat.setPermissions(chat,'autonomous',true),chat);
 const afterSecurity=(await info()).id;
 if(process.argv.includes('--reproduce')){console.log(JSON.stringify({original,afterModel,afterSecurity,securityClosed:afterSecurity!==original,root}));}
 else {assert.equal(afterModel,original);assert.equal(afterSecurity,original);console.log('PASS manual Native Page survives model load and Agent Security change');}
}finally{await app?.close();}
