// Offline evaluation of saved answers. Generated TS runs without supplied I/O APIs,
// with a VM timeout. This is a correctness harness, not a security sandbox.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

const root = process.argv[2] || 'docs/experiments/advanced-placement-moe';
const checks = {
 typescript: `const input=[{id:'a',n:1},{id:'b',n:2},{id:'a',n:3}]; const before=JSON.stringify(input); const out=stableUnique(input,x=>x.id); check(JSON.stringify(out)===JSON.stringify(input.slice(0,2))); check(JSON.stringify(input)===before); check(stableUnique([],String).length===0);`,
 rotate_ts: `for(const a of [[],[1],[1,2,3,4]]) for(let k=-13;k<=13;k++){ const before=JSON.stringify(a); const out=rotateRight(a,k); const n=a.length;const shift=n?((k%n)+n)%n:0; const expected=shift?[...a.slice(n-shift),...a.slice(0,n-shift)]:[...a]; check(JSON.stringify(out)===JSON.stringify(expected)); check(JSON.stringify(a)===before); }`,
 lower_bound_ts: `for(let n=0;n<20;n++)for(let x=-1;x<23;x++){const a=Array.from({length:n},(_,i)=>Math.floor(i/2));const before=JSON.stringify(a);const j=a.findIndex(v=>v>=x);check(lowerBound(a,x)===(j<0?n:j));check(JSON.stringify(a)===before);}`,
};
function codeOf(text) { return [...text.matchAll(/```(?:typescript|ts|tsx|javascript|js)?\s*\n([\s\S]*?)```/g)].map(m=>m[1]).join('\n') || text; }
function evaluate(run) {
 const result={task:run.task,repeat:run.repeat,complete:run.stop_type==='eos',promptHash:run.formatted_prompt_sha256,textHash:createHash('sha256').update(run.content).digest('hex'),checks:[]};
 const add=(name,fn)=>{try{fn();result.checks.push({name,passed:true});}catch(e){result.checks.push({name,passed:false,error:String(e.message).slice(0,250)});}};
 if(run.task==='facts'||run.task==='facts_exact') add('exact-json',()=>assert.deepEqual(JSON.parse(run.content),run.task==='facts'?{owner:'Nadia',date:'2027-03-14',budget:'7300 EUR'}:{ticket:'R-17',owner:'Lina',count:0,enabled:false}));
 if(checks[run.task]) {
  const source=codeOf(run.content);
  add('requested-assertions-present',()=>{const count=[...source.matchAll(/(?:console\.)?assert(?:Equal|DeepEqual)?\s*\(/g)].length;assert.ok(count >= (run.task==='rotate_ts'?3:2),'Missing requested assertions; test-case relevance still requires review');});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-quality-'));const file=path.join(temp,'answer.ts');
  try {
   fs.writeFileSync(file,source);
   add('typescript-strict-typecheck',()=>{
    const program=ts.createProgram([file],{strict:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,types:[],skipLibCheck:true});
    const errors=ts.getPreEmitDiagnostics(program).filter(d=>d.category===ts.DiagnosticCategory.Error);assert.equal(errors.length,0,errors.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('; '));
   });
   add('functional-cases',()=>{
    const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    const context={exports:{},check:(condition)=>assert.ok(condition),console:{assert:(condition,...msg)=>assert.ok(condition,msg.join(' ')),log:()=>{}}};
    vm.runInNewContext(js+'\n'+checks[run.task],context,{timeout:1000});
   });
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
 }
 // Narrative/React/Python cases require a separate review; never count no checks as passed.
 result.automatedVerdict=result.checks.length?(result.checks.every(c=>c.passed)&&result.complete?'pass':'fail'):'manual-review-required';return result;
}
const reports=[];
for(const budget of [0,8192,12288,16384]) {
 const dir=path.join(root,`qwen-ab-cache${budget}`);if(!fs.existsSync(dir))continue;
 for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))) {
  const data=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));reports.push({budget,file:path.join(dir,name),status:data.status,settings:Object.fromEntries(Object.entries(data.args||{}).filter(([k])=>!['outdir','moe_cache_mib'].includes(k))),answers:data.runs.map(evaluate)});
 }
}
const baseline=reports.find(r=>r.budget===0);const comparisons=[];
if(baseline)for(const report of reports.filter(r=>r.budget!==0))for(const a of report.answers){const b=baseline.answers.find(b=>b.task===a.task&&b.repeat===a.repeat);if(!b)continue;comparisons.push({budget:report.budget,task:a.task,repeat:a.repeat,samePromptHash:!!a.promptHash&&a.promptHash===b.promptHash,sameText:a.textHash===b.textHash,sameSettings:JSON.stringify(report.settings)===JSON.stringify(baseline.settings),newAutomatedFailure:b.automatedVerdict==='pass'&&a.automatedVerdict==='fail'});}
fs.writeFileSync(path.join(root,'qwen-ab-quality.json'),JSON.stringify({reports,comparisons,limitations:'Manual review remains required. No-check answers are not counted as passing; this suite cannot certify universal quality.'},null,2)+'\n');
console.log(JSON.stringify({reports:reports.length,checks:reports.flatMap(r=>r.answers.flatMap(a=>a.checks)).length,newFailures:comparisons.filter(c=>c.newAutomatedFailure).length}));
