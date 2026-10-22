import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-native-shutdown-');
const app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/native-browser/shutdown-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root}});
try{
 await app.evaluate(async()=>{while(!global.shutdownFixture)await new Promise(r=>setTimeout(r,20));});
 const results=[];
 for(const mode of ['native-close','shield-first','window-destroy','debugger-detach','active-pan-window','window-destroy']){
  const id=await app.evaluate(()=>global.shutdownFixture.open());
  const closed=await app.evaluate((_,mode)=>global.shutdownFixture.close(mode),mode);
  assert(closed.same,'Repeated close must return the same promise');assert(closed.closed);
  await new Promise(r=>setTimeout(r,150));
  assert.deepEqual(await app.evaluate(()=>global.shutdownFixture.errors),[],`Unhandled shutdown error: ${mode}`);
  results.push({mode,id,...closed});
 }
 await app.evaluate(()=>global.shutdownFixture.open());
 await app.close();
 assert.deepEqual(JSON.parse(await readFile(join(root,'shutdown-errors.json'),'utf8')),[],'Unhandled error during full application shutdown');
 results.push({mode:'application-close'});
 await writeFile(join(root,'result.json'),JSON.stringify({result:'PASS',results},null,2));
 console.log(JSON.stringify({result:'PASS',root,results}));
}finally{await app.close().catch(()=>{});}
