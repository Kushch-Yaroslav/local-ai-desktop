import type { VisionQuestion } from '../../shared/model-features';
import { visualFrame, summarizeVisual } from './visual-layout-qa';
import { qaHash } from './qa-loop-guard';
import { randomUUID } from 'node:crypto';
import type { Page, CDPSession } from 'playwright-core';
import type { BrowserQaReport, BrowserQaStatus, BrowserQaCheck, BrowserCapture, BrowserVisualResult, QaAssertion, QaScenario, QaScenarioResult, QaStep, QaObservation, VisualLayoutInspection, VisualLayoutFrame } from '../../shared/browser-qa';
import { keyboardActions, keyboardStep, qaSnapshot } from './browser-qa';
import { inspectResponsive, layoutScenario, nextBreakpoint, type ResponsiveOptions } from './responsive-qa';

export type QaCdp = Pick<CDPSession,'send'|'detach'>;
export interface ScenarioQaOptions {
  metrics?():Promise<QaCdp>;
  page: Page; signal: AbortSignal; steps: QaStep[]; scenarios?: QaScenario[];
  setViewport?(viewport:{width:number;height:number}):Promise<void>;
  baseline?(ref:{report_id:string;scenario_id:string}):Promise<VisualLayoutInspection|undefined>;
  sourceRevisions?(): Record<string,string>;
  responsive?: ResponsiveOptions;
  errors(): string[]; capture(cdp?:QaCdp): Promise<BrowserCapture>;
  navigate?(target: string): Promise<{ authRequired?: boolean }>;
  analyze?: (capture: BrowserCapture, before?: BrowserCapture, scenario?: VisionQuestion) => Promise<BrowserVisualResult>;
  status?(status: BrowserQaStatus): void;
}
class QaBlocked extends Error { constructor(readonly code: 'PRECONDITION_FAILED' | 'UNSUPPORTED_OPERATION' | 'AUTH_REQUIRED' | 'INCONCLUSIVE', message: string) { super(message); } }
const emptyVisual = (): BrowserVisualResult => ({ analyzed:false,status:'Not Verified',reason:'Vision Off or unavailable; functional evidence only' });
const check = (action:string,expected:string,actual:string,status:BrowserQaCheck['status']): BrowserQaCheck => ({action,expected,actual,status});
const aggregate = (checks:BrowserQaCheck[]): BrowserQaCheck['status'] => checks.some(c=>c.status==='Failed')?'Failed':checks.some(c=>c.status==='Blocked')?'Blocked':checks.length&&checks.every(c=>c.status==='Verified')?'Verified':'Not Verified';
const matches = (a:QaAssertion, before:unknown, after:unknown) => {
  if(a.operator==='equals')return typeof after==='number'&&typeof a.expected==='number'?Math.abs(after-a.expected)<=(a.tolerance??0):after===a.expected;
  if(a.operator==='changed')return typeof after==='number'&&typeof before==='number'?Math.abs(after-before)>(a.tolerance??0):after!==before;
  return typeof after==='number'&&typeof before==='number'&&(a.operator==='increased'?after-before:before-after)>(a.tolerance??0);
};
/** Read only explicitly named scalar diagnostics or visible DOM properties. No eval. */
async function observe(page:Page,a:QaAssertion,timeout:number,errors:()=>string[]=()=>[]):Promise<QaObservation['value']> {
  if(a.source==='runtime_errors')return errors().length+(await qaSnapshot(page)).rejections.length;
  if(a.source==='raf'||a.source==='draws'){const state=await qaSnapshot(page);return a.source==='raf'?state.frames:state.draws;}
  if(a.source==='url')return new URL(page.url()).pathname+new URL(page.url()).search+new URL(page.url()).hash;
  if(a.source==='pixels')return null;
  if(a.source==='diagnostic')return page.evaluate(path=>{
    let value:unknown=(window as unknown as {__qaDiagnostics?:unknown}).__qaDiagnostics;
    for(const key of path.split('.')){if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,key))return null;value=(value as Record<string,unknown>)[key];}
    return typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean'?value:typeof value==='string'&&value.length<=1000?value:null;
  },a.path!);
  if(a.source==='text_fit'){
    const target=page.locator(a.selector!);
    if(await target.count()!==1)throw new QaBlocked('INCONCLUSIVE','Text fit needs exactly one matching element');
    const value=await target.evaluate(root=>{
      if(root.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive]'))return null;
      const element=root as HTMLElement,b=element.getBoundingClientRect(),style=getComputedStyle(root);
      if(!b.width||!b.height||style.visibility!=='visible'||Number(style.opacity)===0||!element.offsetWidth||!element.offsetHeight)return null;
      let left=b.left,top=b.top,right=b.right,bottom=b.bottom;
      for(let e:Element|null=root;e;e=e.parentElement){
        const s=getComputedStyle(e),r=e.getBoundingClientRect();
        if(s.visibility!=='visible'||s.display==='none'||Number(s.opacity)===0)return null;
        if(s.transform!=='none'){const m=new DOMMatrixReadOnly(s.transform);if(!m.is2D||m.b!==0||m.c!==0||m.a<=0||m.d<=0)return null;}
        if(e!==root&&['hidden','clip','scroll','auto'].includes(s.overflowX)){left=Math.max(left,r.left);right=Math.min(right,r.right);}
        if(e!==root&&['hidden','clip','scroll','auto'].includes(s.overflowY)){top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}
      }
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node:Node|null,count=0,texts=0,violations=0;
      while((node=walker.nextNode())&&count++<300){
        if(!node.textContent?.trim()||node.parentElement?.closest('script,style,input,textarea,select,[contenteditable],[data-private],[data-sensitive]'))continue;
        const parent=node.parentElement!,s=getComputedStyle(parent);if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0)continue;
        texts++;const range=document.createRange();range.selectNodeContents(node);
        for(const r of range.getClientRects())if(r.width&&r.height&&(r.left<left-1||r.right>right+1||r.top<top-1||r.bottom>bottom+1))violations++;
      }
      // A bounded scan that was truncated cannot certify the remaining text.
      return count>=300||!texts?null:violations;
    },undefined,{timeout});
    if(value===null)throw new QaBlocked('INCONCLUSIVE','Text fitting is unavailable for hidden/private/unsupported or empty targets');
    return value;
  }
  const target=page.locator(a.selector!).first();
  if(a.source==='style'){if(await page.locator(a.selector!).count()!==1)throw new QaBlocked('INCONCLUSIVE','Style target must be unique');return target.evaluate((e,path)=>getComputedStyle(e).getPropertyValue(path).slice(0,120),a.path!,{timeout});}
  if(a.source==='viewport')return target.evaluate(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight;},undefined,{timeout});
  if(a.source==='visible')return target.isVisible();
  // body/html aggregate text and script content cannot attribute an input effect.
  if(a.operator!=='equals'&&await target.evaluate(e=>e.matches('body,html,script,style'),undefined,{timeout}))throw new QaBlocked('INCONCLUSIVE','A whole-document text change cannot establish the requested interaction. Select an application state/diagnostic.');
  if(a.source==='value')return target.inputValue({timeout});
  return target.innerText({timeout}).then(text=>text.trim().slice(0,1000));
}
async function perform(page:Page,step:QaStep,held:Set<string>,timeout:number) {
  const target=step.selector?page.locator(step.selector).first():undefined;
  if(keyboardActions.has(step.action)){if(target)await target.focus({timeout});await keyboardStep(page,step,held);}
  else if(step.action==='click')await target!.click({timeout});
  else if(step.action==='fill'){
    if(!await target!.evaluate(e=>e.matches('input:not([type=file]),textarea')||(e as HTMLElement).isContentEditable))throw new QaBlocked('UNSUPPORTED_OPERATION','Fill requires an editable field; keyboard input must use key actions.');
    await target!.fill(step.value!,{timeout});
  } else if(step.action==='focus')await target!.focus({timeout});
  else if(step.action==='scroll')await page.mouse.wheel(0,step.delta_y??500);
  else if(step.action==='wait')await page.waitForTimeout(step.duration_ms??300);
  else {
    const box=target?await target.boundingBox():undefined;
    if(target&&!box)throw new QaBlocked('PRECONDITION_FAILED','Pointer target is not visible');
    const x=(box?.x??0)+(step.x??(box?box.width/2:0)),y=(box?.y??0)+(step.y??(box?box.height/2:0));
    if(step.action==='pointer-lock'){
      await target!.click({timeout});
      if(!await target!.evaluate(e=>document.pointerLockElement===e))throw new QaBlocked('UNSUPPORTED_OPERATION','The application did not acquire pointer lock; no synthetic lock was forced.');
    } else {
      await page.mouse.move(x,y);
      if(step.action==='drag'){await page.mouse.down();try{await page.mouse.move(x+(step.to_x??80),y+(step.to_y??0),{steps:8});}finally{await page.mouse.up();}}
    }
  }
}
function legacyScenarios(steps:QaStep[],url:string):QaScenario[] {
  return steps.map((step,index)=>({id:`legacy-${index+1}`,goal:`${step.action} ${step.selector??step.key??''}`,target:url,preconditions:[],required_state:[],steps:[step],timeout_ms:5000,
    assertion:step.expect?{source:step.expect.value!==undefined?'value':'text',selector:step.expect.selector,operator:step.expect.changed===undefined?'equals':'changed',expected:step.expect.value??step.expect.text}: {source:'pixels',operator:'changed'}}));
}
export async function runScenarioQa(options:ScenarioQaOptions):Promise<BrowserQaReport>{
  const {page,signal}=options,start=performance.now(),checks:BrowserQaCheck[]=[],captures:BrowserCapture[]=[],results:QaScenarioResult[]=[];
  let visual=emptyVisual(),capturedBytes=0;
  let progress:BrowserQaStatus['responsive'],visualProgress:BrowserQaStatus['visualLayout'];
  const notify=(value:BrowserQaStatus)=>{if(value.responsive)progress=value.responsive;if(value.visualLayout)visualProgress=value.visualLayout;options.status?.({...value,...(progress?{responsive:progress}:{}),...(visualProgress?{visualLayout:visualProgress}:{})});};
  const boundary=()=>{signal.throwIfAborted();if(performance.now()-start>30000)throw new DOMException('Functional QA exceeded 30 second operation deadline','TimeoutError');};
  const capture=async(cdp?:QaCdp)=>{boundary();if(captures.length>=8||capturedBytes>=12*1024*1024)throw new QaBlocked('INCONCLUSIVE','Per-operation capture resources exhausted; split the scenarios across QA calls.');const value=await options.capture(cdp);if(capturedBytes+value.bytes>12*1024*1024)throw new QaBlocked('INCONCLUSIVE','Aggregate capture budget exceeded; split the scenarios.');capturedBytes+=value.bytes;captures.push(value);return value;};
  const report=(reason?:string,reasonCode?:BrowserQaReport['reasonCode']):BrowserQaReport=>{
    const visualChecks=new Set(results.filter(r=>r.evidenceKind==='visual').flatMap(r=>r.checks));
    const functional=aggregate(checks.filter(c=>!visualChecks.has(c))),functionalScenarios=results.filter(r=>r.evidenceKind!=='visual'),hasScenarios=functionalScenarios.length>0,complete=hasScenarios&&functionalScenarios.every(r=>r.status==='Verified');
    return {id:randomUUID(),scope:'interaction',status:functional==='Failed'||results.some(r=>r.evidenceKind==='visual'&&r.status==='Failed')?'Failed':functional==='Blocked'||results.some(r=>r.status==='Blocked')?'Blocked':results.length>0&&results.every(r=>r.status==='Verified')&&functional==='Verified'&&(!options.analyze||visual.status==='Verified'||results.every(r=>r.viewport&&r.evidenceKind!=='visual'))?'Verified':'Partially Verified',functionalStatus:complete?functional:functional==='Verified'?'Partially Verified':functional,url:page.isClosed()?'':page.url(),capturedAt:new Date().toISOString(),checks,captures,errors:options.errors(),visual,scenarios:results,elapsedMs:performance.now()-start,...(reason?{reason}:{}),...(reasonCode?{reasonCode}:{})};
  };
  const styleOnly=Boolean(options.scenarios?.length&&options.scenarios.every(s=>s.assertion.source==='style'));
  notify({phase:'started'});
  try{
    boundary();if(!styleOnly){notify({phase:'capturing'});await capture();}
    checks.push(check('load','Document has a rendered body',await page.title(),await page.locator('body').isVisible()?'Verified':'Failed'));
    // Passive liveness observations are runtime diagnostics, never invented input tests.
    const t0=await qaSnapshot(page);await page.waitForTimeout(100);const t1=await qaSnapshot(page);await page.waitForTimeout(100);const t2=await qaSnapshot(page);
    if(t1.frames>t0.frames)checks.push(check('canvas animation','Observed RAF callbacks continue (not object/camera motion)',`${t0.frames} → ${t1.frames} → ${t2.frames}`,t2.frames>t1.frames?'Verified':'Not Verified'));
    if(t1.draws>t0.draws)checks.push(check('canvas render','Observed draw calls continue (not visual correctness)',`${t0.draws} → ${t1.draws} → ${t2.draws}`,t2.draws>t1.draws?'Verified':'Not Verified'));
    const scenarios=options.scenarios?.length?[...options.scenarios]:legacyScenarios(options.steps,page.url());
    const probes:Array<{width:number;failed:boolean}>=[];
    for(const scenario of scenarios){
      boundary();const began=performance.now(),held=new Set<string>(),local:BrowserQaCheck[]=[],pre:BrowserQaCheck[]=[],observations:QaObservation[]=[];
      const result:QaScenarioResult={id:scenario.id,goal:scenario.goal,target:scenario.target,deliverableId:scenario.deliverable_id,criterionId:scenario.criterion_id,status:'Not Verified',evidenceKind:scenario.id.startsWith('legacy-')&&!options.scenarios?.length?'interaction':['pixels','visual_layout'].includes(scenario.assertion.source)?'visual':['runtime_errors','raf','draws'].includes(scenario.assertion.source)?'runtime':scenario.assertion.sample_ms?'temporal':scenario.steps.length?'interaction':'runtime',assertion:scenario.assertion,preconditions:pre,observations,checks:local,elapsedMs:0};
      results.push(result);
      let visualCdp:QaCdp|undefined;
      let reason:QaScenarioResult['reasonCode'];
      let errorStart=options.errors().length;
      const read=async(a:QaAssertion,timeout:number)=>{if(a.source!=='layout')return observe(page,a,timeout,options.errors);result.responsive=await inspectResponsive(page);return result.responsive.findings.filter(f=>f.confidence==='confirmed').length;};
      const deadline=began+scenario.timeout_ms;
      const timeout=()=>{boundary();if(performance.now()>deadline)throw new DOMException('Scenario operation timed out','TimeoutError');return Math.max(1,Math.min(3000,deadline-performance.now()));};
      try{
        if(scenario.viewport){
          if(options.setViewport)await options.setViewport(scenario.viewport);else await page.setViewportSize({width:scenario.viewport.width,height:scenario.viewport.height});
          if(scenario.assertion.source==='visual_layout'){
            visualCdp=options.metrics?await options.metrics():await page.context().newCDPSession(page);
            await visualCdp.send('Emulation.setDeviceMetricsOverride',{width:scenario.viewport.width,height:scenario.viewport.height,deviceScaleFactor:scenario.visual_layout?.dpr??1,mobile:false});
          }
          result.viewport={...scenario.viewport};
          notify({phase:'interacting',responsive:{viewport:result.viewport,checked:new Set(results.slice(0,-1).filter(r=>r.viewport).map(r=>`${r.viewport!.width}x${r.viewport!.height}`)).size,total:options.responsive?.breakpoint?.attempts??new Set(scenarios.filter(s=>s.viewport).map(s=>`${s.viewport!.width}x${s.viewport!.height}`)).size,issues:results.reduce((n,r)=>n+(r.responsive?.findings.length??0),0),vision:false}});
        }
        const target=new URL(scenario.target,page.url());
        if(target.origin!==new URL(page.url()).origin)throw new QaBlocked('PRECONDITION_FAILED','Scenario target is outside the approved origin');
        if(target.href!==page.url()||scenario.viewport){
          if(!options.navigate)throw new QaBlocked('PRECONDITION_FAILED','This runner cannot navigate to the declared target');
          if((await options.navigate(target.href)).authRequired)throw new QaBlocked('AUTH_REQUIRED','The target requires authentication; no authorization bypass was attempted.');
          if(scenario.viewport)await page.waitForTimeout(100);
        }
        if(scenario.viewport)errorStart=0;
        if(page.url()!==target.href)throw new QaBlocked('PRECONDITION_FAILED','Application route differs from the scenario target');
        for(const condition of [...scenario.preconditions,...scenario.required_state]){
          if(condition.operator!=='equals')throw new QaBlocked('PRECONDITION_FAILED','Preconditions require a concrete expected state');
          let value:QaObservation['value'];
          const conditionDeadline=Math.min(deadline,performance.now()+1000);
          try{
            value=await read(condition,Math.min(1000,timeout()));
            while((value===null||!matches(condition,null,value))&&performance.now()+60<conditionDeadline){await page.waitForTimeout(50);value=await read(condition,Math.min(1000,timeout()));}
          }catch(error){if(error instanceof Error&&error.name==='TimeoutError')throw new QaBlocked('PRECONDITION_FAILED','The declared precondition target was not available before its deadline.');throw error;}
          const ok=value!==null&&matches(condition,null,value);pre.push(check('precondition',JSON.stringify(condition),JSON.stringify(value),ok?'Verified':'Blocked'));
          if(!ok)throw new QaBlocked('PRECONDITION_FAILED','Required application state was not established; no scenario input was delivered.');
        }
        if(scenario.assertion.source==='visual_layout'){
          if(scenario.assertion.path==='backing'&&!await page.locator(scenario.assertion.selector!).first().evaluate(e=>e instanceof HTMLCanvasElement,undefined,{timeout:timeout()}))throw new QaBlocked('UNSUPPORTED_OPERATION','Backing-store measurement requires a Canvas target, not a generic DOM container.');
          const config=scenario.visual_layout??{},frames:VisualLayoutFrame[]=[],images:BrowserCapture[]=[];
          result.visualLayout={status:'Blocked',property:scenario.assertion.path!,selector:scenario.assertion.selector,conditions:'capture-incomplete',frames,captures:images,limitation:'Partial observations; the operation has not completed.'};
          // This branch only runs on the existing isolated QA page. Metrics are true CDP rendering, never window scaling.
          for(const step of scenario.steps){timeout();await perform(page,step,held,timeout());}
          const cdp=visualCdp!;
          try {
            const sizes=[scenario.viewport!,...(config.resize??[])];
            for(const size of sizes){
              timeout();
              await cdp.send('Emulation.setDeviceMetricsOverride',{width:size.width,height:size.height,deviceScaleFactor:config.dpr??1,mobile:false});
              // Bounded settling and two observations retain animation rather than mutating project code.
              await page.waitForTimeout(180);
              for(let sample=0;sample<2;sample++){
                timeout();if(sample)await page.waitForTimeout(180);
                const image=await capture(cdp);images.push(image);frames.push(await visualFrame(page,scenario,image));
                observations.push({atMs:performance.now()-began,value:frames.at(-1)!.findings.filter(f=>f.status==='Failed').length,captureId:image.id});
                notify({phase:'capturing',visualLayout:{viewport:size,frames:frames.length,suspected:frames.flatMap(f=>f.findings).filter(f=>f.status==='Suspected').length,failures:frames.flatMap(f=>f.findings).filter(f=>f.status==='Failed').length}});
              }
              result.responsive=await inspectResponsive(page);frames.at(-1)!.responsive=result.responsive;
              const confirmed=result.responsive.findings.filter(f=>f.confidence==='confirmed').length;
              checks.push(check(`resize DOM bounds ${size.width}x${size.height}`,'No confirmed unintended overflow or interactive bounds defects',`${confirmed} confirmed; ${result.responsive.findings.length-confirmed} candidates`,confirmed?'Failed':result.responsive.findings.length?'Not Verified':'Verified'));
            }
          } finally {await cdp.detach().catch(()=>undefined);}
          const conditions=qaHash({version:1,target:page.url(),viewport:scenario.viewport,assertion:scenario.assertion,preconditions:scenario.preconditions,required_state:scenario.required_state,steps:scenario.steps,dpr:config.dpr??1,resize:config.resize??[],state:config.state_key??''});
          const baseline=config.baseline?await options.baseline?.(config.baseline):undefined;
          const layout=summarizeVisual(scenario,frames,images,conditions,baseline);result.visualLayout=layout;
          const suspects=frames.flatMap(f=>f.findings);
          const historical=layout.comparison?.matched?baseline:undefined;
          if(options.analyze&&config.vision!=='off'&&(config.vision==='on'||suspects.length>0||historical?.frames.some(f=>f.findings.length))){
            notify({phase:'analyzing'});
            const index=frames.findIndex(f=>f.findings.length)>-1?frames.findIndex(f=>f.findings.length):historical?.frames.findIndex(f=>f.findings.length)??-1;
            const at=index>=0?index:frames.length-1,image=images[at],focus=frames[at],beforeImage=historical?.captures[at];
            result.visual=await options.analyze(image,beforeImage,{goal:`Targeted Visual Layout inspection. Requirement: ${scenario.goal}. Route ${image.url}; CSS viewport ${image.viewport.width}x${image.viewport.height}, DPR ${image.dpr}; image ${image.width}x${image.height}. Inspect these CSS-pixel regions (map proportionally to image): ${JSON.stringify([...focus.findings,...(historical?.frames[at].findings??[])]).slice(0,5000)}. Target DOM context: ${JSON.stringify({bounds:focus.bounds,backing:focus.backing,background:focus.background})}. Specifically inspect bottom 20% for uncovered bands and listed extended boundaries for unintended seams. Distinguish intentional design edges. Describe uncertainty; generic looks-good cannot verify this property.`,temporal:false});result.visual.captureIds=[...(beforeImage?[beforeImage.id]:[]),image.id];visual=result.visual;
          }
          if(layout.status==='Blocked')throw new QaBlocked('PRECONDITION_FAILED',layout.comparison?.summary??'Visual baseline unavailable');
          result.status=layout.status==='Suspected'?'Not Verified':layout.status;
          if(result.status==='Not Verified'){result.reasonCode='INCONCLUSIVE';result.reason='Suspected visual boundaries/scaling require contextual review; absence of seam candidates does not certify visual continuity.';}
          if(result.status==='Failed'){result.reasonCode='VISUAL_REQUIREMENT_FAILED';result.reason='Explicit fullscreen coverage requirement violated by measured target bounds.';}
          local.push(check(scenario.goal,JSON.stringify(scenario.assertion),JSON.stringify({status:layout.status,frames:frames.length,comparison:layout.comparison}),result.status));
        } else {
        const a=scenario.assertion;let before=await read(a,timeout());
        const input=scenario.steps.some(step=>keyboardActions.has(step.action)||['mousemove','drag','click'].includes(step.action));
        if(input&&a.operator!=='equals'&&!['pixels','raf','draws','runtime_errors'].includes(a.source)){
          await page.waitForTimeout(150);const baseline=await read(a,timeout());
          if(before!==null&&baseline!==null&&matches({...a,operator:'changed'},before,baseline))throw new QaBlocked('INCONCLUSIVE','Observed state also changes without input; background animation cannot prove control handling. Choose a stable camera/state diagnostic.');
          before=baseline;
        }
        observations.push({atMs:performance.now()-began,value:before});
        if(a.sample_ms)observations[0].captureId=(await capture()).id;
        notify({phase:'interacting'});
        if(scenario.id.startsWith('legacy-')&&scenario.steps.some(step=>step.expect?.changed===false))throw new QaBlocked('INCONCLUSIVE','Legacy unchanged expectations need a concrete equality assertion.');
        for(const step of scenario.steps){timeout();await perform(page,step,held,timeout());}
        let after=before;
        const samples=a.sample_ms?.slice(1)??[100];const sampleStart=performance.now();
        for(const ms of samples){
          const left=ms-(performance.now()-sampleStart);if(left>0)await page.waitForTimeout(left);timeout();after=await read(a,timeout());
          observations.push({atMs:performance.now()-began,value:after,...(a.sample_ms?{captureId:(await capture()).id}:{})});
        }
        // Explicit equality supports async UI without fixed sleeps masquerading as proof.
        while(a.source!=='layout'&&a.operator==='equals'&&!matches(a,before,after)&&performance.now()+60<deadline){await page.waitForTimeout(50);after=await read(a,timeout());}
        observations[observations.length-1]={...observations.at(-1)!,atMs:performance.now()-began,value:after};
        if(scenario.viewport&&a.source!=='style'){
          result.responsive??=await inspectResponsive(page);
          const image=await capture();
          observations[observations.length-1].captureId=image.id;
          if(options.analyze&&options.responsive?.vision!=='off'&&(options.responsive?.vision==='on'||result.responsive.hasCanvas||result.responsive.findings.some(f=>f.confidence==='candidate'))){
            notify({phase:'analyzing',responsive:{viewport:scenario.viewport,checked:new Set(results.filter(r=>r.viewport).map(r=>`${r.viewport!.width}x${r.viewport!.height}`)).size,total:options.responsive?.breakpoint?.attempts??new Set(scenarios.filter(s=>s.viewport).map(s=>`${s.viewport!.width}x${s.viewport!.height}`)).size,issues:result.responsive.findings.length,vision:true}});
            result.visual=await options.analyze(image,undefined,{goal:`${scenario.goal}. Correlate screenshot at ${scenario.viewport.width}x${scenario.viewport.height} with bounded DOM candidates: ${JSON.stringify(result.responsive.findings).slice(0,6000)}. Findings are probabilistic; do not infer other viewports or routes.`,temporal:false});visual=result.visual;
          }
          if(a.source==='layout'&&after===0&&(result.responsive.truncated||result.responsive.findings.some(f=>f.confidence==='candidate')))throw new QaBlocked('INCONCLUSIVE','DOM inspection found ambiguous geometry candidates or reached its resource bound; review scoped evidence and optional Vision before claiming layout correctness.');
        }
        if(a.source==='pixels'){
          const last=await capture(),first=captures.find(c=>c.id===observations[0].captureId);
          if(options.analyze){visual=await options.analyze(last,first,{goal:scenario.goal,temporal:Boolean(a.sample_ms)});result.visual=visual;}
          throw new QaBlocked('INCONCLUSIVE','Pixel/visual observations are qualified evidence; changed pixels alone establish neither camera control nor a dynamic requirement.');
        }
        if(before===null||after===null)throw new QaBlocked('INCONCLUSIVE','The named application observation is unavailable');
        let pass=matches(a,before,after);
        if(a.sample_ms&&a.operator!=='equals')pass=observations.slice(1).every((o,i)=>matches(a,observations[i].value,o.value));
        const runtimeErrors=options.errors().slice(errorStart);if(runtimeErrors.length){local.push(check('scenario runtime errors','No new application errors',runtimeErrors.join('\n'),'Failed'));pass=false;}
        if(!pass&&a.operator!=='equals'&&scenario.steps.some(step=>step.action==='key')&&!scenario.steps.some(step=>step.action==='hold'||step.action==='wait'))throw new QaBlocked('INCONCLUSIVE','A tap did not establish a frame-based input response. Use a bounded hold and a stable application observer.');
        const legacy=scenario.id.startsWith('legacy-')&&!options.scenarios?.length;
        if(legacy&&a.operator==='changed'&&!pass)throw new QaBlocked('INCONCLUSIVE','An unscoped legacy change expectation cannot establish that this key has a defined behaviour. Declare the route, preconditions and expected state.');
        local.push(check(scenario.goal,JSON.stringify(a),JSON.stringify(observations),pass?'Verified':'Failed'));
        result.status=pass?'Verified':'Failed';if(!pass){result.reasonCode='FUNCTIONAL_REQUIREMENT_FAILED';result.reason='The declared application assertion did not hold under satisfied preconditions.';}
        }
      }catch(error){
        reason=error instanceof QaBlocked?error.code:error instanceof Error&&error.name==='TimeoutError'?'QA_TIMEOUT':'QA_TOOL_ERROR';
        if(scenario.assertion.source==='visual_layout'&&!result.visualLayout)result.visualLayout={status:'Blocked',property:scenario.assertion.path!,selector:scenario.assertion.selector,conditions:'unavailable',frames:[],captures:[],limitation:String(error)};
        result.reasonCode=reason;result.reason=String(error);result.status=reason==='INCONCLUSIVE'?'Not Verified':'Blocked';
        if(!scenario.viewport&&result.visual?.analyzed&&result.visual.status==='Failed'){result.status='Failed';result.reasonCode='VISUAL_REQUIREMENT_FAILED';result.reason='Vision reported a possible violation of the declared visual criterion; review the captures and observations.';}
        local.push(check(scenario.goal,JSON.stringify(scenario.assertion),String(error),result.status));
      }finally{await visualCdp?.detach().catch(()=>undefined);for(const key of [...held].reverse())await page.keyboard.up(key).catch(()=>undefined);await page.mouse.up().catch(()=>undefined);}
      result.sourceRevisions=options.sourceRevisions?.();result.elapsedMs=performance.now()-began;checks.push(...local);
      if(result.viewport)notify({phase:'interacting',responsive:{viewport:result.viewport,checked:new Set(results.filter(r=>r.viewport).map(r=>`${r.viewport!.width}x${r.viewport!.height}`)).size,total:options.responsive?.breakpoint?.attempts??new Set(scenarios.filter(s=>s.viewport).map(s=>`${s.viewport!.width}x${s.viewport!.height}`)).size,issues:results.reduce((n,r)=>n+(r.responsive?.findings.length??0),0),vision:Boolean(result.visual?.analyzed)}});
      if(options.responsive?.breakpoint&&scenario.viewport&&scenario.assertion.source==='layout'&&['Verified','Failed'].includes(result.status)){
        probes.push({width:scenario.viewport.width,failed:result.status==='Failed'});
        const width=nextBreakpoint(probes,options.responsive.breakpoint.attempts);
        if(width!==undefined&&results.length===scenarios.length)scenarios.push(layoutScenario(`responsive-probe-${scenarios.length+1}`,scenario.target,{width,height:scenario.viewport.height}));
      }
    }
    boundary();const last=styleOnly?undefined:await capture();
    const state=await qaSnapshot(page),errors=[...options.errors(),...state.rejections];
    checks.push(check('exposed numeric diagnostics','No NaN/Infinity in exposed diagnostics',state.diagnosticInvalid.join(', ')||'None observed',state.diagnosticInvalid.length?'Failed':'Verified'));
    checks.push(check('runtime errors','No observed uncaught errors/console errors/rejections',errors.join('\n')||'None observed',errors.length?'Failed':'Verified'));
    if(results.some(r=>r.viewport)&&!results.some(r=>r.visual))visual={analyzed:false,status:'Not Verified',reason:'Scoped DOM/pixel measurements only; no model image analysis was performed.'};
    if(last&&options.analyze&&!results.some(r=>r.visual)&&!results.some(r=>r.viewport)){notify({phase:'analyzing'});visual=await options.analyze(last,captures.find(c=>c.url===last.url),{goal:results.at(-1)?.goal??'Inspect the visible layout only; no interaction claim',temporal:false,purpose:'passive'});}
    const result=report(results.length?undefined:'Passive runtime smoke only. Declare scenarios and acceptance criteria to verify application behaviour.',errors.length||state.diagnosticInvalid.length?'FUNCTIONAL_REQUIREMENT_FAILED':(results.find(r=>r.status==='Failed')??results.find(r=>r.reasonCode))?.reasonCode);result.errors=errors;
    if(probes.length)result.reason=`Responsive geometry probes (not CSS breakpoint inference): ${probes.map(p=>`${p.width}px ${p.failed?'defect reproduced':'bounds passed'}`).join('; ')}. Narrowest observed pass/fail bracket is bounded by these observations only.`;
    notify({phase:'complete',report:result});return result;
  }catch(error){const code=signal.reason?.name==='TimeoutError'||error instanceof Error&&error.name==='TimeoutError'?'QA_TIMEOUT':error instanceof QaBlocked?error.code:'QA_TOOL_ERROR';const result=report(String(error),code);result.status='Blocked';notify({phase:'complete',report:result});return result;}
}
