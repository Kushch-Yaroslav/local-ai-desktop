import type {Page} from 'playwright-core';
import type {VisualRegion,VisualBindingState} from '../../shared/visual-debugging';
import {projectVisualRegion} from '../../shared/browser-coordinates';
import {getLanguage} from '../../shared/locale';

/** Persistent, pointer-transparent annotations. No host paths or image payloads enter the page. */
export async function visualRegionsOverlay(page:Page,regions:VisualRegion[],enabled:boolean,selected:string[],author:boolean){
  const install=(data:{regions:Array<VisualRegion&{label:string}>;enabled:boolean;selected:string[];author:boolean},project:typeof projectVisualRegion)=>{
    type State={boxes:Array<{id:string;x:number;y:number;width:number;height:number;color:string;label:string;selected:boolean}>;bindings:VisualBindingState[]};
    type Controller={update:(d:typeof data)=>void;read:()=>State;stop:()=>void};
    const scope=window as unknown as {__ladVisualRegions?:Controller};
    if(scope.__ladVisualRegions){scope.__ladVisualRegions.update(data);return scope.__ladVisualRegions.read();}
    let host:HTMLDivElement|undefined,layer:ShadowRoot|undefined,frame=0,last=0,signature='',dirty=true;
    const resolved=new Map<string,Element[]>();let current:State={boxes:[],bindings:[]};
    const own=(node:Node)=>node instanceof Element&&Boolean(node.closest('[id^="__lad-"]'));
    const observer=new MutationObserver(records=>{if(records.some(r=>!own(r.target)&&(r.type!=='childList'||[...r.addedNodes,...r.removedNodes].some(n=>!own(n)))))dirty=true;});
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    const lookup=(selector:string)=>{if(!resolved.has(selector))resolved.set(selector,Array.from(document.querySelectorAll(selector)));return resolved.get(selector)!;};
    const draw=()=>{
      if(dirty){resolved.clear();dirty=false;}
      current={boxes:[],bindings:[]};
      for(const r of data.regions){const result=project(r,lookup);current.bindings.push({id:r.id,stale:result.stale,reason:result.reason,kind:!r.anchors.length?'screenshot':r.anchors[0].confidence<.8?'ambiguous':'dom'});if(result.rect)current.boxes.push({id:r.id,...result.rect,color:r.color??'#22d3ee',label:r.label,selected:data.selected.includes(r.id)});}
      const next=JSON.stringify([data.enabled,data.author,current.boxes]);if(next===signature)return;signature=next;
      if(!data.enabled||!data.author){host?.remove();host=undefined;layer=undefined;return;}
      if(!host){host=document.createElement('div');host.id='__lad-visual-regions';host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483646';layer=host.attachShadow({mode:'closed'});document.documentElement.append(host);}
      layer!.replaceChildren();for(const b of current.boxes){const node=document.createElement('div');node.dataset.regionId=b.id;node.style.cssText=`position:absolute;pointer-events:none;box-sizing:border-box;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;border:${b.selected?5:3}px solid ${b.color};box-shadow:0 0 0 1px #fff,0 0 0 ${b.selected?4:2}px #111;background:${b.color}${b.selected?'28':'0b'};`;const label=document.createElement('span');label.textContent=b.label;label.style.cssText=`background:#111;color:white;border:1px solid ${b.color};font: bold 12px sans-serif;padding:2px 4px;`;node.append(label);layer!.append(node);}
    };
    const tick=(now:number)=>{if(now-last>=100){last=now;draw();}frame=requestAnimationFrame(tick);};
    const redraw=()=>{dirty=true;draw();};addEventListener('scroll',redraw,true);addEventListener('resize',redraw);
    scope.__ladVisualRegions={update:d=>{if(JSON.stringify(data)===JSON.stringify(d))return;const changed=JSON.stringify(data.regions)!==JSON.stringify(d.regions);data=d;if(changed)dirty=true;draw();},read:()=>current,stop:()=>{cancelAnimationFrame(frame);observer.disconnect();removeEventListener('scroll',redraw,true);removeEventListener('resize',redraw);host?.remove();delete scope.__ladVisualRegions;}};
    draw();frame=requestAnimationFrame(tick);return current;
  };
  const data={enabled,selected,author,regions:regions.map(r=>({id:r.id,url:r.url,rect:r.rect,viewport:r.viewport,dpr:r.dpr,snapshot:r.snapshot,anchors:r.anchors.map(a=>({tag:a.tag,selector:a.selector,confidence:a.confidence,rect:a.rect,identity:a.identity})),color:r.color,label:`${getLanguage()==='ru'?'Область':'Area'} ${r.groupNumber??'?'} · #${r.id.slice(7,15)}`}))};
  return page.evaluate<ReturnType<typeof install>>(`(${install.toString()})(${JSON.stringify(data)},${projectVisualRegion.toString()})`);
}
