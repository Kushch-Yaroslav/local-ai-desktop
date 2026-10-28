// Execute the actual Node entry points without an explicit runtime override.
// Their first import must isolate all application singletons before use.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,stat,mkdtemp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const artifacts=await mkdtemp('/tmp/lad-test-isolation-audit-');
const files=['runtime/logs/application.log','runtime/protected-runtime.json','runtime/protected-runtime-events.jsonl'];
async function baseline(){return Promise.all(files.map(async file=>{try{const data=await readFile(file),info=await stat(file);return {file,bytes:info.size,hash:createHash('sha256').update(data).digest('hex')};}catch(e){if(e.code==='ENOENT')return {file,absent:true};throw e;}}));}
const before=await baseline();
const entries=['chat-continuation','web-chat','rust-agent-runtime'];
const results=await Promise.all(entries.map(entry=>new Promise((resolveResult,reject)=>{
 const env={...process.env};delete env.LOCAL_AI_RUNTIME_ROOT;
 const source=`require(${JSON.stringify(resolve('dist/main/services/'+entry+'.test.js'))}); console.log('ISOLATED_ROOT='+process.env.LOCAL_AI_RUNTIME_ROOT);`;
 const child=spawn(process.execPath,['-e',source],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('exit',async code=>{await writeFile(join(artifacts,entry+'.log'),output,{mode:0o600});if(code!==0)return reject(Error(entry+' failed: '+code+'; '+artifacts));const root=output.match(/ISOLATED_ROOT=(.+)/)?.[1];assert(root?.startsWith('/tmp/lad-node-regression-'));resolveResult({entry,root});});
})));
assert.equal(new Set(results.map(r=>r.root)).size,entries.length,'Parallel entry points must not share a runtime');
assert.deepEqual(await baseline(),before,'Default Node tests must not change user runtime diagnostics');
await writeFile(join(artifacts,'result.json'),JSON.stringify({result:'PASS',results,userRuntimeUnchanged:true},null,2));
console.log(JSON.stringify({result:'PASS',artifacts,results,userRuntimeUnchanged:true}));
