import {watch,type FSWatcher} from 'node:fs';
import {dirname} from 'node:path';
import {mediaStorageRoot} from './gguf-artifacts';

/** Event-driven mount-point discovery; no disk scan, polling or mount action. */
export class ModelStorageWatch{
  private watchers=new Map<string,FSWatcher>();
  private timers:Array<ReturnType<typeof setTimeout>>=[];
  constructor(private readonly changed:()=>void,private readonly storageRoot=mediaStorageRoot){}
  update(models:Array<{modelPath?:string;availabilityReason?:string}>){
    const directories=new Set(models.filter(m=>m.availabilityReason==='disk-unavailable').map(m=>m.modelPath&&this.storageRoot(m.modelPath)).filter((p):p is string=>Boolean(p)).map(dirname));
    for(const [directory,watcher]of this.watchers)if(!directories.has(directory)){watcher.close();this.watchers.delete(directory);}
    if(!directories.size){this.timers.forEach(clearTimeout);this.timers=[];}
    for(const directory of directories)if(!this.watchers.has(directory)){
      try{const watcher=watch(directory,{persistent:false},()=>{this.timers.forEach(clearTimeout);this.timers=[350,1500,4000].map(delay=>{const timer=setTimeout(this.changed,delay);timer.unref();return timer;});});watcher.on('error',()=>{watcher.close();this.watchers.delete(directory);});this.watchers.set(directory,watcher);}catch{/* Focus and explicit Refresh still revalidate if the parent cannot be watched. */}
    }
  }
  close(){this.timers.forEach(clearTimeout);this.timers=[];for(const watcher of this.watchers.values())watcher.close();this.watchers.clear();}
}
