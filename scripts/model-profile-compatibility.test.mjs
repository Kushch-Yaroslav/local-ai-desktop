// Compatibility unit suites explicitly opt into historical templates, never user settings.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
const root=await mkdtemp('/tmp/lad-profile-compat-');process.env.LOCAL_AI_RUNTIME_ROOT=root;
const require=createRequire(import.meta.url);
const settings=require('../dist/main/services/runtime-settings.js');
await mkdir(join(root,'logs'),{recursive:true});
const config=settings.normalizeConfiguration({...settings.loadRuntimeConfiguration(),modelsPath:join(root,'models'),models:{},llamaServerPath:null});
await mkdir(dirname(settings.settingsFile),{recursive:true});
for(const model of config.models){
 // Missing target metadata exercises legacy capability defaults; only projector presence is needed.
 await mkdir(dirname(model.modelPath),{recursive:true});
 if(model.mmprojPath){await mkdir(dirname(model.mmprojPath),{recursive:true});await writeFile(model.mmprojPath,'unit fixture');}
}
await writeFile(settings.settingsFile,JSON.stringify(config));
for (const file of ['models/model-capabilities','models/llama-launch-config','services/llama-runtime-controller','backends/llama-cpp-backend']) {
 execFileSync(process.execPath,[resolve(`dist/main/${file}.test.js`)],{env:process.env,stdio:'inherit',timeout:60_000});
}
console.log('Compatibility unit suites use isolated runtime:',root);
