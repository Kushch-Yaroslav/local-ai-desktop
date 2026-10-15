import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export async function bounded(label, operation, milliseconds=5000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(`${label}: timeout after ${milliseconds} ms`)),milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export function identity(pid) {
  try {
    const text=readFileSync(`/proc/${pid}/stat`,'utf8');
    const fields=text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/);
    return {pid:Number(pid),ppid:Number(fields[1]),startTime:fields[19],state:fields[0]};
  } catch { return null; }
}
// Ownership follows actual ancestry and a private fixture spawn ledger. Neither
// executable names nor system-wide process groups authorize cleanup.
export class OwnedProcesses {
  constructor(parentPid,ledgerPath) {
    this.parentPid=parentPid;this.ledgerPath=ledgerPath;
    this.records=new Map();this.add(identity(parentPid));
  }
  add(record) { if(record)this.records.set(`${record.pid}:${record.startTime}`,record); }
  refresh() {
    const owned=new Set([...this.records.values()].filter(record=>identity(record.pid)?.startTime===record.startTime).map(record=>record.pid));
    try {
      const ledger=JSON.parse(readFileSync(this.ledgerPath,'utf8'));
      // The trusted fixture records children before their parent can disappear.
      for(const record of ledger){
        if([...this.records.values()].some(parent=>parent.pid===record.ppid && parent.startTime===record.parentStartTime) && identity(record.pid)?.startTime===record.startTime){this.add(record);owned.add(record.pid);}
      }
    } catch { /* Not yet published or atomically replaced. */ }
    const all=readdirSync('/proc').filter(name=>/^\d+$/.test(name)).map(identity).filter(Boolean);
    let changed=true;
    while(changed){changed=false;for(const record of all){if(!owned.has(record.pid)&&owned.has(record.ppid)){this.add(record);owned.add(record.pid);changed=true;}}}
  }
  live() { return [...this.records.values()].filter(record=>{
    const current=identity(record.pid);
    return record.pid!==this.parentPid && current?.startTime===record.startTime && current.state!=='Z';
  }); }
  signal(signal) {
    for(const record of this.live().reverse()){
      // Recheck immediately before signaling; retired/reused PIDs are excluded.
      if(identity(record.pid)?.startTime!==record.startTime)continue;
      try { process.kill(record.pid,signal); } catch(error){if(error.code!=='ESRCH')throw error;}
    }
  }
  async stop() {
    this.refresh();this.signal('SIGTERM');
    for(let attempt=0;attempt<24 && this.live().length;attempt++)await delay(50);
    this.signal('SIGKILL');
    for(let attempt=0;attempt<24 && this.live().length;attempt++)await delay(50);
    if(this.live().length)throw new Error('Fixture-owned processes did not exit: '+JSON.stringify(this.live()));
  }
}
