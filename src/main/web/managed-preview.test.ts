import assert from 'node:assert/strict';
import {
  carryBrowserRoute, resolveManagedPreviewTask, sameBrowserRoute, updateManagedPreviewTasks,
  type ManagedPreviewTask,
} from './managed-preview';

const root='/tmp/lad-preview-fixture';
const runId='run-current';
const observedAt=10_000;
const records=new Map<string,ManagedPreviewTask>();
updateManagedPreviewTasks(records,{task_id:'managed-42',cwd:root,command:'npm run dev -- --host 127.0.0.1',state:'ready',url:'http://localhost:5174/'},{action:'start'},root,runId,observedAt);
assert.equal(resolveManagedPreviewTask(records,'managed-42','http://localhost:5174/',root,runId,observedAt+1),undefined,'a start result alone does not confirm the task remains active');
updateManagedPreviewTasks(records,{tasks:[{
  task_id:'managed-42',cwd:root,command:'npm run dev -- --host 127.0.0.1',state:'ready',
  url:'http://localhost:5174/',pid:42,pgid:42,
}]},{action:'list'},root,runId,observedAt);

assert.equal(resolveManagedPreviewTask(records,'managed-42','http://127.0.0.1:5174/it/product/1',root,runId,observedAt+1)?.url,'http://localhost:5174/');
for(const target of [
  'http://localhost:5173/', 'http://192.168.1.4:5174/', 'https://localhost:5174/',
  'http://user@localhost:5174/', 'http://localhost:5174.evil/',
]) assert.equal(resolveManagedPreviewTask(records,'managed-42',target,root,runId,observedAt+1),undefined,target);
assert.equal(resolveManagedPreviewTask(records,'wrong-task','http://localhost:5174/',root,runId,observedAt+1),undefined);
assert.equal(resolveManagedPreviewTask(records,'managed-42','http://localhost:5174/',root,'another-run',observedAt+1),undefined);
assert.equal(resolveManagedPreviewTask(records,'managed-42','http://localhost:5174/',root,runId,observedAt+5001),undefined,'stale task output must not authorize a switch');
assert.equal(resolveManagedPreviewTask(records,'managed-42','http://localhost:5174/',`${root}-other`,runId,observedAt+1),undefined,'other project must not reuse this task');

const rejected=new Map<string,ManagedPreviewTask>();
updateManagedPreviewTasks(rejected,{task_id:'node18',cwd:root,command:'npm run dev',state:'failed',code:'UNSUPPORTED_NODE_VERSION',diagnostic:'Vite requires Node.js 20.19+',url:null},{action:'status',taskId:'node18'},root,runId,observedAt);
assert.equal(resolveManagedPreviewTask(rejected,'node18','http://localhost:5174/',root,runId,observedAt+1),undefined,'incompatible Node task is never preview-ready');
const nonVite=new Map<string,ManagedPreviewTask>();
updateManagedPreviewTasks(nonVite,{task_id:'other',cwd:root,command:'python3 server.py',state:'ready',url:'http://localhost:5174/'},{action:'status',taskId:'other'},root,runId,observedAt);
assert.equal(resolveManagedPreviewTask(nonVite,'other','http://localhost:5174/',root,runId,observedAt+1),undefined,'another service is not a project Vite task');

const current='http://localhost:5173/?currency=EUR#/it/product/1';
const carried=carryBrowserRoute(current,'http://127.0.0.1:5174/');
assert.equal(carried,'http://127.0.0.1:5174/?currency=EUR#/it/product/1');
assert(sameBrowserRoute(current,carried));
assert.equal(carryBrowserRoute(current,'http://127.0.0.1:5174/?locale=en'),'http://127.0.0.1:5174/?locale=en#/it/product/1','explicit query replaces its counterpart but preserves an unspecified HashRouter route');
assert.equal(carryBrowserRoute(current,'http://127.0.0.1:5174/#/it/product/2'),'http://127.0.0.1:5174/?currency=EUR#/it/product/2','explicit target route replaces only the hash route');
assert.equal(carryBrowserRoute(current,'http://127.0.0.1:5174/it/product/2'),'http://127.0.0.1:5174/it/product/2','an explicit path is a different route');

console.log('PASS managed preview task provenance, project/run/age/port checks, unsupported Node and non-Vite rejection, and route/query/hash carry-forward');
