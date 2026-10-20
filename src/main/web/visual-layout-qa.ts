import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { Page } from 'playwright-core';
import type { BrowserCapture, QaScenario, VisualLayoutFinding, VisualLayoutFrame, VisualLayoutInspection } from '../../shared/browser-qa';
import { qaHash } from './qa-loop-guard';
import { qaViewport, viewportSchema } from './responsive-qa';

export const visualLayoutSchema={type:'object',properties:{dpr:{type:'integer',enum:[1,2]},resize:{type:'array',maxItems:2,items:viewportSchema},baseline:{type:'object',properties:{report_id:{type:'string'},scenario_id:{type:'string',maxLength:80}},required:['report_id','scenario_id'],additionalProperties:false},state_key:{type:'string',maxLength:200},vision:{type:'string',enum:['auto','on','off']}},additionalProperties:false};
export function visualLayoutOptions(raw:unknown):QaScenario['visual_layout'] {
  if(raw===undefined)return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('visual_layout must be an object');
  const v=raw as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['dpr','resize','baseline','state_key','vision'].includes(k)))throw new Error('Unknown visual_layout option');
  if(v.dpr!==undefined&&v.dpr!==1&&v.dpr!==2)throw new Error('Visual DPR must be 1 or 2');
  if(v.vision!==undefined&&!['auto','on','off'].includes(String(v.vision)))throw new Error('Invalid visual Vision mode');
  if(v.state_key!==undefined&&(typeof v.state_key!=='string'||v.state_key.length>200))throw new Error('Invalid UI state key');
  if(v.resize!==undefined&&(!Array.isArray(v.resize)||v.resize.length>2))throw new Error('At most two resize transitions per checkpoint');
  const b=v.baseline as Record<string,unknown>|undefined;
  if(v.baseline!==undefined&&(!b||typeof b!=='object'||Array.isArray(b)))throw new Error('Invalid visual baseline reference');
  if(b&&(!/^[a-f0-9-]{36}$/.test(String(b.report_id))||typeof b.scenario_id!=='string'||!b.scenario_id||b.scenario_id.length>80))throw new Error('Baseline requires a saved report UUID and scenario ID');
  return {dpr:v.dpr as 1|2|undefined,vision:v.vision as 'auto'|'on'|'off'|undefined,state_key:v.state_key as string|undefined,resize:(v.resize as unknown[]|undefined)?.map(qaViewport),...(b?{baseline:{report_id:String(b.report_id),scenario_id:String(b.scenario_id)}}:{})};
}
/** Decode only bounded Chromium PNG RGB/RGBA8 captures, with all five PNG filters. No dependency/native GPU work. */
export function decodeCapture(png:Buffer){
  if(png.length>2*1024*1024||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Invalid bounded PNG');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20),channels=png[25]===6?4:png[25]===2?3:0;
  if(!width||!height||width*height>1280*900||png[24]!==8||!channels||png[28]!==0)throw new Error('Unsupported capture encoding or dimensions');
  const chunks:Buffer[]=[];
  for(let p=8;p+12<=png.length;){const n=png.readUInt32BE(p);if(p+n+12>png.length)throw new Error('Truncated PNG');if(png.toString('ascii',p+4,p+8)==='IDAT')chunks.push(png.subarray(p+8,p+8+n));p+=n+12;}
  const stride=width*channels,raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:(stride+1)*height});
  if(raw.length!==(stride+1)*height)throw new Error('Invalid PNG rows');
  const pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++){const filter=raw[y*(stride+1)];if(filter>4)throw new Error('Invalid PNG filter');for(let x=0;x<stride;x++){
    const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0;
    const paeth=()=>{const p=a+b-c,aa=Math.abs(p-a),bb=Math.abs(p-b),cc=Math.abs(p-c);return aa<=bb&&aa<=cc?a:bb<=cc?b:c;};
    pixels[y*stride+x]=(raw[y*(stride+1)+1+x]+(filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth():0))&255;
  }}return {width,height,channels,pixels};
}
function pixelDiagnostics(image:ReturnType<typeof decodeCapture>,viewport:{width:number;height:number},bounds:VisualLayoutFrame['bounds']) {
  const {width,height,channels,pixels}=image,findings:VisualLayoutFinding[]=[],signature:number[]=[];
  // Stable coarse background distribution; no per-pixel regression verdict for animations.
  for(let gy=0;gy<8;gy++)for(let gx=0;gx<8;gx++)for(let c=0;c<3;c++){let sum=0,count=0;for(let y=Math.floor(gy*height/8);y<Math.floor((gy+1)*height/8);y+=4)for(let x=Math.floor(gx*width/8);x<Math.floor((gx+1)*width/8);x+=4){sum+=pixels[(y*width+x)*channels+c];count++;}signature.push(Math.round(sum/Math.max(1,count)));}
  for(const horizontal of [true,false]){
    const lines=horizontal?height:width,cross=horizontal?width:height;
    for(let line=3;line<lines-3;line++){
      let strong=0,sum=0,count=0;
      for(let n=0;n<cross;n+=4){let delta=0;for(let c=0;c<3;c++){const pos=(l:number)=>(horizontal?l*width+n:n*width+l)*channels+c;delta+=Math.abs(pixels[pos(line-2)]-pixels[pos(line+2)]);}delta/=3;sum+=delta;count++;if(delta>=24)strong++;}
      const extent=strong/count,contrast=sum/count;
      if(extent<.8||contrast<24)continue;
      const coordinate=line/lines*(horizontal?viewport.height:viewport.width);
      const region=horizontal?{x:0,y:Math.max(0,coordinate-3),width:viewport.width,height:6}:{x:Math.max(0,coordinate-3),y:0,width:6,height:viewport.height};
      if(findings.some(f=>f.kind===(horizontal?'horizontal-seam':'vertical-seam')&&Math.abs((horizontal?f.region.y:f.region.x)-(horizontal?region.y:region.x))<12))continue;
      const edges=horizontal?[bounds.y,bounds.y+bounds.height]:[bounds.x,bounds.x+bounds.width];
      findings.push({kind:horizontal?'horizontal-seam':'vertical-seam',source:'pixels',status:'Suspected',confidence:.7,detail:'Persistent high-contrast extended boundary; may be intentional. Contextual review required.',region,contrast,extent,domBoundary:edges.some(edge=>Math.abs(edge-coordinate)<6)});
      if(findings.length>=12)return {findings,signature};
    }
  }return {findings,signature};
}
export async function visualFrame(page:Page,scenario:QaScenario,capture:BrowserCapture):Promise<VisualLayoutFrame>{
  const data=await page.evaluate(selector=>{
    const element=selector?document.querySelector(selector):document.documentElement;
    if(!element)throw new Error('Visual target selector did not match');
    const r=element.getBoundingClientRect(),style=getComputedStyle(element);
    if(selector&&(style.display==='none'||style.visibility==='hidden'||r.width<=0||r.height<=0))throw new Error('Visual target is not rendered');
    return {bounds:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,scroll:{x:scrollX,y:scrollY},background:style.background,uiState:Array.from(document.querySelectorAll('input,select,textarea,dialog,details')).slice(0,100).map(e=>({tag:e.tagName,id:e.id,value:'value' in e?String(e.value).slice(0,500):undefined,checked:'checked' in e?e.checked:undefined,open:e.hasAttribute('open')})),
      backing:element instanceof HTMLCanvasElement?{width:element.width,height:element.height,expectedWidth:Math.round(r.width*devicePixelRatio),expectedHeight:Math.round(r.height*devicePixelRatio)}:undefined};
  },scenario.assertion.selector);
  if(capture.viewport.width!==data.viewport.width||capture.viewport.height!==data.viewport.height||capture.dpr!==data.dpr)throw new Error('Capture and DOM viewport/DPR differ');
  const bytes=await readFile(capture.path);
  if(createHash('sha256').update(bytes).digest('hex')!==capture.sha256)throw new Error('Capture hash mismatch');
  const pixel=pixelDiagnostics(decodeCapture(bytes),data.viewport,data.bounds),findings=pixel.findings;
  const r=data.bounds,v=data.viewport;
  // Only an explicit fullscreen coverage contract makes empty space a failure.
  if(scenario.assertion.path==='coverage'){
    const gaps=[{x:0,y:Math.max(0,r.y+r.height),width:v.width,height:Math.max(0,v.height-r.y-r.height)},{x:0,y:0,width:v.width,height:Math.max(0,r.y)},{x:0,y:0,width:Math.max(0,r.x),height:v.height},{x:Math.max(0,r.x+r.width),y:0,width:Math.max(0,v.width-r.x-r.width),height:v.height}];
    for(const region of gaps)if(region.width>2&&region.height>2)findings.push({kind:'coverage',source:'dom',status:'Failed',confidence:1,detail:'Explicit fullscreen target does not cover the viewport (CSS pixels).',region});
  }
  if(data.backing&&(Math.abs(data.backing.width-data.backing.expectedWidth)>2||Math.abs(data.backing.height-data.backing.expectedHeight)>2))findings.push({kind:'backing-store',source:'dom',status:'Suspected',confidence:.9,detail:'Canvas backing store differs from CSS size × DPR; intentional render scaling is possible.',region:r});
  const {uiState,...metrics}=data;
  return {...metrics,stateHash:qaHash(uiState),captureId:capture.id,screenshot:{width:capture.width,height:capture.height},findings,signature:pixel.signature};
}
export function summarizeVisual(scenario:QaScenario,frames:VisualLayoutFrame[],captures:BrowserCapture[],conditions:string,baseline?:VisualLayoutInspection):VisualLayoutInspection{
  // Require a boundary in both time samples at each viewport. Moving edges are observations, not seams.
  for(let i=0;i<frames.length;i+=2)for(const frame of frames.slice(i,i+2))frame.findings=frame.findings.filter(f=>f.source!=='pixels'||frames.slice(i,i+2).every(other=>other.findings.some(g=>g.kind===f.kind&&Math.abs(g.region.x-f.region.x)<8&&Math.abs(g.region.y-f.region.y)<8)));
  let unstable=false;
  for(let i=0;i<frames.length;i+=2){const a=frames[i],b=frames[i+1];if(!b||['x','y','width','height'].some(key=>Math.abs(a.bounds[key as keyof typeof a.bounds]-b.bounds[key as keyof typeof b.bounds])>2)||JSON.stringify(a.backing)!==JSON.stringify(b.backing)){unstable=true;a.findings.push({kind:'resize-instability',source:'dom',status:'Suspected',confidence:.9,detail:'Target bounds or backing changed between settled samples; late resize/layout or intentional target animation requires review.',region:a.bounds});}}
  const property=scenario.assertion.path!, relevant=frames.flatMap(f=>f.findings).filter(f=>property==='coverage'?f.kind==='coverage':property==='backing'?f.kind==='backing-store':true);
  const result:VisualLayoutInspection={status:relevant.some(f=>f.status==='Failed')?'Failed':relevant.length?'Suspected':'Verified',property,selector:scenario.assertion.selector,conditions,frames,captures,limitation:'Verified is scoped to the declared measured property, not aesthetic correctness. Seams and backing-scale differences are candidates. CSS-pixel PNG sampling may miss thin/subtle defects; animation is not pixel-perfect compared.'};
  if(unstable&&result.status!=='Failed')result.status='Suspected';
  if(property==='seams'&&result.status==='Verified')result.status='Suspected'; // no candidates is not proof of continuous design
  if(scenario.visual_layout?.baseline){
    const b=scenario.visual_layout.baseline;
    const matched=Boolean(baseline&&baseline.conditions===conditions&&baseline.frames.length===frames.length&&baseline.frames.every((f,i)=>JSON.stringify([f.viewport,f.dpr,f.scroll,f.screenshot,f.stateHash])===JSON.stringify([frames[i].viewport,frames[i].dpr,frames[i].scroll,frames[i].screenshot,frames[i].stateHash])));
    const old=baseline?.frames.flatMap(f=>f.findings)??[],now=frames.flatMap(f=>f.findings);
    const same=(a:VisualLayoutFinding,b:VisualLayoutFinding)=>a.kind===b.kind&&Math.abs(a.region.x-b.region.x)<8&&Math.abs(a.region.y-b.region.y)<8;
    const resolved=matched?old.filter(a=>!now.some(b=>same(a,b))).length:0,persisting=matched?old.filter(a=>now.some(b=>same(a,b))).length:0,newCandidates=matched?now.filter(a=>!old.some(b=>same(a,b))).length:0;
    const shifts=matched?frames.flatMap((f,i)=>f.signature.map((v,j)=>Math.abs(v-baseline!.frames[i].signature[j]))):[];
    result.comparison={backgroundShift:shifts.length?shifts.reduce((a,b)=>a+b,0)/shifts.length:undefined,baselineReportId:b.report_id,baselineScenarioId:b.scenario_id,matched,resolved,persisting,newCandidates,summary:matched?'Matched capture conditions; compare stable defect regions, not animated pixels. Baseline is historical, never fresh passing proof.':'Baseline conditions differ or baseline unavailable; no before/after claim.'};
    if(!matched)result.status='Blocked';
  }
  return result;
}
