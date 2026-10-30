import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-eval-test-'));
try{
 const answers=[
  ['typescript',`function stableUnique<T>(a:readonly T[],key:(v:T)=>string):T[]{const s=new Set<string>();return a.filter(v=>{const k=key(v);if(s.has(k))return false;s.add(k);return true;});}`],
  ['rotate_ts',`export function rotateRight<T>(a:readonly T[],k:number):T[]{const n=a.length;if(!n)return [];k=((k%n)+n)%n;return k?[...a.slice(n-k),...a.slice(0,n-k)]:[...a];}`],
  ['lower_bound_ts',`export function lowerBound(a:readonly number[],x:number):number{let l=0,r=a.length;while(l<r){const m=(l+r)>>>1;if(a[m]<x)l=m+1;else r=m;}return l;}`],
  ['facts_exact',JSON.stringify({ticket:'R-17',owner:'Lina',count:0,enabled:false})],
 ];
 for(const budget of [0,8192]){
  const dir=path.join(root,`qwen-ab-cache${budget}`);fs.mkdirSync(dir);
  const runs=answers.map(([task,original])=>{const content=task==='facts_exact'?original:original+'\nconsole.assert(true);console.assert(true);console.assert(true);';return {task,content:budget&&task==='lower_bound_ts'?'export function lowerBound(a:readonly number[],x:number):number{return 0;}':budget&&task==='facts_exact'?'{}':content,repeat:1,stop_type:'eos',formatted_prompt_sha256:'identical'};});
  fs.writeFileSync(path.join(dir,'fixture.json'),JSON.stringify({status:'passed',runs}));
 }
 execFileSync(process.execPath,['scripts/evaluate-qwen-ab.mjs',root],{timeout:60000});
 const report=JSON.parse(fs.readFileSync(path.join(root,'qwen-ab-quality.json')));
 assert.ok(report.reports[0].answers.every(a=>a.automatedVerdict==='pass'));
 assert.equal(report.comparisons.filter(c=>c.newAutomatedFailure).length,2);
 assert.ok(report.comparisons.every(c=>c.samePromptHash));
 console.log('PASS: typecheck/functional evaluator accepts known correct answers and detects two deliberate regressions');
}finally{fs.rmSync(root,{recursive:true,force:true});}
