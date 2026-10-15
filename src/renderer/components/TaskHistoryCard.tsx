import { memo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentPlan, AnalysisRun } from '../../shared/types';
import { agentStatus } from '../../shared/agent-status';
import { t } from '../../shared/locale';
import { useLocale } from '../use-locale';
import { useAppStore } from '../store/app-store';
import { AgentStatusPanel } from './AgentStatusPanel';

/** This card reads only a frozen attempt snapshot, never the active checkpoint. */
export const TaskHistoryCard = memo(function TaskHistoryCard({ plan, logicalTaskId, status, archived = false }: { plan: AgentPlan; logicalTaskId?: string; status?: AnalysisRun['status']; archived?: boolean }) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  const { busy, select } = useAppStore(useShallow(state => ({ busy: Boolean(state.generationConversationId), select: state.selectTaskContinuation })));
  const { steps, deliverables } = agentStatus(plan);
  const verified = deliverables.filter(item => item.status === 'verified').length;
  const total = deliverables.filter(item => item.status !== 'dropped').length;
  const completed = steps.filter(step => step.status === 'completed').length;
  const legacy = logicalTaskId?.startsWith('legacy:');
  const label = steps[0]?.text ?? deliverables[0]?.text ?? t('Задача');
  return <section className="task-history-card" data-task-id={logicalTaskId} aria-label={t('История задачи')}>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {archived ? t('Предыдущая попытка') : legacy ? t('Сохранённый план чата (старый формат)') : t('План и результаты задачи')}
      {steps.length > 0 && <>{' · '}{t('Шаги плана')}: {completed}/{steps.length}</>}
      {deliverables.length > 0 && <>{' · '}{t('Проверено результатов')}: {verified}/{total}</>}
    </button>
    {expanded && <>
      <p>{legacy ? t('Принадлежность старого плана отдельным запросам неизвестна. Его проверки не используются в новых задачах.') : t('Статус проверки на момент этого ответа. Продолжение создаёт новый снимок.')}</p>
      <AgentStatusPanel plan={plan} initialExpanded recovery={status === 'cancelled' || status === 'interrupted' || status === 'error'} />
    </>}
    {logicalTaskId && !legacy && <button type="button" disabled={busy} onClick={() => select(logicalTaskId, label)}>{t('Продолжить эту задачу')}</button>}
  </section>;
});
