import { newId } from './util';
import type { Page } from 'playwright-core';
import type { LadAnchor, LadRect, LadRegion, LadSurroundings } from '../shared/types';

/**
 * DOM grounding, ported from the original Local AI Desktop:
 * src/main/web/visual-selection.ts (groundRegion) and
 * src/shared/browser-coordinates.ts + src/shared/browser-anchor.ts
 * (projectVisualRegion, resolveBrowserAnchor).
 *
 * The in-page functions are deliberately self-contained (no closures over
 * runtime state) because they are serialized with `fn.toString()` and executed
 * inside the target page. They never read private inputs, never dump full DOM
 * trees, and keep every string bounded.
 *
 * The original diagnostics are preserved verbatim:
 * - "Screenshot-only Canvas/SVG region; no source mapping"
 * - "DOM candidates are hints, not verified source mappings"
 */

// ---------------------------------------------------------------------------
// In-page: bounded DOM grounding for a selected viewport rect
// ---------------------------------------------------------------------------

const GROUND_REGION_SOURCE = /* js */ `
(rect) => {
  const overlap=(b)=>Math.max(0,Math.min(b.right,rect.x+rect.width)-Math.max(b.x,rect.x))*Math.max(0,Math.min(b.bottom,rect.y+rect.height)-Math.max(b.y,rect.y));
  const visible=(e)=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);for(let parent=e.parentElement,depth=0;parent&&depth++<12;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return false;}return b.width>0&&b.height>0&&b.right>0&&b.bottom>0&&b.x<innerWidth&&b.y<innerHeight&&s.display!=='none'&&s.visibility==='visible'&&Number(s.opacity)>0&&!e.closest('[hidden],[aria-hidden=true],[inert]');};
  const candidates=Array.from(document.querySelectorAll('body *')).slice(0,8000).filter(e=>!e.closest('[id^=__lad-],input,textarea,select,[contenteditable],[data-private],[data-sensitive]') && !['SCRIPT','STYLE','NOSCRIPT'].includes(e.tagName)).map(e=>({e,b:e.getBoundingClientRect()})).filter(({e,b})=>b.width>0&&b.height>0&&overlap(b)>0&&visible(e)).sort((a,b)=>Math.abs(a.b.width*a.b.height-rect.width*rect.height)-Math.abs(b.b.width*b.b.height-rect.width*rect.height)).slice(0,4);
  const safeText=(root)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let text='',node,count=0;while((node=walker.nextNode())&&count++<200&&text.length<240)if(!node.parentElement?.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style'))text+=' '+node.textContent;return text.replace(/\\s+/g,' ').trim().slice(0,240);};
  const anchors=candidates.filter(({e})=>!['CANVAS','SVG'].includes(e.tagName.toUpperCase()) && !e.closest('canvas,svg')).map(({e,b})=>{
    let selector=e.id&&e.id.length<=128?'#'+CSS.escape(e.id):e.tagName.toLowerCase()+Array.from(e.classList).filter(c=>c.length<=128).slice(0,3).map(c=>'.'+CSS.escape(c)).join('');
    let unique=false;try{unique=document.querySelectorAll(selector).length===1;}catch{selector=e.tagName.toLowerCase();}
    let identity=unique&&/\\._[a-zA-Z][\\w-]*?_[a-z0-9]+_\\d+/.test(selector)?{text:safeText(e),context:safeText(e.parentElement??e)}:undefined;
    if(!unique){
      const parts=[];for(let node=e,depth=0;node&&depth++<10;node=node.parentElement){
        const stable=node.id&&node.id.length<=128?'#'+CSS.escape(node.id):undefined;
        if(stable){parts.unshift(stable);break;}
        const peers=Array.from(node.parentElement?.children??[]).filter(p=>p.tagName===node.tagName);parts.unshift(node.tagName.toLowerCase()+(peers.length>1?':nth-of-type('+(peers.indexOf(node)+1)+')':''));
        const path=parts.join(' > ');if(document.querySelectorAll(path).length===1)break;
      }
      const path=parts.join(' > ');if(path&&document.querySelectorAll(path).length===1){selector=path;unique=true;identity={text:safeText(e),context:safeText(e.parentElement??e)};}
    }
    const style=getComputedStyle(e);const styles={};for(const key of ['display','position','overflow','overflow-x','overflow-y','visibility','opacity','white-space','width','height','font-family','font-size','line-height','padding','box-sizing','color','background-color','filter','max-width','font-weight','text-overflow','flex-wrap','align-items','border-radius','border-top-left-radius','border-top-right-radius','border-bottom-left-radius','border-bottom-right-radius']){const value=style.getPropertyValue(key);styles[key]=/url\\s*\\(/i.test(value)?'[URL omitted]':value.slice(0,120);}
    const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let excerpt='',count=0,node;
    while((node=walker.nextNode())&&count++<200&&excerpt.length<240){if(!node.parentElement?.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style'))excerpt+=' '+node.textContent;}
    const text=excerpt.replace(/\\s+/g,' ').trim().slice(0,240),geometry={clientWidth:e.clientWidth,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,visible:visible(e)};
    const findings=[];
    if(e.clientWidth>0&&e.scrollWidth>e.clientWidth+1){findings.push({category:'horizontal-overflow',fact:'scrollWidth '+e.scrollWidth+' > clientWidth '+e.clientWidth+'; overflow-x '+style.overflowX,candidate:true});if(text&&['hidden','clip'].includes(style.overflowX))findings.push({category:'text-clipping',fact:'Text extent exceeds the clipping box; white-space '+style.whiteSpace+'; text-overflow '+style.textOverflow+'. May be intentional.',candidate:true});}
    if(e.clientHeight>0&&e.scrollHeight>e.clientHeight+1)findings.push({category:'vertical-overflow',fact:'scrollHeight '+e.scrollHeight+' > clientHeight '+e.clientHeight+'; overflow-y '+style.overflowY,candidate:true});
    const neighbors=Array.from(e.parentElement?.children??[]).filter(other=>other!==e&&!other.matches('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style')).slice(0,24).filter(visible).slice(0,5).map(other=>{
      const r=other.getBoundingClientRect(),left=Math.max(b.x,r.x),top=Math.max(b.y,r.y),right=Math.min(b.right,r.right),bottom=Math.min(b.bottom,r.bottom),intersects=right-left>1&&bottom-top>1;
      const hit=intersects?document.elementFromPoint((left+right)/2,(top+bottom)/2):null;
      if(intersects&&hit&&(hit===other||other.contains(hit)))findings.push({category:'element-overlap',fact:'Visible sibling '+other.tagName.toLowerCase()+' intersects on both axes and covers the intersection hit point; intent needs confirmation.',candidate:true});
      return {tag:other.tagName.toLowerCase(),rect:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height},visible:true,intersects};
    });
    if(!findings.length)findings.push({category:'unknown',fact:'No deterministic defect established; styling mismatch requires a baseline or explicit visual confirmation.',candidate:true});
    return {identity,tag:e.tagName.toLowerCase(),name:(e.getAttribute('aria-label')??text).slice(0,240),classes:Array.from(e.classList).filter(c=>c.length<=128).slice(0,6),selector,text,geometry,findings,neighbors,rect:{x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height},confidence:unique?0.85:0.45,diagnostics:[unique?'Unique at capture; may become stale':'Multiple matches; selector is ambiguous','Source component not confirmed'],styles};
  });
  const center=rect.y+rect.height/2;
  const sections=Array.from(document.querySelectorAll('section,article,[role="region"]')).slice(0,600)
    .filter(e=>!e.closest('[data-private],[data-sensitive],input,textarea,select,[contenteditable]')&&visible(e))
    .map(e=>({e,b:e.getBoundingClientRect()})).filter(({b})=>Math.min(b.right,rect.x+rect.width)>Math.max(b.left,rect.x));
  const above=sections.filter(({b})=>b.bottom<=center).sort((a,b)=>b.b.bottom-a.b.bottom)[0];
  const below=sections.filter(({b})=>b.top>=center).sort((a,b)=>a.b.top-b.b.top)[0];
  const anchorFn=(item)=>{if(!item)return undefined;const {e,b}=item;
    const selector=e.id?'#'+CSS.escape(e.id):undefined;
    return {tag:e.tagName.toLowerCase(),selector:selector&&document.querySelectorAll(selector).length===1?selector:undefined,text:safeText(e),rect:{x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height}};};
  const competing=(item,edge)=>item&&sections.some(other=>other!==item&&!other.e.contains(item.e)&&!item.e.contains(other.e)&&Math.abs(other.b[edge]-item.b[edge])<2);
  const between=Boolean(above&&below&&!competing(above,'bottom')&&!competing(below,'top')&&Math.min(above.b.right,below.b.right)>Math.max(above.b.left,below.b.left)&&above.e.parentElement===below.e.parentElement&&above.b.bottom<=below.b.top&&above.e.nextElementSibling===below.e);
  const parent=between?above.e.parentElement:undefined;
  const surroundings={relation:between?'between-siblings':'ambiguous',above:anchorFn(above),below:anchorFn(below),
    container:parent&&parent.id?'#'+CSS.escape(parent.id):undefined,confidence:between?0.7:0.2,coordinateSpace:'document-css',
    diagnostics:['Geometry at capture only; confirm current DOM and source order. No React component mapping.',...(between?[]:['No unambiguous adjacent semantic pair; inspect further or ask for clarification.'])]};
  const first=candidates[0]?.e;const screenshotOnly=Boolean(first&&first.closest('canvas,svg'));
  return {url:location.href,route:location.pathname,viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,scroll:{x:scrollX,y:scrollY},rect:Object.assign({},rect,{x:rect.x+scrollX,y:rect.y+scrollY}),anchors:screenshotOnly?[]:anchors,surroundings,snapshot:performance.timeOrigin+':'+document.querySelectorAll('*').length,diagnostics:screenshotOnly?['Screenshot-only Canvas/SVG region; no source mapping']:['DOM candidates are hints, not verified source mappings']};
}`;

export interface LadGroundEvidence {
  url: string;
  route: string;
  viewport: { width: number; height: number };
  dpr: number;
  scroll: { x: number; y: number };
  rect: LadRect;
  anchors: LadAnchor[];
  surroundings: LadSurroundings;
  snapshot: string;
  diagnostics: string[];
}

/**
 * Ground a viewport-relative CSS rect into a region evidence bundle.
 * Port of the original groundRegion(): bounded scan, safe text, unique or
 * structural selectors, computed styles, findings, neighbors, surroundings.
 */
export async function groundRegion(page: Page, rect: LadRect): Promise<LadGroundEvidence> {
  const evidence = await page.evaluate(
    new Function('rect', `return (${GROUND_REGION_SOURCE})(rect);`) as unknown as (
      rect: LadRect
    ) => Promise<LadGroundEvidence>,
    rect
  );
  return { ...evidence, snapshot: `${evidence.snapshot}:${newId('snapshot')}` };
}

// ---------------------------------------------------------------------------
// In-page: bounded anchor re-resolution (CSS Modules rebinding included)
// ---------------------------------------------------------------------------

const RESOLVE_ANCHOR_SOURCE = /* js */ `
(anchor, lookup) => {
  try{
    const text=(root)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let result='',node,count=0;while((node=walker.nextNode())&&count++<200&&result.length<240)if(!node.parentElement?.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style'))result+=' '+node.textContent;return result.replace(/\\s+/g,' ').trim().slice(0,240);};
    const identity=anchor.identity??(anchor.text?{text:anchor.text,context:''}:undefined);
    const exact=lookup(anchor.selector);
    if(exact.length>1)return {reason:'ambiguous-anchor'};
    if(exact.length===1){const e=exact[0];return e.tagName.toLowerCase()===anchor.tag&&(!identity||text(e)===identity.text&&(!identity.context||text(e.parentElement??e)===identity.context))?{selector:anchor.selector}:{reason:'anchor-identity-changed'};}
    const classes=Array.from(anchor.selector.matchAll(/\\.(_[a-zA-Z][\\w-]*?_[a-z0-9]+_\\d+)(?=$|[\\s.:#]|\\[)/g),m=>m[1]);
    if(!classes.length||!identity||!anchor.tag.match(/^[a-z][a-z0-9-]*$/))return {reason:'element-missing'};
    const stem=(s)=>s.replace(/_[a-z0-9]+_\\d+$/,'_');
    const candidates=lookup(anchor.tag+'[class]');if(candidates.length>200)return {reason:'anchor-search-limit'};
    const matches=Array.from(candidates).filter(e=>classes.some(c=>Array.from(e.classList).some(v=>/^_[a-zA-Z][\\w-]*?_[a-z0-9]+_\\d+$/.test(v)&&stem(v)===stem(c)))&&text(e)===identity.text&&(!identity.context||text(e.parentElement??e)===identity.context));
    if(matches.length!==1)return {reason:matches.length?'ambiguous-anchor':'element-missing'};
    const e=matches[0],name=Array.from(e.classList).find(v=>classes.some(c=>stem(v)===stem(c))),selector=anchor.tag+'.'+CSS.escape(name);
    return lookup(selector).length===1?{selector,rebound:true}:{reason:'ambiguous-anchor'};
  }catch{return {reason:'invalid-selector'};}
}`;

// ---------------------------------------------------------------------------
// In-page: live re-projection of a region (stale detection + ratio mapping)
// ---------------------------------------------------------------------------

const PROJECT_REGION_SOURCE = /* js */ `
(region, resolve) => {
  if(document.readyState==='loading')return {stale:true,reason:'dom-not-ready'};
  const routeOf=(raw)=>{try{const u=new URL(raw);if(!u.search)u.search='';if(!u.hash)u.hash='';return u.href;}catch{return raw;}};
  if(routeOf(region.url)!==routeOf(location.href))return {stale:true,reason:'route'};
  const first=region.anchors[0];
  const anchor=first&&first.confidence>=0.8?first:region.anchors.find(a=>a.confidence>=0.8&&a.tag!=='main'&&a.tag!=='body'&&a.tag!=='html');
  if(anchor){
    try{
      const resolution=resolve(anchor,s=>document.querySelectorAll(s));if(!resolution.selector)return {stale:true,reason:resolution.reason};
      const nodes=document.querySelectorAll(resolution.selector);if(nodes.length>1)return {stale:true,reason:'ambiguous-anchor'};const element=nodes.length===1?nodes[0]:undefined;
      if(!element||element.tagName.toLowerCase()!==anchor.tag)return {stale:true,reason:'element-missing'};
      if(anchor.identity){
        const text=(root)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let result='',node,count=0;while((node=walker.nextNode())&&count++<200&&result.length<240)if(!node.parentElement?.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style'))result+=' '+node.textContent;return result.replace(/\\s+/g,' ').trim().slice(0,240);};
        if(text(element)!==anchor.identity.text||(anchor.identity.context&&text(element.parentElement??element)!==anchor.identity.context))return {stale:true,reason:'anchor-identity-changed'};
      }
      const b=element.getBoundingClientRect(),style=getComputedStyle(element);
      if(!b.width||!b.height||style.visibility!=='visible'||style.display==='none'||Number(style.opacity)===0)return {stale:true,reason:'anchor-hidden'};
      for(let e=element;e;e=e.parentElement){const ancestor=getComputedStyle(e);if(ancestor.display==='none'||ancestor.visibility!=='visible'||Number(ancestor.opacity)===0)return {stale:true,reason:'anchor-hidden'};const transform=ancestor.transform;if(transform!=='none'){const m=new DOMMatrixReadOnly(transform);if(Math.abs(m.b)>0.001||Math.abs(m.c)>0.001||m.a<=0||m.d<=0||!m.is2D)return {stale:true,reason:'rotated-or-3d-anchor-needs-reselection'};}}
      if(!anchor.rect.width||!anchor.rect.height)return {stale:true,reason:'invalid-original-anchor'};
      return {stale:false,selector:resolution.selector,rect:{x:b.x+(region.rect.x-anchor.rect.x)*b.width/anchor.rect.width,y:b.y+(region.rect.y-anchor.rect.y)*b.height/anchor.rect.height,width:region.rect.width*b.width/anchor.rect.width,height:region.rect.height*b.height/anchor.rect.height}};
    }catch{return {stale:true,reason:'invalid-selector'};}
  }
  if(region.anchors.length)return {stale:true,reason:'ambiguous-anchor'};
  if(region.snapshot&&!region.snapshot.startsWith(performance.timeOrigin+':'))return {stale:true,reason:'screenshot-only-document-changed'};
  if(region.viewport.width!==innerWidth||region.viewport.height!==innerHeight||Math.abs(region.dpr-devicePixelRatio)>0.01)return {stale:true,reason:'screenshot-only-viewport-changed'};
  return {stale:false,rect:Object.assign({},region.rect,{x:region.rect.x-scrollX,y:region.rect.y-scrollY}),reason:'screenshot-only-original-viewport'};
}`;

export interface LadProjection {
  stale: boolean;
  reason?: string;
  selector?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

/**
 * Re-project a region onto the current page state.
 * Port of projectVisualRegion + resolveBrowserAnchor. Returns a fresh
 * viewport-relative rect when the binding is still valid, otherwise a
 * stable stale reason. Screenshot-only (Canvas/SVG) regions keep the
 * original geometry only while viewport/DPR are unchanged.
 */
export async function projectRegion(page: Page, region: LadRegion): Promise<LadProjection> {
  // The function body is plain JS (both helpers embedded) and is executed
  // inside the page world, exactly like the original browserProjectionSource.
  const project = new Function(
    'region',
    `return (${PROJECT_REGION_SOURCE})(region, (${RESOLVE_ANCHOR_SOURCE}));`
  ) as unknown as (region: LadRegion) => Promise<LadProjection>;
  return page.evaluate(project, region);
}

/**
 * Render region annotations (boxes + binding badges) into the live page,
 * port of the original visualRegionsOverlay. Pointer-transparent; rAF-driven
 * redraw keeps boxes glued to live anchors. Returns the current bindings.
 */
export async function paintRegions(
  page: Page,
  regions: Array<{ id: string; color: string; label: string; region: LadRegion }>,
  enabled: boolean
): Promise<void> {
  const source = /* js */ `
(data) => {
  const state=window;
  if(state.__ladPaint){state.__ladPaint.stop();delete state.__ladPaint;}
  if(!data.enabled) return;
  const host=document.createElement('div');host.id='__lad-live-regions';
  host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow=host.attachShadow({mode:'closed'});const layer=document.createElement('div');shadow.append(layer);
  const box=(rect,label,color)=>{const node=document.createElement('div');node.style.cssText='position:absolute;pointer-events:none;box-sizing:border-box;border:3px solid '+color+';box-shadow:0 0 0 1px #fff,0 0 0 2px #111;background:'+color+'22;left:'+rect.x+'px;top:'+rect.y+'px;width:'+rect.width+'px;height:'+rect.height+'px;';const badge=document.createElement('span');badge.style.cssText='background:#111;color:#fff;border:2px solid '+color+';padding:2px 4px;font:bold 12px sans-serif;white-space:nowrap;';badge.textContent=label;node.append(badge);layer.append(node);};
  const project=(r)=>{
    try{
      if(document.readyState==='loading')return null;
      const routeOf=(raw)=>{try{const u=new URL(raw);if(!u.search)u.search='';if(!u.hash)u.hash='';return u.href;}catch{return raw;}};
      if(routeOf(r.url)!==routeOf(location.href))return null;
      const first=r.anchors[0];
      const anchor=first&&first.confidence>=0.8?first:r.anchors.find(a=>a.confidence>=0.8&&a.tag!=='main'&&a.tag!=='body'&&a.tag!=='html');
      if(anchor){
        const resolve=(a)=>{try{const text=(root)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let result='',node,count=0;while((node=walker.nextNode())&&count++<200&&result.length<240)if(!node.parentElement?.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style'))result+=' '+node.textContent;return result.replace(/\\s+/g,' ').trim().slice(0,240);};const identity=a.identity??(a.text?{text:a.text,context:''}:undefined);const exact=document.querySelectorAll(a.selector);if(exact.length>1)return null;if(exact.length===1){const e=exact[0];return e.tagName.toLowerCase()===a.tag&&(!identity||text(e)===identity.text&&(!identity.context||text(e.parentElement??e)===identity.context))?a.selector:null;}const classes=Array.from(a.selector.matchAll(/\\.(_[a-zA-Z][\\w-]*?_[a-z0-9]+_\\d+)(?=$|[\\s.:#]|\\[)/g),m=>m[1]);if(!classes.length||!identity||!a.tag.match(/^[a-z][a-z0-9-]*$/))return null;const stem=(s)=>s.replace(/_[a-z0-9]+_\\d+$/,'_');const candidates=document.querySelectorAll(a.tag+'[class]');if(candidates.length>200)return null;const matches=Array.from(candidates).filter(e=>classes.some(c=>Array.from(e.classList).some(v=>/^_[a-zA-Z][\\w-]*?_[a-z0-9]+_\\d+$/.test(v)&&stem(v)===stem(c)))&&text(e)===identity.text&&(!identity.context||text(e.parentElement??e)===identity.context));if(matches.length!==1)return null;const e=matches[0],name=Array.from(e.classList).find(v=>classes.some(c=>stem(v)===stem(c)));const selector=a.tag+'.'+CSS.escape(name);return document.querySelectorAll(selector).length===1?selector:null;}catch{return null;}};
        const sel=resolve(anchor);
        if(!sel)return null;
        const nodes=document.querySelectorAll(sel);
        if(nodes.length!==1)return null;
        const element=nodes[0],b=element.getBoundingClientRect(),style=getComputedStyle(element);
        if(!b.width||!b.height||style.visibility!=='visible'||style.display==='none'||Number(style.opacity)===0)return null;
        if(!anchor.rect.width||!anchor.rect.height)return null;
        return {rect:{x:b.x+(r.rect.x-anchor.rect.x)*b.width/anchor.rect.width,y:b.y+(r.rect.y-anchor.rect.y)*b.height/anchor.rect.height,width:r.rect.width*b.width/anchor.rect.width,height:r.rect.height*b.height/anchor.rect.height}};
      }
      if(r.anchors.length)return null;
      if(r.viewport.width!==innerWidth||r.viewport.height!==innerHeight||Math.abs(r.dpr-devicePixelRatio)>0.01)return null;
      if(r.snapshot&&!r.snapshot.startsWith(performance.timeOrigin+':'))return null;
      return {rect:Object.assign({},r.rect,{x:r.rect.x-scrollX,y:r.rect.y-scrollY})};
    }catch{return null;}
  };
  let frame=0;
  const draw=()=>{layer.replaceChildren();for(const item of data.regions){const p=project(item);if(p)box(p.rect,item.label,item.color);}frame=requestAnimationFrame(draw);};
  const stop=()=>{cancelAnimationFrame(frame);host.remove();};
  state.__ladPaint={stop,draw};
  draw();
  addEventListener('scroll',draw,true);addEventListener('resize',draw);
  return {stop};
}`;
  await page.evaluate(
    new Function('data', `return (${source})(data);`) as unknown as (
      data: unknown
    ) => Promise<unknown>,
    { enabled, regions }
  );
}
