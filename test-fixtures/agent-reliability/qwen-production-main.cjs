// Ownership instrumentation only: load the actual application main and IPC.
// No fake backend, model responses, terminal executor or permission classifier.
const fs=require('node:fs');
const cp=require('node:child_process');
const path=require('node:path');
const ledger=[];
function record(pid) {
  try {
    const fields=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(/\) /).at(-1).trim().split(/\s+/);
    const ppid=Number(fields[1]);
    const parent=fs.readFileSync(`/proc/${ppid}/stat`,'utf8').split(/\) /).at(-1).trim().split(/\s+/);
    ledger.push({pid,ppid,startTime:fields[19],parentStartTime:parent[19]});
    fs.writeFileSync(process.env.LOCAL_AI_QWEN_LEDGER+'.tmp',JSON.stringify(ledger));
    fs.renameSync(process.env.LOCAL_AI_QWEN_LEDGER+'.tmp',process.env.LOCAL_AI_QWEN_LEDGER);
  } catch { /* The periodic ancestry monitor also records live descendants. */ }
}
const originalSpawn=cp.spawn;
cp.spawn=function(...args){const child=originalSpawn.apply(this,args);child.once('spawn',()=>record(child.pid));return child;};
global.qwenHarness={modeSelections:[],otherDialogs:[],context:{pid:process.pid,uid:process.getuid(),label:fs.readFileSync('/proc/self/attr/current','utf8').trim()}};
const publishObservation=()=>fs.writeFileSync(process.env.LOCAL_AI_QWEN_LEDGER+'.observation.json',JSON.stringify(global.qwenHarness));
publishObservation();
const {dialog}=require('electron');
dialog.showMessageBox=async(...args)=>{
  const options=args.at(-1);
  const {t}=require(path.resolve('dist/shared/locale'));
  // The operator explicitly authorized this mode. Acknowledge only its one
  // initial selection dialog, never a tool approval or an unknown dialog.
  if(options.title===t('Разрешить опасный режим?') && global.qwenHarness.modeSelections.length===0){
    global.qwenHarness.modeSelections.push({title:options.title,detail:options.detail,buttons:options.buttons});
    publishObservation();
    return {response:1,checkboxChecked:false};
  }
  global.qwenHarness.otherDialogs.push(options);publishObservation();
  throw Error('Unexpected dialog in the isolated acceptance: '+options.title);
};
require(path.resolve('dist/main/index.js'));
