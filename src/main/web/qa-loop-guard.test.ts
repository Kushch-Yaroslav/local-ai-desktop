import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QaLoopGuard, projectRevision } from './qa-loop-guard';
import { qaSteps } from './browser-qa';
import type { BrowserQaReport } from '../../shared/browser-qa';
void (async () => {
  const root = await mkdtemp(join(tmpdir(),'qa-loop-'));
  const report = (actual = 'same'): BrowserQaReport => ({id:'report',status:'Failed',url:'https://project-preview.invalid/',capturedAt:'now',checks:[{action:'click #button',expected:'works',actual,status:'Failed'}],errors:['camera rotation defect'],captures:[],visual:{analyzed:false,status:'Not Verified'},elapsedMs:100,evidencePath:'/evidence/previous.json'});
  try {
    await writeFile(join(root,'index.html'),'<script src="app.js"></script>');
    await writeFile(join(root,'app.js'),'const version=1');
    const first = await projectRevision(root);
    await utimes(join(root,'app.js'),new Date(),new Date());assert.equal(await projectRevision(root),first,'mtime is not source progress');
    await mkdir(join(root,'evidence'));await writeFile(join(root,'evidence/check.json'),'{}');assert.equal(await projectRevision(root,[join(root,'evidence')]),first,'evidence must not manufacture source progress');
    await writeFile(join(root,'app.js'),'const version=2');assert.notEqual(await projectRevision(root,[join(root,'evidence')]),first,'dependent JS edit is real progress');
    const guard = new QaLoopGuard(), scenario = qaSteps([{action:'key',key:'w',ignored:'noise',expect:{selector:'#camera',changed:true}}]);
    assert.deepEqual(scenario,qaSteps([{expect:{changed:true,selector:'#camera'},key:'w',action:'key',ignored:'other'}]));
    const key = () => guard.key(first,'https://project-preview.invalid/',scenario,{camera:0},{model:'qwen'});
    let identity=key();guard.record(identity,report(),{camera:1});
    // The first test changed the camera itself; this is not external progress.
    identity=guard.key(first,'https://project-preview.invalid/',scenario,{camera:1},{model:'qwen'});guard.record(identity,report(),{camera:1});
    assert(guard.before(identity)?.loop.previousEvidence);
    guard.reopened({camera:0});assert(guard.before(key()),'closing/reopening the browser cannot evade the guard');
    assert(!guard.before(guard.key(first,'https://project-preview.invalid/',qaSteps([{action:'key',key:'w',expect:{selector:'#camera',text:'new expected state'}}]),{camera:0},{model:'qwen'})),'a changed expected result is a meaningful new scenario');
    assert(!guard.before(guard.key('new-source','https://project-preview.invalid/',scenario,{camera:0},{model:'qwen'})));
    assert(!guard.before(guard.key(first,'https://project-preview.invalid/',[{action:'hold',key:'w'}],{camera:0},{model:'qwen'})));
    assert(!guard.before(guard.key(first,'https://project-preview.invalid/',scenario,{camera:3},{model:'qwen'})));
    assert(!guard.before(guard.key(first,'https://project-preview.invalid/',scenario,{camera:3},{model:'other'})));
    guard.authorized();assert(!guard.before(key()));guard.rearm();assert(!guard.before(key()));
    const alternating=new QaLoopGuard();
    for(let i=0;i<2;i++)for(const action of ['A','B','C']){const k=alternating.key(first,'url',action,{},{});alternating.record(k,report(),{});}
    for(const action of ['A','B','C'])assert(alternating.before(alternating.key(first,'url',action,{},{})),'alternating unchanged scenarios are still blocked');
    const changed=new QaLoopGuard(), k=changed.key(first,'url',scenario,{},{});changed.record(k,report('first failure'),{});changed.record(k,report('different failure'),{});assert(!changed.before(k),'a changed observed outcome gets a fresh observation');changed.record(k,report('first failure'),{});assert(changed.before(k),'A/B/A visual outcome oscillation must not masquerade as progress');
    const statuses=new QaLoopGuard(), statusKey=statuses.key(first,'url',scenario,{},{});
    for(const status of ['Verified','Failed','Partially Verified'] as const){assert(!statuses.before(statusKey));statuses.record(statusKey,{...report(),status},{});}
    assert(!statuses.before(statusKey),'three distinct observations alone are not a task allowance');statuses.record(statusKey,{...report(),status:'Verified'},{});assert(statuses.before(statusKey),'a recurring three-status cycle is blocked with preserved evidence');
    for(const key of ['q','e','Shift+w','Control+a'])assert(qaSteps([{action:'hold',key,duration_ms:250}]).length);
    assert.throws(()=>qaSteps([{action:'hold',key:'w',duration_ms:90000}]));
    console.log('PASS QA guard: content revisions, own-evidence exclusion, normalized scenarios, outcomes, page/runtime/permission changes, reopen, explicit continuation, alternating cycles and real keyboard schema.');
  } finally { await rm(root,{recursive:true,force:true}); }
})();
