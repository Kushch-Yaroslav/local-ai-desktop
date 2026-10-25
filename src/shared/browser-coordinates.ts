import {resolveBrowserAnchor} from './browser-anchor';
import type {VisualRect, VisualRegion} from './visual-debugging';

/** CSS geometry is independent of display pixels, Electron DIP and screenshot pixels. */
export function cssToPresentation(point:{x:number;y:number},scale:number,pan={x:0,y:0}){
  return {x:(point.x-pan.x)*scale,y:(point.y-pan.y)*scale};
}
export function presentationToCss(point:{x:number;y:number},scale:number,pan={x:0,y:0}){
  return {x:point.x/scale+pan.x,y:point.y/scale+pan.y};
}
export type GroundedBox=Pick<VisualRegion,'url'|'rect'|'viewport'|'dpr'|'anchors'|'snapshot'>;
/** Self-contained: also installed in the scoped page. Never substitute stale document coordinates. */
export function projectVisualRegion(region:GroundedBox,lookup:(selector:string)=>ArrayLike<Element>=selector=>document.querySelectorAll(selector),resolve:typeof resolveBrowserAnchor=resolveBrowserAnchor):{rect?:VisualRect;stale:boolean;reason?:string;selector?:string}{
  if(document.readyState==='loading')return {stale:true,reason:'dom-not-ready'};
  const route=(raw:string)=>{const u=new URL(raw);if(!u.search)u.search='';if(!u.hash)u.hash='';return u.href;};
  if(route(region.url)!==route(location.href))return {stale:true,reason:'route'};
  const first=region.anchors[0];
  const anchor=first?.confidence>=.8?first:region.anchors.find(a=>a.confidence>=.8&&a.tag!=='main'&&a.tag!=='body'&&a.tag!=='html');
  if(anchor){
    try{
      const resolution=resolve(anchor,lookup);if(!resolution.selector)return {stale:true,reason:resolution.reason};
      const nodes=lookup(resolution.selector);if(nodes.length>1)return {stale:true,reason:'ambiguous-anchor'};const element=nodes.length===1?nodes[0]:undefined;
      if(!element||element.tagName.toLowerCase()!==anchor.tag)return {stale:true,reason:'element-missing'};
      if(anchor.identity){
        const text=(root:Element)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let result='',node:Node|null,count=0;while((node=walker.nextNode())&&count++<200&&result.length<240)if(!node.parentElement?.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style'))result+=' '+node.textContent;return result.replace(/\s+/g,' ').trim().slice(0,240);};
        if(text(element)!==anchor.identity.text||anchor.identity.context&&text(element.parentElement??element)!==anchor.identity.context)return {stale:true,reason:'anchor-identity-changed'};
      }
      const b=element.getBoundingClientRect(),style=getComputedStyle(element);
      if(!b.width||!b.height||style.visibility!=='visible'||style.display==='none'||Number(style.opacity)===0)return {stale:true,reason:'anchor-hidden'};
      for(let e:Element|null=element;e;e=e.parentElement){const ancestor=getComputedStyle(e);if(ancestor.display==='none'||ancestor.visibility!=='visible'||Number(ancestor.opacity)===0)return {stale:true,reason:'anchor-hidden'};const transform=ancestor.transform;if(transform!=='none'){const m=new DOMMatrixReadOnly(transform);if(Math.abs(m.b)>.001||Math.abs(m.c)>.001||m.a<=0||m.d<=0||!m.is2D)return {stale:true,reason:'rotated-or-3d-anchor-needs-reselection'};}}
      if(!anchor.rect.width||!anchor.rect.height)return {stale:true,reason:'invalid-original-anchor'};
      // Ratios retain a partial selection rather than replacing it with the full element.
      return {stale:false,selector:resolution.selector,rect:{x:b.x+(region.rect.x-anchor.rect.x)*b.width/anchor.rect.width,y:b.y+(region.rect.y-anchor.rect.y)*b.height/anchor.rect.height,width:region.rect.width*b.width/anchor.rect.width,height:region.rect.height*b.height/anchor.rect.height}};
    }catch{return {stale:true,reason:'invalid-selector'};}
  }
  if(region.anchors.length)return {stale:true,reason:'ambiguous-anchor'};
  if(region.snapshot&&!region.snapshot.startsWith(`${performance.timeOrigin}:`))return {stale:true,reason:'screenshot-only-document-changed'};
  if(region.viewport.width!==innerWidth||region.viewport.height!==innerHeight||Math.abs(region.dpr-devicePixelRatio)>.01)return {stale:true,reason:'screenshot-only-viewport-changed'};
  return {stale:false,rect:{...region.rect,x:region.rect.x-scrollX,y:region.rect.y-scrollY},reason:'screenshot-only-original-viewport'};
}

/** CDP clip uses pre-zoom DIP; output is normalized to CSS pixels. */
export function cssScreenshotClip(rect:VisualRect,zoom:number,dpr:number){
  return {x:rect.x*zoom,y:rect.y*zoom,width:rect.width*zoom,height:rect.height*zoom,scale:1/dpr};
}

/** Embed both self-contained functions in the same Page world. */
export function browserProjectionSource(){return `((resolve)=>(region,lookup)=>(${projectVisualRegion.toString()})(region,lookup,resolve))(${resolveBrowserAnchor.toString()})`;}
