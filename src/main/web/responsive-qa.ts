import type { Page } from 'playwright-core';
import type { QaScenario, QaViewport, ResponsiveInspection, ResponsiveFinding } from '../../shared/browser-qa';

export const viewportProfiles = { 'small-mobile': { width:320,height:640 }, mobile:{width:390,height:844}, 'large-mobile':{width:430,height:932}, tablet:{width:768,height:1024}, desktop:{width:1440,height:900} } as const;
export const viewportSchema = {oneOf:[{type:'string',enum:Object.keys(viewportProfiles)},{type:'object',properties:{width:{type:'integer',minimum:280,maximum:1920},height:{type:'integer',minimum:320,maximum:1600}},required:['width','height'],additionalProperties:false}]};
export function qaViewport(input:unknown):QaViewport {
  if(typeof input==='string'&&Object.prototype.hasOwnProperty.call(viewportProfiles,input))return {...viewportProfiles[input as keyof typeof viewportProfiles],profile:input};
  if(input&&typeof input==='object'){
    const v=input as QaViewport;
    if(Number.isInteger(v.width)&&v.width>=280&&v.width<=1920&&Number.isInteger(v.height)&&v.height>=320&&v.height<=1600)return {width:v.width,height:v.height};
  }
  throw new Error('Viewport must be a named profile or width 280..1920 / height 320..1600');
}
export interface ResponsiveOptions { reason:string; vision:'auto'|'on'|'off'; viewports:QaViewport[]; breakpoint?:{minWidth:number;maxWidth:number;attempts:number}; }
export function responsiveOptions(input:unknown):ResponsiveOptions|undefined {
  if(input===undefined)return undefined;
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Responsive options must be an object');
  const raw=input as Record<string,unknown>;
  if(typeof raw.reason!=='string'||!raw.reason.trim()||raw.reason.length>500)throw new Error('Explain why responsive QA is relevant at this checkpoint (reason, max 500 characters)');
  const vision=raw.vision??'auto';if(!['auto','on','off'].includes(String(vision)))throw new Error('Invalid responsive Vision mode');
  const values=raw.viewports??['mobile','desktop'];
  if(!Array.isArray(values)||!values.length||values.length>5)throw new Error('Use 1..5 viewports per responsive checkpoint');
  const viewports=values.map(qaViewport);
  if(new Set(viewports.map(v=>`${v.width}x${v.height}`)).size!==viewports.length)throw new Error('Duplicate viewports are unnecessary');
  let breakpoint:ResponsiveOptions['breakpoint'];
  if(raw.breakpoint!==undefined){
    const b=raw.breakpoint as Record<string,number>,attempts=b?.attempts??4;
    if(!b||!Number.isInteger(b.minWidth)||!Number.isInteger(b.maxWidth)||b.minWidth<280||b.maxWidth>1920||b.minWidth>=b.maxWidth||!Number.isInteger(attempts)||attempts<2||attempts>5)throw new Error('Breakpoint search requires 280 <= minWidth < maxWidth <= 1920 and 2..5 total attempts');
    breakpoint={minWidth:b.minWidth,maxWidth:b.maxWidth,attempts};
  }
  return {reason:raw.reason,vision:vision as ResponsiveOptions['vision'],viewports,breakpoint};
}
export function layoutScenario(id:string,target:string,viewport:QaViewport):QaScenario {
  return {id,goal:`Layout bounds at ${viewport.width} × ${viewport.height} (DOM geometry only)`,target,viewport,preconditions:[],required_state:[],steps:[],assertion:{source:'layout',operator:'equals',expected:0},timeout_ms:7000};
}
export function nextBreakpoint(history:Array<{width:number;failed:boolean}>,attempts:number):number|undefined {
  if(history.length>=attempts)return;
  const sorted=[...history].sort((a,b)=>a.width-b.width);
  for(let i=1;i<sorted.length;i++)if(sorted[i-1].failed!==sorted[i].failed&&sorted[i].width-sorted[i-1].width>16)return Math.floor((sorted[i-1].width+sorted[i].width)/2);
}

/** Geometry is deterministic; ambiguous clipping/occlusion remains a candidate, never a fabricated defect. */
export async function inspectResponsive(page:Page):Promise<ResponsiveInspection> {
  return page.evaluate(()=>{
    const findings:ResponsiveFinding[]=[];
    const elements=Array.from(document.body?.querySelectorAll('*')??[]).slice(0,2000);
    const modal=document.querySelector('dialog[open],[aria-modal="true"]');
    const visible=(e:Element)=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return (!modal||e===modal||modal.contains(e))&&s.display!=='none'&&s.visibility==='visible'&&Number(s.opacity)>0&&r.width>0&&r.height>0&&!e.closest('[hidden],[inert],[aria-hidden="true"]');};
    const describe=(e:Element)=>e.id?`#${e.id.slice(0,80)}`:e.tagName.toLowerCase()+Array.from(e.classList).slice(0,2).map(x=>'.'+x.slice(0,40)).join('');
    const clipped=(e:Element)=>{for(let a=e.parentElement;a&&a!==document.body&&a!==document.documentElement;a=a.parentElement){if(['auto','scroll','hidden','clip'].includes(getComputedStyle(a).overflowX))return true;}return false;};
    const add=(kind:ResponsiveFinding['kind'],confidence:ResponsiveFinding['confidence'],e:Element,detail:string)=>{if(findings.length>=40)return;const r=e.getBoundingClientRect();findings.push({kind,confidence,selector:describe(e),detail,rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}});};
    const interactive='button,input:not([type=hidden]),select,textarea,a[href],[role=button],[role=dialog],dialog,nav,form';
    const width=innerWidth,height=innerHeight,documentWidth=Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth??0);
    const rootClips=[document.documentElement,document.body].some(e=>e&&['hidden','clip','scroll'].includes(getComputedStyle(e).overflowX));
    let intentionalScrollContainers=0;
    for(const e of elements){
      if(!visible(e))continue;
      const s=getComputedStyle(e),r=e.getBoundingClientRect();
      if(['auto','scroll'].includes(s.overflowX)&&e.scrollWidth>e.clientWidth+2)intentionalScrollContainers++;
      const outside=r.left< -2||r.right>width+2;
      // Offscreen lower content is allowed: only horizontal accessibility and open dialogs are checked.
      if(outside&&e.matches(interactive)&&r.bottom>0&&r.top<height&&!clipped(e))add('viewport-fit','confirmed',e,'Visible interactive region exceeds horizontal viewport bounds without a containing horizontal scroller.');
      if(documentWidth>width+2&&outside&&!clipped(e)&&e.matches('main,section,article,header,footer,img,canvas,form,nav'))add('horizontal-overflow',rootClips?'candidate':'confirmed',e,`Document width ${documentWidth}px exceeds viewport ${width}px; this rendered content escapes its bounds. Root clipping/scroll intent: ${rootClips}.`);
      if(e.matches('dialog[open],[aria-modal=true]')&&(r.top< -2||r.bottom>height+2)&&!['auto','scroll'].includes(s.overflowY))add('viewport-fit','candidate',e,'Open dialog exceeds viewport height; check whether its content and close control are reachable.');
      if(e.matches('img')&&e.parentElement&&!clipped(e)&&r.width>e.parentElement.getBoundingClientRect().width+2)add('image-fit','candidate',e,'Image exceeds parent width; confirm intended rendering.');
      if(e.childElementCount===0&&e.textContent?.trim()&&e.clientWidth>0&&e.scrollWidth>e.clientWidth+3&&['hidden','clip'].includes(s.overflowX)&&s.textOverflow!=='ellipsis')add('text-clipping','candidate',e,'Text is clipped without ellipsis; this can be intentional.');
    }
    if(documentWidth>width+2&&!findings.some(f=>f.kind==='horizontal-overflow'))findings.push({kind:'horizontal-overflow',confidence:'candidate',selector:'html',detail:`Document width ${documentWidth}px exceeds ${width}px, but geometry did not establish an unintended cause.`});
    for(const e of elements.filter(e=>e.matches(interactive)&&visible(e)).slice(0,60)){
      const r=e.getBoundingClientRect();if(r.left<0||r.right>width||r.top<0||r.bottom>height||clipped(e))continue;
      const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      if(hit&&hit!==e&&!e.contains(hit)&&!hit.contains(e))add('overlap','candidate',e,`Center is covered by ${describe(hit)}; geometry alone cannot establish whether this is a defect.`);
    }
    return {viewport:{width,height},url:location.href,documentWidth,findings,intentionalScrollContainers,hasCanvas:elements.some(e=>e.tagName==='CANVAS'&&visible(e)),truncated:(document.body?.querySelectorAll('*').length??0)>2000||findings.length>=40};
  });
}
