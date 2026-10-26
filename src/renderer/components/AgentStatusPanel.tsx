import { useLocale } from '../use-locale';
import { t } from '../../shared/locale';
import { memo, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentPlan } from '../../shared/types';
import { agentStatus, showAgentStatus, criterionStatus, deliverableVerificationNote } from '../../shared/agent-status';
import { agentStatusText, deliverableStatusLabel, planStatusLabel } from '../../shared/localization';
import { useAppStore } from '../store/app-store';

const planMarker = { skipped: '–', pending: '○', in_progress: '●', completed: '✓', blocked: '⊘', abandoned: '–' } as const;
const resultMarker = { pending: '○', implemented: '◐', done: '◐', verified: '✓', blocked: '⊘', dropped: '–' } as const;

/** Subscribes only to the current chat's planning projection, never token/clock updates. */
export function CurrentAgentStatus() {
  useLocale();
  const { activeId, plan, agent, running, recovery } = useAppStore(useShallow((state) => ({ activeId: state.activeId, plan: state.agentPlan, running: state.isGenerating, recovery: state.messages.at(-1)?.thinkingTimeline?.at(-1)?.kind === 'paused' || state.generationState === 'cancelled' || state.generationState === 'error' || state.analysisRuns.filter(run => run.conversationId === state.activeId).at(-1)?.status === 'interrupted', agent: state.conversations.find((chat) => chat.id === state.activeId)?.mode === 'agent' })));
  return agent && activeId && running ? <AgentStatusPanel plan={plan} running={running} recovery={recovery} /> : null;
}

export const AgentStatusPanel = memo(function AgentStatusPanel({ plan, running = false, recovery = false, initialExpanded = false }: { plan: AgentPlan | null; running?: boolean; recovery?: boolean; initialExpanded?: boolean }) {
  const ru=useLocale()==='ru';
  const [expanded, setExpanded] = useState(initialExpanded);
  const contentId = useId();
  const { steps, deliverables, checks, warnings } = agentStatus(plan);
  if (!showAgentStatus(plan, recovery)) return null;
  const completed = steps.filter((step) => step.status === 'completed').length;
  const verified = deliverables.filter((item) => item.status === 'verified').length;
  const total = deliverables.filter((item) => item.status !== 'dropped').length;
  return <section className="agent-status-panel" aria-label={agentStatusText.panel}>
    <button type="button" className="agent-status-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>
      <ChevronDown size={16} aria-hidden="true" />
      {!running && <span>{agentStatusText.saved}</span>}
      {!steps.length && !deliverables.length && !warnings.length && <span>{t("Работа над задачей")}</span>}
      {steps.length > 0 && <span><strong>{agentStatusText.plan}</strong> {completed}/{steps.length}</span>}
      {steps.length > 0 && deliverables.length > 0 && <span aria-hidden="true">·</span>}
      {deliverables.length > 0 && <span><strong>{agentStatusText.result}</strong> {verified}/{total}</span>}{deliverables.some(item => item.status === 'implemented' || item.status === 'done') && <span>{t('Реализовано, не проверено')}: {deliverables.filter(item => item.status === 'implemented' || item.status === 'done').length}</span>}{deliverables.some(item => item.status === 'blocked') && <span>{t('Заблокировано')}: {deliverables.filter(item => item.status === 'blocked').length}</span>}
      {warnings.length > 0 && <span>{agentStatusText.warnings}: {warnings.length}</span>}
    </button>
    {expanded && <div id={contentId} className="agent-status-content">
      <p className="agent-status-explanation">{ru?'План отражает выполненные действия. Качество результата подтверждают критерии и относящиеся к ним проверки. Статусы функционального QA и Vision независимы.':'The plan tracks completed actions. Acceptance criteria and their relevant checks establish result quality. Functional QA and Vision are independent.'}</p>
      {steps.length > 0 && <section aria-label={agentStatusText.plan}><h3>{agentStatusText.plan}<small>{completed}/{steps.length}</small></h3>
        <ol>{steps.map((step) => <li key={step.id} className={step.status} aria-current={running && step.status === 'in_progress' ? 'step' : undefined}>
          <i aria-hidden="true">{planMarker[step.status]}</i><span>{step.text}{step.note && <small>{step.note}</small>}</span><small className="agent-status-label">{!running && step.status === 'in_progress' ? agentStatusText.unfinishedStep : planStatusLabel[step.status]}</small>
        </li>)}</ol>
      </section>}
      {deliverables.length > 0 && <section aria-label={agentStatusText.deliverables}><h3>{agentStatusText.deliverables}<small>{verified}/{total}</small></h3>
        <ul>{deliverables.map((item) => {const note=deliverableVerificationNote(item,plan?.taskMemory?.verification);return <li key={item.id} className={item.status}>
          <i aria-hidden="true">{resultMarker[item.status]}</i><span>{item.text}{note&&<small>{t(note.message)} {note.criteria}</small>}{item.criteria?.map(criterion=><small key={criterion.id}>{criterion.description} — {({Verified:ru?'Проверено':'Verified',Failed:ru?'Не пройдено':'Failed','Partially Verified':ru?'Частично проверено':'Partially verified','Not Verified':ru?'Нет доказательств':'No evidence',Stale:ru?'Устарело':'Stale'})[criterionStatus(item,criterion,plan?.taskMemory?.verification)]}</small>)}{(item.reason || item.failing) && <small>{item.reason || item.failing}</small>}{item.status === 'verified' && checks.filter((record) => record.pass && item.proof?.includes(record.id)).map((record) => <small key={record.id}>{record.subject} — {agentStatusText.passed}</small>)}</span><small className="agent-status-label">{(item.status === 'implemented' || item.status === 'done') && checks.some(record => record.pass && record.deliverable_ids?.includes(item.id)) ? t('Частично проверено') : deliverableStatusLabel[item.status]}</small>
        </li>;})}</ul>
      </section>}
      {warnings.length > 0 && <section aria-label={agentStatusText.warnings}><h3>{agentStatusText.warnings}<small>{warnings.length}</small></h3><ul>{warnings.map((record) => <li key={record.id} className="implemented"><i aria-hidden="true">!</i><span>{record.subject}<small>{record.baseline_failure ? agentStatusText.preExisting : record.baseline ? agentStatusText.baseline : agentStatusText.failed}{record.deliverable_ids?.length ? ` · ${record.deliverable_ids.join(', ')}` : ''}{record.detail ? ` · ${record.detail}` : ''}</small></span><small className="agent-status-label">{record.id}</small></li>)}</ul></section>}
    </div>}
  </section>;
});
