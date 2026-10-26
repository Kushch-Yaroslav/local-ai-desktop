import type { VerificationState, AgentPlan, DeliverableItem, PlanStepItem, ToolActivity, VerificationRecord } from './types';

export function evidenceFresh(record:VerificationRecord, ledger:VerificationState):boolean {
  if(record.source_revisions && Object.keys(record.source_revisions).length)return record.run_serial===ledger.run_serial && record.unknown_epoch===ledger.unknown_epoch && Object.entries(record.source_revisions).every(([path,hash])=>ledger.revisions?.[path]===hash);
  return record.kind==='readback'?(ledger.changed?.[record.check_key||record.subject]??0)<=record.epoch:record.epoch===ledger.epoch;
}
export function criterionStatus(item:DeliverableItem,criterion:NonNullable<DeliverableItem['criteria']>[number],ledger?:VerificationState):'Verified'|'Failed'|'Partially Verified'|'Not Verified'|'Stale' {
  if(!ledger)return 'Not Verified';
  const coverage=(record:VerificationRecord)=>record.coverage?.filter(c=>c.deliverable_id===item.id&&c.criterion_id===criterion.id&&c.kind===criterion.kind)??[];
  const implementation=(record:VerificationRecord)=>criterion.kind==='implementation'&&record.kind==='readback'&&Boolean(item.proof?.includes(record.id));
  const relevant=ledger.records.filter(record=>coverage(record).length||implementation(record));
  const fresh=relevant.filter(record=>evidenceFresh(record,ledger));
  if(fresh.some((record,index)=>!record.pass&&(!record.outcome||record.outcome==='failed')&&!fresh.slice(index+1).some(later=>later.pass&&later.kind===record.kind&&(later.check_key||later.subject)===(record.check_key||record.subject))))return 'Failed';
  if(fresh.some(record=>record.pass&&(implementation(record)||coverage(record).some(c=>!c.qualified))))return 'Verified';
  if(fresh.some(record=>coverage(record).some(c=>c.qualified)))return 'Partially Verified';
  return relevant.length&&!fresh.length?'Stale':'Not Verified';
}

/** Explain the remaining formal step without promoting an observation to proof. */
export function deliverableVerificationNote(item:DeliverableItem,ledger?:VerificationState):{message:string;criteria?:string}|undefined {
  if(!['implemented','done'].includes(item.status))return;
  if(item.failing)return {message:'Проверка требования не пройдена.'};
  if(item.criteria?.length){
    const pending=item.criteria.filter(c=>criterionStatus(item,c,ledger)!=='Verified');
    if(!pending.length)return {message:'Все критерии пройдены. Агент ещё не подтвердил требование через deliverables.verify.'};
    const stale=pending.some(c=>criterionStatus(item,c,ledger)==='Stale');
    const failed=pending.some(c=>criterionStatus(item,c,ledger)==='Failed');
    return {message:failed?'Обязательные критерии не пройдены.':stale?'Доказательства устарели; требуется актуальная проверка.':'Не все обязательные критерии подтверждены.',criteria:pending.map(c=>c.id).join(', ')};
  }
  if(ledger?.records.some(r=>r.outcome==='observed_css'&&r.deliverable_ids?.includes(item.id)&&evidenceFresh(r,ledger)))return {message:'Записано свежее наблюдение CSS; формальная проверка требования не выполнялась.'};
  return {message:'Нет подходящего свежего доказательства для требования.'};
}

/** Presentation only: the task-memory ledger is authoritative, including empty lists.
 * Older saved chats can still display their legacy model-todo/milestone plan. */
export type AgentStatusStep = Omit<PlanStepItem, 'status'> & { status: PlanStepItem['status'] | 'abandoned' };
export function agentStatus(plan: AgentPlan | null): { steps: AgentStatusStep[]; deliverables: DeliverableItem[]; warnings: VerificationRecord[]; checks: VerificationRecord[] } {
  const legacy = plan?.modelTodo?.phases.flatMap((phase) => phase.items)
    ?? plan?.milestones?.flatMap((milestone) => milestone.workPlan.tasks.map((task) => ({ id: task.id, content: task.label, status: task.status })))
    ?? plan?.steps?.map((step) => ({ id: step.id, content: step.label, status: step.status })) ?? [];
  const ledger = plan?.taskMemory?.verification;
  const checks = ledger?.records.filter(record=>evidenceFresh(record,ledger)) ?? [];
  const warnings = checks.filter((record, index) => !record.pass && (!record.outcome||record.outcome==='failed') && !checks.slice(index + 1).some((later) => later.pass && later.kind === record.kind && (later.check_key || later.subject) === (record.check_key || record.subject)));
  return {
    steps: plan?.taskMemory?.plan?.steps ?? legacy.map((step) => ({ id: step.id, text: step.content, status: step.status })),
    deliverables: plan?.taskMemory?.deliverables?.items ?? [],
    checks,
    warnings,
  };
}

/** Successful status snapshots belong in the current panel, not a repeated timeline card.
 * Errors remain chronological so a rejected planning operation is still visible. */
export const isStatusSnapshot = (activity: ToolActivity): boolean => activity.kind === 'planning' && (activity.detail === 'plan' || activity.detail === 'deliverables');

/** Runtime semantics, not tool counts, determine whether task telemetry is useful. */
export function showAgentStatus(plan: AgentPlan | null, recovery = false): boolean {
  const { steps, deliverables, warnings } = agentStatus(plan);
  return Boolean(steps.length || deliverables.length || warnings.length || recovery && Boolean(plan) || plan?.taskMemory?.verification?.code_changed);
}
