import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ModelStorageWatch} from './model-storage-watch';
import {ggufFileAvailability} from './gguf-artifacts';
import {modelLocationDirectory} from './model-location';
async function test(){
  const root=await mkdtemp('/tmp/lad-storage-watch-'),volume=join(root,'volume'),offline=join(root,'offline'),file=join(volume,'model.gguf');await mkdir(offline);
  const bytes=Buffer.alloc(8);bytes.write('GGUF');bytes.writeUInt32LE(3,4);await writeFile(join(offline,'model.gguf'),bytes);
  assert.equal(ggufFileAvailability(file).status,'unavailable');let changed=0;
  const watcher=new ModelStorageWatch(()=>changed++,()=>volume);watcher.update([{modelPath:file,availabilityReason:'disk-unavailable'}]);
  try{await rename(offline,volume);for(let i=0;i<30&&!changed;i++)await new Promise(r=>setTimeout(r,50));assert.equal(changed,1);assert.equal(ggufFileAvailability(file).status,'ready');assert.equal(await modelLocationDirectory(file),volume);
    watcher.update([{modelPath:file}]);await rename(volume,offline);await new Promise(r=>setTimeout(r,450));assert.equal(changed,1,'available models stop watching for mount arrival');assert.equal(ggufFileAvailability(file).status,'unavailable');
  }finally{watcher.close();}
  console.log('PASS real filesystem arrival event, same-path availability recovery and watcher removal without polling, saving or mounting');
}
void test().catch(error=>{console.error(error);process.exitCode=1;});
