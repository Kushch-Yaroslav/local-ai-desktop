import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { paths } from './paths';
import { createHash, randomUUID } from 'node:crypto';
import { deliverableVerificationNote, evidenceFresh } from '../../shared/agent-status';
import { projectRevision } from '../web/qa-loop-guard';
import { provesOriginalRegions } from './visual-workflow';
import { normalizeVisualDocument } from '../../shared/visual-debugging';
import type { Database } from './database';
import type { ProjectBrowserSession } from '../web/project-browser';
import type { VisualCommand, VisualDocument, VisualRegion } from '../../shared/visual-debugging';

/** Completed file-tool results, never claims from a final assistant answer. */
function changedPaths(action:import('../../shared/types').ToolActivity):string[]{
  if(action.state!=='completed'||!['write_file','replace_text','apply_patch','create_file','delete_file'].includes(action.toolName??''))return [];
  let result:Record<string,unknown>={};try{result=JSON.parse(action.rawOutput??action.output??'{}');}catch{/* Older actions may lack a structured result. */}
  if(result.unchanged===true||result.applied===false||action.toolName==='replace_text'&&action.arguments?.old_text===action.arguments?.new_text)return [];
  if(Array.isArray(result.files))return result.files.filter((p):p is string=>typeof p==='string').slice(0,64);
  return typeof action.arguments?.path==='string'?[action.arguments.path]:[];
}
function sameVisualTarget(a:VisualRegion,b:VisualRegion):boolean{
  try{const x=new URL(a.url),y=new URL(b.url);if(x.origin!==y.origin||x.pathname!==y.pathname||x.search!==y.search||x.hash!==y.hash)return false;}catch{return false;}
  if(a.viewport.width!==b.viewport.width||a.viewport.height!==b.viewport.height)return false;
  const categories=(region:VisualRegion)=>region.anchors.flatMap(anchor=>anchor.findings??[]).filter(f=>f.category!=='unknown').map(f=>f.category);
  const leftCategories=categories(a),rightCategories=categories(b);
  // A shared element can have independent defects. Merge only matching findings.
  if(!leftCategories.some(category=>rightCategories.includes(category)))return false;
  return a.anchors.some(left=>b.anchors.some(right=>left.confidence>=.8&&right.confidence>=.8&&left.tag===right.tag&&left.selector===right.selector));
}

/** Chat-local evidence, not long-term memory and not a second Verification Ledger. */
export class VisualDebugging {
  private readonly drafts = new Map<string, import('../../shared/visual-debugging').VisualIssue>();
  private readonly activatedDrafts=new Set<string>();
  reconcileSelection(chatId:string,projectId:string,active:boolean){const key=this.key(chatId,projectId);if(!active&&this.activatedDrafts.has(key)){this.activatedDrafts.delete(key);this.drafts.delete(key);}}
  private key(chatId:string,projectId:string){return JSON.stringify([chatId,projectId]);}
  private save(chatId:string,projectId:string,document:VisualDocument){
    // Empty areas are an active UI draft only, never persistent orphan groups.
    this.db.saveVisualDocument(chatId,projectId,{...document,issues:document.issues.filter(i=>i.regionIds.length)});
  }
  constructor(private readonly db: Database) {}
  document(chatId: string, projectId: string) {
    const raw=this.db.visualDocument(chatId,projectId),before=JSON.stringify(raw);
    normalizeVisualDocument(raw);raw.issues=raw.issues.filter(i=>i.regionIds.length);
    const document=normalizeVisualDocument(raw);if(JSON.stringify(document)!==before)this.save(chatId,projectId,document);
    const draft=this.drafts.get(this.key(chatId,projectId));if(draft&&!document.issues.some(i=>i.id===draft.id))document.issues.push(draft);
    for(const issue of document.issues){
      if(!issue.logicalTaskId)continue;
      const runStatus=issue.runId?this.db.analysisRunStatusForGeneration(chatId,issue.runId):undefined;
      const memory=this.db.getAgentPlan(chatId,issue.logicalTaskId)?.taskMemory;
      const item=memory?.deliverables?.items.find(d=>d.id===issue.id);
      const ledger=memory?.verification;
      const records=ledger?.records.filter(r=>r.pass&&r.outcome!=='inconclusive'&&r.class==='functional'&&evidenceFresh(r,ledger)&&r.coverage?.some(c=>c.deliverable_id===issue.id&&c.qualified===false))??[];
      const scoped=provesOriginalRegions(memory?.browser_qa,document.regions.filter(r=>r.groupId===issue.id));
      const verified=item&&['verified'].includes(item.status)&&item.criteria?.length&&item.criteria.every(c=>records.some(r=>r.coverage?.some(v=>v.deliverable_id===issue.id&&v.criterion_id===c.id&&v.qualified===false)))&&scoped;
      issue.runtimeStatus=runStatus==='running'?'In progress':verified?'Verified':item?.status==='implemented'||item?.status==='verified'?'Fixed':undefined;
      issue.lastAction=item?.evidence;
      issue.verificationNote=item?deliverableVerificationNote(item,ledger):undefined;
      if(!verified&&item?.status==='verified')issue.verificationNote={message:'Исходные URL, viewport или DOM anchor области не подтверждены.'};
      if(verified&&memory?.browser_qa&&!issue.events?.some(e=>e.action==='Verified'&&e.evidenceId===records.at(-1)?.id))issue.events=[...(issue.events??[]),{at:memory.browser_qa.capturedAt,source:'runtime' as const,action:'Verified',evidenceId:records.at(-1)?.id}].slice(-30);
      if(verified&&memory?.browser_qa&&(!issue.check||issue.check.at<memory.browser_qa.capturedAt))issue.check={status:'Verified',at:memory.browser_qa.capturedAt,url:document.regions.find(r=>r.groupId===issue.id)!.url,viewport:document.regions.find(r=>r.groupId===issue.id)!.viewport,reportId:memory.browser_qa.id,ledgerId:records.at(-1)?.id};
      if(!verified&&item?.status==='verified'&&!issue.check)issue.check={status:'Partially Verified',reason:'original-conditions-unproven',at:memory?.browser_qa?.capturedAt??new Date().toISOString(),url:document.regions.find(r=>r.groupId===issue.id)!.url,viewport:document.regions.find(r=>r.groupId===issue.id)!.viewport};

      if(issue.statusSource!=='user'&&issue.statusSource!=='check'){
        if(verified){issue.status='Verified';issue.statusSource='runtime';issue.verification='Ledger linked';issue.evidenceRefs=[...issue.regionIds,...records.map(r=>r.id)];}
        else if(issue.runtimeStatus){issue.status=issue.runtimeStatus;issue.statusSource='runtime';issue.verification='Not Verified';}
        else if(issue.status==='In progress'&&runStatus&&runStatus!=='running'){issue.status='Unresolved';issue.statusSource='runtime';issue.verification='Not Verified';}
        else if(issue.status==='Verified'){issue.status='Fixed';issue.verification='Not Verified';}
      }
      if(issue.check?.ledgerId){const proof=ledger?.records.find(r=>r.id===issue.check!.ledgerId);
        if(!proof||!ledger||!evidenceFresh(proof,ledger)){issue.check={...issue.check,status:'Not Verified',reason:'evidence-stale'};issue.verification='Not Verified';if(issue.status==='Verified')issue.status='Fixed';}
      }
      if(item?.paths)issue.suspectedSourceFiles=item.paths.slice(0,12);
      const run=issue.runId?this.db.listAnalysisRuns(chatId).find(r=>r.generationId===issue.runId):undefined;
      const root=document.regions.find(r=>r.groupId===issue.id)?.projectRoot;
      const related=Boolean(root&&item?.paths?.length&&run?.actions.some(a=>changedPaths(a).some(path=>(item.paths??[]).some(p=>resolve(root,p)===resolve(root,path)))));
      if(run?.status==='completed'&&related&&issue.workflow?.source!=='user'&&issue.workflow?.runId!==issue.runId){
        issue.workflow={state:'completed',source:'runtime',at:run.completedAt??new Date().toISOString(),runId:issue.runId};
      }

    }
    normalizeVisualDocument(document);
    if(JSON.stringify(document)!==before)this.save(chatId,projectId,document);
    return document;
  }
  private readonly projectHashes=new Map<string,{at:number;hash:string}>();
  private readonly sourceHashes=new Map<string,{mtime:number;size:number;hash:string}>();
  async validatedDocument(chatId:string,projectId:string){
    const document=this.document(chatId,projectId);
    for(const issue of document.issues){
      if(issue.check?.status!=='Verified')continue;
      const record=issue.logicalTaskId?this.db.getAgentPlan(chatId,issue.logicalTaskId)?.taskMemory?.verification?.records.find(r=>r.id===issue.check!.ledgerId):undefined;
      let report:import('../../shared/browser-qa').BrowserQaReport|undefined;
      if(!record&&issue.check.evidencePath)try{const path=await realpath(issue.check.evidencePath);if(path.startsWith(resolve(paths.cache,'browser-captures')+sep)&&(await stat(path)).size<=1024*1024){const saved=JSON.parse(await readFile(path,'utf8'));if(saved.id===issue.check.reportId&&saved.projectRoot===document.regions.find(r=>r.groupId===issue.id)?.projectRoot)report=saved;}}catch{/* An unavailable saved report cannot certify a current source revision. */}
      const revisions=record?.source_revisions??report?.sourceRevisions??{};
      const root=document.regions.find(r=>r.groupId===issue.id)?.projectRoot;
      let valid=Boolean((record||report)&&root&&(Object.keys(revisions).length||issue.check.revisionFingerprint));
      try{const allowed=(await realpath(root!))+sep;
        if(!Object.keys(revisions).length&&issue.check.revisionFingerprint){
          let current=this.projectHashes.get(root!);if(!current||Date.now()-current.at>5000){current={at:Date.now(),hash:await projectRevision(root!,[paths.dataRoot])};if(this.projectHashes.size>=64)this.projectHashes.delete(this.projectHashes.keys().next().value!);this.projectHashes.set(root!,current);}valid=current.hash===issue.check.revisionFingerprint;
        }

        let total=0;
        for(const [path,hash] of Object.entries(revisions).slice(0,64)){
          const actual=await realpath(path);if(!actual.startsWith(allowed)){valid=false;break;}
          const info=await stat(actual);total+=info.size;if(total>32*1024*1024||info.size>4*1024*1024){valid=false;break;}
          let entry=this.sourceHashes.get(actual);
          if(!entry||entry.mtime!==info.mtimeMs||entry.size!==info.size){entry={mtime:info.mtimeMs,size:info.size,hash:createHash('sha256').update(await readFile(actual)).digest('hex')};if(this.sourceHashes.size>=256)this.sourceHashes.delete(this.sourceHashes.keys().next().value!);this.sourceHashes.set(actual,entry);}
          if(entry.hash!==hash){valid=false;break;}
        }
      }catch{valid=false;}
      if(!valid){issue.verificationNote={message:'Доказательства устарели; требуется актуальная проверка.'};issue.check={...issue.check,status:'Not Verified',reason:'evidence-stale'};issue.verification='Not Verified';if(issue.status==='Verified'&&issue.statusSource!=='user')issue.status='Fixed';}
    }
    return document;
  }
  private add(document: VisualDocument, region: VisualRegion, chatId: string, projectId: string) {
    if(document.regions.length>=100)throw new Error('Region limit reached (100 per chat/project); remove old regions first');
    const source:'manual'|'automatic'=region.diagnostics.some(d=>d.startsWith('Responsive QA'))?'automatic':'manual';
    let issue=document.issues.find(i=>i.id===region.groupId);
    const opposite=document.issues.find(candidate=>candidate!==issue&&candidate.regionIds.length>0&&(candidate.source??(candidate.description.startsWith('Responsive QA candidate:')?'automatic':'manual'))!==source&&document.regions.some(existing=>existing.groupId===candidate.id&&sameVisualTarget(existing,region)));
    if(opposite){
      if(issue&&issue.regionIds.length===0){document.issues=document.issues.filter(candidate=>candidate.id!==issue!.id);}
      region.groupId=opposite.id;issue=opposite;
      if(source==='manual'&&region.areaName){issue.description=region.areaName;issue.generatedDescription=false;}
      issue.source=source==='manual'?'manual':issue.source??'automatic';
    }
    const previousSource=issue?.source??(issue?.description.startsWith('Responsive QA candidate:')?'automatic':undefined);
    region.conversationId=chatId;region.projectId=projectId;document.regions.push(region);
    if(!issue){issue={id:region.groupId,source,description:region.diagnostics.find(d=>d.startsWith('Responsive QA'))??'Visual issue candidate',severity:'suspect',status:'Detected',regionIds:[],route:region.route,suspectedSourceFiles:[],evidenceRefs:[],verification:'Not Verified'};document.issues.push(issue);}
    else if(source==='manual')issue.source='manual';
    issue.evidenceSources=[...new Set([...(issue.evidenceSources??[previousSource??source]),source])];
    if(!issue.route)issue.route=region.route;
    region.groupNumber=issue.number;region.color=issue.color;
    if(issue.check){issue.check={...issue.check,status:'Not Verified',reason:'selections-changed'};issue.verification='Not Verified';if(issue.status==='Verified'&&issue.statusSource!=='user')issue.status='Fixed';}
    issue.regionIds.push(region.id);issue.evidenceRefs.push(region.id);
    issue.suspectedSourceFiles=[...new Set([...issue.suspectedSourceFiles,...(region.sourceHints??[]).map(s=>s.path)])].slice(0,12);
  }
  async command(chatId: string, projectId: string, session: ProjectBrowserSession | undefined, command: VisualCommand) {
    if(!command||typeof command!=='object')throw new Error('Invalid visual command');
    if(!['reveal','display'].includes(command.action)&&!session)throw new Error('Open the current project browser first');
    if(!['selection','reveal','display'].includes(command.action))await session!.visualSelection(false,[]);
    let document=this.document(chatId,projectId);
    if(command.action==='display'){
      if(command.enabled!==undefined&&typeof command.enabled!=='boolean'||command.selectedIds!==undefined&&(!Array.isArray(command.selectedIds)||command.selectedIds.length>100||!command.selectedIds.every(id=>typeof id==='string')))throw new Error('Invalid visual display state');
      const display=await session?.visualDisplay(document.regions,command.enabled,command.selectedIds);
      return {...document,display};
    }else if(command.action==='workflow'){
      const issue=document.issues.find(i=>i.id===command.issueId);if(!issue||!['completed','disputed'].includes(command.state))throw new Error('Invalid area decision');
      issue.workflow={state:command.state,source:'user',at:new Date().toISOString(),runId:issue.runId};
      issue.events=[...(issue.events??[]),{at:issue.workflow.at,source:'user' as const,action:command.state}].slice(-30);
    }else if(command.action==='new-area'){
      if(document.issues.length>=100)throw new Error('Area limit reached');
      document.issues=document.issues.filter(i=>i.regionIds.length);this.activatedDrafts.delete(this.key(chatId,projectId));
      const draft:import('../../shared/visual-debugging').VisualIssue={id:'area-'+randomUUID(),explicit:true,number:document.nextAreaNumber,description:'Visual issue candidate',severity:'suspect',status:'Detected',regionIds:[],route:'',suspectedSourceFiles:[],evidenceRefs:[],verification:'Not Verified'};
      document.issues.push(draft);this.drafts.set(this.key(chatId,projectId),draft);
      normalizeVisualDocument(document);
    }else if(command.action==='color'){
      const area=document.issues.find(i=>i.id===command.areaId);if(!area||!/^#[a-fA-F0-9]{6}$/.test(command.color))throw new Error('Invalid area color');area.color=command.color;normalizeVisualDocument(document);
    }else if(command.action==='clear'){
      document.regions=[];document.issues=[];this.drafts.delete(this.key(chatId,projectId));
    }else if(command.action==='delete-area'){
      if(this.drafts.get(this.key(chatId,projectId))?.id===command.areaId)this.drafts.delete(this.key(chatId,projectId));
      document.regions=document.regions.filter(r=>r.groupId!==command.areaId);document.issues=document.issues.filter(i=>i.id!==command.areaId);
    }else if(command.action==='selection'){
      if(typeof command.enabled!=='boolean'||command.groupId&&!/^[a-zA-Z0-9_-]{1,64}$/.test(command.groupId))throw new Error('Invalid selection group');
      if(!command.enabled)this.drafts.delete(this.key(chatId,projectId));
      await session!.visualSelection(command.enabled,document.regions,async region=>{
        const latest=this.document(chatId,projectId);this.add(latest,region,chatId,projectId);normalizeVisualDocument(latest);this.drafts.delete(this.key(chatId,projectId));this.save(chatId,projectId,latest);await session!.visualDisplay(latest.regions);
      },command.groupId);
      if(command.enabled&&this.drafts.get(this.key(chatId,projectId))?.id===command.groupId)this.activatedDrafts.add(this.key(chatId,projectId));
    }else if(command.action==='reveal'||command.action==='navigate'){
      if(session)await session.visualDisplay(document.regions);
      const live=document.regions.find(r=>r.id===command.regionId);
      const region=live??this.db.visualRegionReference(chatId,projectId,command.regionId);if(!region)throw new Error('Unknown region');
      if(!live&&command.action==='navigate')throw new Error('Region deleted or unavailable');
      const view:import('../../shared/visual-debugging').VisualRegionView=!live?{regionId:region.id,url:region.url,currentUrl:session?.currentUrl,deleted:true,stale:true,needsNavigation:false,diagnostics:['Region deleted; historical evidence only. No live highlight or navigation.']}:command.action==='navigate'?await session!.visualNavigate(region):session?await session.visualReveal(region,document.regions.some(r=>r.groupId===region.groupId)?document.regions.filter(r=>r.groupId===region.groupId):[region]):{regionId:region.id,url:region.url,stale:false,needsNavigation:true,diagnostics:['Open the current project browser first']};
      if(region.screenshotPath){try{const path=await realpath(region.screenshotPath),cache=resolve(paths.cache,'browser-captures')+sep;if(path.startsWith(cache)&&(await stat(path)).size<=8_000_000)view.cropDataUrl='data:image/png;base64,'+(await readFile(path)).toString('base64');}catch{view.diagnostics.push('Saved crop unavailable');}}
      const latest=this.document(chatId,projectId);
      return {...latest,currentUrl:session?.currentUrl,view,display:await session?.visualDisplay(latest.regions)};
    }else if(command.action==='delete'){
      document.regions=document.regions.filter(r=>r.id!==command.regionId);
      for(const issue of document.issues){issue.regionIds=issue.regionIds.filter(id=>id!==command.regionId);issue.evidenceRefs=issue.evidenceRefs.filter(id=>id!==command.regionId);}
    }else if(command.action==='group'){
      if(!Array.isArray(command.regionIds)||command.regionIds.length>100||!/^[a-zA-Z0-9_-]{1,64}$/.test(command.groupId))throw new Error('Invalid region group');
      const moved=document.regions.filter(r=>command.regionIds.includes(r.id));
      document.regions=document.regions.filter(r=>!command.regionIds.includes(r.id));
      for(const issue of document.issues){issue.regionIds=issue.regionIds.filter(id=>!command.regionIds.includes(id));issue.evidenceRefs=issue.evidenceRefs.filter(id=>!command.regionIds.includes(id));}
      for(const r of moved){r.groupId=command.groupId;this.add(document,r,chatId,projectId);}
    }else if(command.action==='issue'){
      const issue=document.issues.find(i=>i.id===command.issueId);if(!issue||typeof command.description!=='string'||command.description.length>1000||command.rejected!==undefined&&typeof command.rejected!=='boolean'||command.status!==undefined&&!['Detected','Confirmed','In progress','Fixed','Unresolved'].includes(command.status))throw new Error('Invalid issue update; Verified requires Ledger evidence');
      if(issue.description!==command.description){issue.description=command.description;issue.generatedDescription=false;}
      if(command.status){issue.status=command.status;issue.statusSource='user';issue.rejected=command.rejected??false;issue.events=[...(issue.events??[]),{at:new Date().toISOString(),source:'user' as const,action:command.rejected?'rejected':'status',status:command.status}].slice(-30);}
    }else if(command.action==='recheck'){
      const issue=document.issues.find(i=>i.id===command.issueId);if(!issue)throw new Error('Unknown visual issue');
      const regions=document.regions.filter(r=>r.groupId===issue.id),first=regions[0];if(!first)throw new Error('No selections to recheck');
      const at=new Date().toISOString();let qa:import('../../shared/browser-qa').BrowserQaReport|undefined,reason:string|undefined;
      try{qa=await session!.visualRecheck(regions);}catch(error){reason=String(error);}
      this.projectHashes.delete(first.projectRoot);
      const failed=qa?.scenarios?.some(s=>s.status==='Failed'&&s.assertion.source==='text_fit'&&typeof s.observations.at(-1)?.value==='number'&&Number(s.observations.at(-1)?.value)>0);
      const pass=provesOriginalRegions(qa,regions),status=pass?'Verified':failed?'Failed':qa?.status==='Partially Verified'?'Partially Verified':'Not Verified';
      issue.check={status,reason:reason??qa?.reason??qa?.scenarios?.find(s=>s.reason)?.reason??(qa?.errors.length?'page-runtime-error':undefined),reportId:qa?.id,evidencePath:qa?.evidencePath,revisionFingerprint:qa?.revisionFingerprint,at,url:first.url,viewport:first.viewport};
      if(qa&&issue.logicalTaskId){
        const plan=this.db.getAgentPlan(chatId,issue.logicalTaskId),memory=plan?.taskMemory,ledger=memory?.verification;
        if(plan&&memory&&ledger){
          const id='ev-visual-'+randomUUID(),detail=JSON.stringify({reportId:qa.id,revisionFingerprint:qa.revisionFingerprint,status,scenarios:qa.scenarios}),paths=Object.keys(qa.sourceRevisions??{});
          ledger.records.push({id,kind:'browser',class:'functional',subject:'Visual region recheck '+issue.id,pass,epoch:ledger.epoch??0,run_serial:ledger.run_serial??0,unknown_epoch:ledger.unknown_epoch??0,turn:0,detail,check_key:'visual-recheck:'+issue.id,deliverable_ids:[issue.id],coverage:[],source_revisions:qa.sourceRevisions,checked_paths:paths,outcome:pass?'passed':status==='Failed'?'failed':'inconclusive',outcome_hash:createHash('sha256').update(detail).digest('hex')});
          // This observation does not redefine immutable acceptance criteria or mark a deliverable verified.
          this.db.saveAgentPlan(chatId,plan,issue.logicalTaskId);issue.check.ledgerId=id;issue.evidenceRefs=[...new Set([...issue.evidenceRefs,id])];
        }
      }
      if(!(issue.statusSource==='user'&&issue.status==='Unresolved')){issue.status=pass?'Verified':status==='Failed'?'Unresolved':issue.status==='Verified'?'Fixed':issue.status;issue.statusSource='check';}
      issue.verification=pass&&issue.check.ledgerId?'Ledger linked':'Not Verified';
      issue.events=[...(issue.events??[]),{at,source:'check' as const,action:status,evidenceId:issue.check.ledgerId??qa?.id}].slice(-30);
      if(session!.visualWorkspace)document.workspace=session!.visualWorkspace;

    }else if(command.action==='detect'){
      for(const region of await session!.visualDetect())this.add(document,region,chatId,projectId);
    }else throw new Error('Unknown visual command');
    if(!['selection','reveal','display'].includes(command.action)){
      document.issues=document.issues.filter(i=>i.regionIds.length||this.drafts.get(this.key(chatId,projectId))?.id===i.id);normalizeVisualDocument(document);this.save(chatId,projectId,document);
      await session!.visualSelection(false,[]);
    }
    document=this.document(chatId,projectId);const display=await session?.visualDisplay(document.regions);return {...document,display};
  }
}
