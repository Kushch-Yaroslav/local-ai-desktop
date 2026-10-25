import { getLanguage } from '../../shared/locale';
import type { Page } from 'playwright-core';
import { visualRoute } from '../../shared/visual-debugging';
import type { VisualRect, VisualRegion } from '../../shared/visual-debugging';
import { visualGroupColor } from '../../shared/visual-debugging';

/** Executed inside the native project page. No application APIs or filesystem access. */
export async function selectionOverlay(page: Page, enabled: boolean, regions: VisualRegion[] = [], transient=false) {
  const install=({ enabled, transient }: {enabled:boolean;regions:Array<VisualRegion&{label:string;color:string}>;transient:boolean}) => {
    const state = window as unknown as { __ladSelection?: () => void; __ladHighlight?:()=>void; __ladRegionSelect?: (rect: VisualRect|null) => Promise<void> };
    if(transient)state.__ladHighlight?.();else {state.__ladSelection?.();state.__ladHighlight?.();}
    if (!enabled) return;
    const host = document.createElement('div'); host.id = transient?'__lad-visual-highlight':'__lad-visual-selection';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;touch-action:none;';
    if(transient)host.style.pointerEvents='none';
    const shadow = host.attachShadow({mode:'closed'});
    const layer = document.createElement('div'); shadow.append(layer);
    let start: {x:number;y:number} | undefined;let pending=false;
    const box = (rect: VisualRect, label: string, color: string) => {
      const node = document.createElement('div');
      node.style.cssText = `position:absolute;pointer-events:none;box-sizing:border-box;border:3px solid ${color};box-shadow:0 0 0 1px #fff,0 0 0 2px #111;background:${color}22;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;color:#fff;font:12px sans-serif;`;
      const badge=document.createElement('span');badge.style.cssText=`background:#111;color:#fff;border:2px solid ${color};padding:2px 4px;font-weight:bold;`; badge.textContent=label;node.append(badge);layer.append(node);
    };
    const draw=()=>{layer.replaceChildren();};
    let frame=0,last=0;const tick=(time:number)=>{if(time-last>=100&&!start&&!pending){last=time;draw();}frame=requestAnimationFrame(tick);};
    let timer:ReturnType<typeof setTimeout>|undefined;
    const cleanup = () => { clearTimeout(timer);cancelAnimationFrame(frame);host.remove();removeEventListener('scroll',draw,true);removeEventListener('resize',draw);removeEventListener('keydown',key,true);if(transient)delete state.__ladHighlight;else delete state.__ladSelection; };
    const key = (event: KeyboardEvent) => {if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(start){start=undefined;draw();}else {cleanup();void state.__ladRegionSelect?.(null).catch(()=>undefined);}}};
    host.onpointerdown = event => {if(pending)return;if(event.button!==0){event.preventDefault();return;}event.preventDefault();start={x:event.clientX,y:event.clientY};host.setPointerCapture(event.pointerId);};
    host.onpointermove = event => {if(!start)return;draw();box({x:Math.min(start.x,event.clientX),y:Math.min(start.y,event.clientY),width:Math.abs(event.clientX-start.x),height:Math.abs(event.clientY-start.y)},'Selection','#fff');};
    host.onpointerup = async event => {if(!start)return;const rect={x:Math.min(start.x,event.clientX),y:Math.min(start.y,event.clientY),width:Math.abs(event.clientX-start.x),height:Math.abs(event.clientY-start.y)};start=undefined;draw();if(rect.width>=4&&rect.height>=4){pending=true;box(rect,'…','#fff');try{await state.__ladRegionSelect?.(rect);}catch{/* main publishes explicit failure; the unsaved draft is removed */}finally{pending=false;draw();}}};
    host.onpointercancel=()=>{start=undefined;draw();};
    host.onwheel=event=>{event.preventDefault();window.scrollBy(event.deltaX,event.deltaY);};
    document.documentElement.append(host);if(transient)state.__ladHighlight=cleanup;else state.__ladSelection=cleanup;frame=requestAnimationFrame(tick);if(transient)timer=setTimeout(cleanup,2200);addEventListener('scroll',draw,true);addEventListener('resize',draw);if(!transient)addEventListener('keydown',key,true);draw();
  };
  const data={enabled, transient, regions:regions.map(r=>({id:r.id,url:r.url,viewport:r.viewport,dpr:r.dpr,snapshot:r.snapshot,rect:r.rect,anchors:r.anchors.map(a=>({tag:a.tag,selector:a.selector,confidence:a.confidence,rect:a.rect})),color:r.color??visualGroupColor(r.groupId),label:`${getLanguage()==='ru'?'Область':'Area'} ${r.groupNumber??regions.findIndex(item=>item.groupId===r.groupId)+1}`}))};
  await page.evaluate(`(${install.toString()})(${JSON.stringify(data)})`);
}

export async function groundRegion(page: Page, rect: VisualRect) {
  const evidence=await page.evaluate(rect => {
    const overlay=document.getElementById('__lad-visual-selection');if(overlay)overlay.style.display='none';
    try {
      const overlap=(b:DOMRect)=>Math.max(0,Math.min(b.right,rect.x+rect.width)-Math.max(b.x,rect.x))*Math.max(0,Math.min(b.bottom,rect.y+rect.height)-Math.max(b.y,rect.y));
      // Bounded intersection scan, no HTML dump and no private control values.
      const visible=(e:Element)=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);for(let parent=e.parentElement,depth=0;parent&&depth++<12;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return false;}return b.width>0&&b.height>0&&b.right>0&&b.bottom>0&&b.x<innerWidth&&b.y<innerHeight&&s.display!=='none'&&s.visibility==='visible'&&Number(s.opacity)>0&&!e.closest('[hidden],[aria-hidden=true],[inert]');};
      const candidates=Array.from(document.querySelectorAll('body *')).slice(0,8000).filter(e=>!e.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive]') && !['SCRIPT','STYLE','NOSCRIPT'].includes(e.tagName)).map(e=>({e,b:e.getBoundingClientRect()})).filter(({e,b})=>b.width>0&&b.height>0&&overlap(b)>0&&visible(e)).sort((a,b)=>Math.abs(a.b.width*a.b.height-rect.width*rect.height)-Math.abs(b.b.width*b.b.height-rect.width*rect.height)).slice(0,4);
      const safeText=(root:Element)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let text='',node:Node|null,count=0;while((node=walker.nextNode())&&count++<200&&text.length<240)if(!node.parentElement?.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style'))text+=' '+node.textContent;return text.replace(/\s+/g,' ').trim().slice(0,240);};
      const anchors=candidates.filter(({e})=>!['CANVAS','SVG'].includes(e.tagName.toUpperCase()) && !e.closest('canvas,svg')).map(({e,b})=>{
        let selector=e.id&&e.id.length<=128?'#'+CSS.escape(e.id):e.tagName.toLowerCase()+Array.from(e.classList).filter(c=>c.length<=128).slice(0,3).map(c=>'.'+CSS.escape(c)).join('');
        let unique=false;try{unique=document.querySelectorAll(selector).length===1;}catch{selector=e.tagName.toLowerCase();}
        let identity:{text:string;context:string}|undefined=unique&&/\._[a-zA-Z][\w-]*?_[a-z0-9]+_\d+/.test(selector)?{text:safeText(e),context:safeText(e.parentElement??e)}:undefined;
        if(!unique){
          // A scoped structural candidate is guarded by bounded, non-private identity.
          const parts:string[]=[];for(let node:Element|null=e,depth=0;node&&depth++<10;node=node.parentElement){
            const stable=node.id&&node.id.length<=128?'#'+CSS.escape(node.id):undefined;
            if(stable){parts.unshift(stable);break;}
            const peers=Array.from(node.parentElement?.children??[]).filter(p=>p.tagName===node!.tagName);parts.unshift(node.tagName.toLowerCase()+(peers.length>1?`:nth-of-type(${peers.indexOf(node)+1})`:''));
            const path=parts.join(' > ');if(document.querySelectorAll(path).length===1)break;
          }
          const path=parts.join(' > ');if(path&&document.querySelectorAll(path).length===1){selector=path;unique=true;identity={text:safeText(e),context:safeText(e.parentElement??e)};}
        }
        const style=getComputedStyle(e);const styles:Record<string,string>={};for(const key of ['display','position','overflow','overflow-x','overflow-y','visibility','opacity','white-space','width','height','font-size','line-height','padding','box-sizing','color','background-color','max-width','font-weight','text-overflow','flex-wrap','align-items','border-radius','border-top-left-radius','border-top-right-radius','border-bottom-left-radius','border-bottom-right-radius'])styles[key]=style.getPropertyValue(key).slice(0,120);
        // Read bounded descendant text while excluding private controls and sensitive subtrees.
        const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let excerpt='',count=0,node:Node|null;
        while((node=walker.nextNode())&&count++<200&&excerpt.length<240){if(!node.parentElement?.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style'))excerpt+=' '+node.textContent;}
        const text=excerpt.replace(/\s+/g,' ').trim().slice(0,240),geometry={clientWidth:e.clientWidth,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,visible:visible(e)};
        const findings:Array<{category:'text-clipping'|'horizontal-overflow'|'vertical-overflow'|'element-overlap'|'unknown';fact:string;candidate:boolean}>=[];
        if(e.clientWidth>0&&e.scrollWidth>e.clientWidth+1){findings.push({category:'horizontal-overflow',fact:`scrollWidth ${e.scrollWidth} > clientWidth ${e.clientWidth}; overflow-x ${style.overflowX}`,candidate:true});if(text&&['hidden','clip'].includes(style.overflowX))findings.push({category:'text-clipping',fact:`Text extent exceeds the clipping box; white-space ${style.whiteSpace}; text-overflow ${style.textOverflow}. May be intentional.`,candidate:true});}
        if(e.clientHeight>0&&e.scrollHeight>e.clientHeight+1)findings.push({category:'vertical-overflow',fact:`scrollHeight ${e.scrollHeight} > clientHeight ${e.clientHeight}; overflow-y ${style.overflowY}`,candidate:true});
        const neighbors=Array.from(e.parentElement?.children??[]).filter(other=>other!==e&&!other.matches('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style')).slice(0,24).filter(visible).slice(0,5).map(other=>{
          const r=other.getBoundingClientRect(),left=Math.max(b.x,r.x),top=Math.max(b.y,r.y),right=Math.min(b.right,r.right),bottom=Math.min(b.bottom,r.bottom),intersects=right-left>1&&bottom-top>1;
          const hit=intersects?document.elementFromPoint((left+right)/2,(top+bottom)/2):null;
          if(intersects&&hit&&(hit===other||other.contains(hit)))findings.push({category:'element-overlap',fact:`Visible sibling ${other.tagName.toLowerCase()} intersects on both axes and covers the intersection hit point; intent needs confirmation.`,candidate:true});
          return {tag:other.tagName.toLowerCase(),rect:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height},visible:true,intersects};
        });
        if(!findings.length)findings.push({category:'unknown',fact:'No deterministic defect established; styling mismatch requires a baseline or explicit visual confirmation.',candidate:true});
        return {identity,tag:e.tagName.toLowerCase(),name:(e.getAttribute('aria-label')??text).slice(0,240),classes:Array.from(e.classList).filter(c=>c.length<=128).slice(0,6),selector,text,geometry,findings,neighbors,rect:{x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height},confidence:unique?.85:.45,diagnostics:[unique?'Unique at capture; may become stale':'Multiple matches; selector is ambiguous','Source component not confirmed'],styles};
      });
      const first=candidates[0]?.e;const screenshotOnly=Boolean(first&&first.closest('canvas,svg'));
      return {url:location.href,route:location.pathname,viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,scroll:{x:scrollX,y:scrollY},rect:{...rect,x:rect.x+scrollX,y:rect.y+scrollY},anchors:screenshotOnly?[]:anchors,snapshot:`${performance.timeOrigin}:${document.querySelectorAll('*').length}`,diagnostics:screenshotOnly?['Screenshot-only Canvas/SVG region; no source mapping']:['DOM candidates are hints, not verified source mappings']};
    }finally{if(overlay)overlay.style.display='';}
  },rect);
  return {...evidence,route:visualRoute(evidence.url)};
}
