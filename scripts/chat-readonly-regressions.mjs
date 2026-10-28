import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const suites=[
 'services/persistent-attachments','services/chat-readonly-tools','services/chat-context','services/legacy-chat-diagnostics',
 'services/document-reading-recovery','services/chat-continuation','services/attachment-pipeline','services/database','services/web-chat','services/rich-chat-http',
 'services/generation-diagnostics','services/agent-evidence','services/rust-agent-runtime','services/agent-workspace',
 'services/llama-runtime-controller','services/run-recovery','backends/llama-cpp-backend','tools/tool-security',
 'web/public-network','web/web-tools','web/search-providers','web/verification-route-scope',
];
const root=mkdtempSync(join(tmpdir(),'lad-chat-readonly-regressions-')),results=[];
for(const suite of suites){const runtime=join(root,suite.replaceAll('/','-'));for(const folder of ['sqlite','app-data','attachments','logs','models'])mkdirSync(join(runtime,folder),{recursive:true});
 const run=spawnSync(process.execPath,[resolve('dist/main/'+suite+'.test.js')],{env:{...process.env,LOCAL_AI_RUNTIME_ROOT:runtime},encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 writeFileSync(join(runtime,'test.log'),run.stdout+run.stderr);results.push({suite,passed:run.status===0,error:run.error?.message});console.log((run.status===0?'PASS ':'FAIL ')+suite);if(run.status!==0)console.error((run.stdout+run.stderr).slice(-3500));
}
for(const suite of ['localization','localization-coverage','context-format','model-storage-hint','generation-progress']){
 const run=spawnSync(process.execPath,[resolve('dist/shared/'+suite+'.test.js')],{env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root},encoding:'utf8'});results.push({suite,passed:run.status===0});console.log((run.status===0?'PASS ':'FAIL ')+suite);if(run.status!==0)console.error(run.stderr);
}
writeFileSync(join(root,'result.json'),JSON.stringify({root,results},null,2));console.log(JSON.stringify({root,passed:results.filter(r=>r.passed).length,total:results.length}));if(results.some(r=>!r.passed))process.exitCode=1;
