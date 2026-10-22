import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { paths } from './paths';
import { randomUUID } from 'node:crypto';
import { normalizeVisualDocument } from '../../shared/visual-debugging';
import type { Database } from './database';
import type { ProjectBrowserSession } from '../web/project-browser';
import type { VisualCommand, VisualDocument, VisualRegion } from '../../shared/visual-debugging';

/** Chat-local evidence, not long-term memory and not a second Verification Ledger. */
export class VisualDebugging {
  constructor(private readonly db: Database) {}
  document(chatId: string, projectId: string) {
    const raw=this.db.visualDocument(chatId,projectId),before=JSON.stringify(raw);
    const document=normalizeVisualDocument(raw);if(JSON.stringify(document)!==before)this.db.saveVisualDocument(chatId,projectId,document);
    for(const issue of document.issues){
      if(!issue.logicalTaskId)continue;
      const memory=this.db.getAgentPlan(chatId,issue.logicalTaskId)?.taskMemory;
      const item=memory?.deliverables?.items.find(d=>d.id===issue.id);
      const ledger=memory?.verification;
      const records=ledger?.records.filter(r=>r.pass&&r.class==='functional'&&r.epoch===ledger.epoch&&r.run_serial===ledger.run_serial&&r.unknown_epoch===ledger.unknown_epoch&&r.coverage?.some(c=>c.deliverable_id===issue.id&&c.qualified===false))??[];
      if(item&&['verified','done'].includes(item.status)&&item.criteria?.length&&item.criteria.every(c=>records.some(r=>r.coverage?.some(v=>v.deliverable_id===issue.id&&v.criterion_id===c.id&&v.qualified===false)))){
        issue.status='Verified';issue.verification='Ledger linked';issue.evidenceRefs=[...issue.regionIds,...records.map(r=>r.id)];
      }else if(item?.status==='implemented'||issue.status==='Verified'){issue.status='Fixed';issue.verification='Not Verified';}
      if(item?.paths)issue.suspectedSourceFiles=item.paths.slice(0,12);
    }
    return document;
  }
  private add(document: VisualDocument, region: VisualRegion, chatId: string, projectId: string) {
    if(document.regions.length>=100)throw new Error('Region limit reached (100 per chat/project); remove old regions first');
    region.conversationId=chatId;region.projectId=projectId;document.regions.push(region);
    let issue=document.issues.find(i=>i.id===region.groupId);
    if(!issue){issue={id:region.groupId,description:region.diagnostics.find(d=>d.startsWith('Responsive QA'))??'Visual issue candidate',severity:'suspect',status:'Detected',regionIds:[],route:region.route,suspectedSourceFiles:[],evidenceRefs:[],verification:'Not Verified'};document.issues.push(issue);}
    if(!issue.route)issue.route=region.route;
    region.groupNumber=issue.number;region.color=issue.color;
    issue.regionIds.push(region.id);issue.evidenceRefs.push(region.id);
    issue.suspectedSourceFiles=[...new Set([...issue.suspectedSourceFiles,...(region.sourceHints??[]).map(s=>s.path)])].slice(0,12);
  }
  async command(chatId: string, projectId: string, session: ProjectBrowserSession | undefined, command: VisualCommand) {
    if(!command||typeof command!=='object')throw new Error('Invalid visual command');
    if(command.action!=='reveal'&&!session)throw new Error('Open the current project browser first');
    if(!['selection','reveal'].includes(command.action))await session!.visualSelection(false,[]);
    let document=normalizeVisualDocument(this.db.visualDocument(chatId,projectId));
    if(command.action==='new-area'){
      if(document.issues.length>=100)throw new Error('Area limit reached');
      document.issues.push({id:'area-'+randomUUID(),explicit:true,number:document.nextAreaNumber,description:'Visual issue candidate',severity:'suspect',status:'Detected',regionIds:[],route:'',suspectedSourceFiles:[],evidenceRefs:[],verification:'Not Verified'});
      normalizeVisualDocument(document);
    }else if(command.action==='color'){
      const area=document.issues.find(i=>i.id===command.areaId);if(!area||!/^#[a-fA-F0-9]{6}$/.test(command.color))throw new Error('Invalid area color');area.color=command.color;normalizeVisualDocument(document);
    }else if(command.action==='delete-area'){
      document.regions=document.regions.filter(r=>r.groupId!==command.areaId);document.issues=document.issues.filter(i=>i.id!==command.areaId);
    }else if(command.action==='selection'){
      if(typeof command.enabled!=='boolean'||command.groupId&&!/^[a-zA-Z0-9_-]{1,64}$/.test(command.groupId))throw new Error('Invalid selection group');
      await session!.visualSelection(command.enabled,document.regions,async region=>{
        const latest=this.document(chatId,projectId);this.add(latest,region,chatId,projectId);normalizeVisualDocument(latest);this.db.saveVisualDocument(chatId,projectId,latest);
      },command.groupId);
    }else if(command.action==='reveal'||command.action==='navigate'){
      const region=document.regions.find(r=>r.id===command.regionId)??this.db.visualRegionReference(chatId,projectId,command.regionId);if(!region)throw new Error('Unknown region');
      const view:import('../../shared/visual-debugging').VisualRegionView=command.action==='navigate'?await session!.visualNavigate(region):session?await session.visualReveal(region,document.regions.some(r=>r.groupId===region.groupId)?document.regions.filter(r=>r.groupId===region.groupId):[region]):{regionId:region.id,url:region.url,stale:false,needsNavigation:true,diagnostics:['Open the current project browser first']};
      if(region.screenshotPath){try{const path=await realpath(region.screenshotPath),cache=resolve(paths.cache,'browser-captures')+sep;if(path.startsWith(cache)&&(await stat(path)).size<=8_000_000)view.cropDataUrl='data:image/png;base64,'+(await readFile(path)).toString('base64');}catch{view.diagnostics.push('Saved crop unavailable');}}
      return {...this.document(chatId,projectId),currentUrl:session?.currentUrl,view};
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
      const issue=document.issues.find(i=>i.id===command.issueId);if(!issue||typeof command.description!=='string'||command.description.length>1000||!['Detected','Confirmed','In progress','Fixed','Unresolved'].includes(command.status))throw new Error('Invalid issue update; Verified requires Ledger evidence');
      issue.description=command.description;issue.status=command.status;
    }else if(command.action==='detect'){
      for(const region of await session!.visualDetect())this.add(document,region,chatId,projectId);
    }else throw new Error('Unknown visual command');
    if(!['selection','reveal'].includes(command.action)){
      document.issues=document.issues.filter(i=>i.regionIds.length||i.explicit);normalizeVisualDocument(document);this.db.saveVisualDocument(chatId,projectId,document);
      await session!.visualSelection(false,[]);
    }
    document=this.document(chatId,projectId);return document;
  }
}
