// Run existing suites once against the built code; preserve individual logs/results.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,open,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const directory=resolve('docs/test-results/scenario-qa');await mkdir(directory,{recursive:true});
const tests=[
 'scripts/scenario-qa.test.mjs','scripts/scenario-qa-electron.test.mjs','scripts/scenario-gate-runtime.test.mjs',
 'dist/main/services/mtp-capability.test.js','dist/main/services/llama-runtime-controller.test.js','dist/main/services/runtime-settings.test.js',
 'dist/main/models/model-capabilities.test.js','dist/main/models/llama-launch-config.test.js','dist/main/services/browser-vision.test.js',
 'dist/main/web/qa-loop-guard.test.js','dist/main/tools/tool-security.test.js','dist/main/services/protected-runtime.test.js',
 'dist/main/services/rust-agent-runtime.test.js','dist/main/ipc/logical-task-runtime.test.js',
 'dist/main/ipc/context-profiles.test.js','scripts/p3-panel-electron.test.mjs','scripts/p3-qa-semantics.test.mjs',
 'scripts/renderer-runtime-status.test.mjs','scripts/qa-loop-runtime.test.mjs','scripts/p2-browser-qa.test.mjs','scripts/p2-gate-runtime.test.mjs',
 'scripts/p2-controls-electron.test.mjs','scripts/p2-qa-panel-electron.test.mjs','scripts/mtp-ui.test.mjs',
 'scripts/runtime-controls-ui.test.mjs','scripts/runtime-controls-electron.test.mjs',
 'scripts/native-browser-assets.test.mjs','scripts/native-browser-lineage.test.mjs','scripts/native-browser.test.mjs',
 'scripts/llama-launch-config.test.sh','scripts/electron-sandbox.test.sh','scripts/llama-launcher-failure.test.sh','scripts/llama-launcher-idle.test.sh',
 'scripts/live-browser-autoreload.test.mjs','scripts/live-browser-autoreload-electron.test.mjs',
];
const selected=process.argv.slice(2),results=selected.length?JSON.parse(await readFile(resolve(directory,'regressions.json'),'utf8')).filter(r=>!selected.includes(r.test)):[];
for(const file of tests.filter(file=>!selected.length||selected.includes(file))){const log=await open(resolve(directory,file.replaceAll('/','_')+'.log'),'w'),start=performance.now();const child=spawn(file.endsWith('.sh')?'bash':process.execPath,[file],{env:{...process.env,LOCAL_AI_TEST_RESULTS_DIR:directory},stdio:['ignore',log.fd,log.fd]});const code=await new Promise(r=>child.once('exit',r));await log.close();results.push({test:file,code,elapsedMs:performance.now()-start});await writeFile(resolve(directory,'regressions.json'),JSON.stringify(results,null,2));console.log(code===0?'PASS':'FAIL',file);}
if(results.some(r=>r.code!==0))process.exitCode=1;
