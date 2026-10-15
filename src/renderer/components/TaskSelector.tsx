import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Folder, Plus, RotateCcw, X } from 'lucide-react';
import type { AgentTaskSummary } from '../../shared/types';
import { t } from '../../shared/locale';
import { useLocale } from '../use-locale';
import { useAppStore } from '../store/app-store';

const folder = (path: string) => path.replace(/\/$/, '').split('/').at(-1) || path;

export function TaskSelector() {
  useLocale();
  const { id, selectedId, label, choose, owner, generationId, runs } = useAppStore(useShallow(state => ({ id: state.activeId, selectedId: state.continuationTaskId, label: state.continuationLabel, choose: state.selectTaskContinuation, owner: state.generationConversationId, generationId: state.generationId, runs: state.analysisRuns })));
  const [catalog, setCatalog] = useState<{ id: string | null; tasks: AgentTaskSummary[]; failed?: boolean }>({ id: null, tasks: [] });
  const current = [...runs].reverse().find(run => run.conversationId === id && !run.archived);
  const runningId = owner === id && current?.generationId === generationId ? current?.logicalTaskId : undefined;
  const selected = runningId ?? selectedId;
  // Refresh at attempt boundaries, never on every tool/output event.
  const boundary = `${current?.id ?? ''}:${current?.status ?? ''}`;
  useEffect(() => {
    let alive = true;
    if (!id) return;
    void (window.localAi.agentTasks?.list(id, selected ?? undefined) ?? Promise.resolve([]))
      .then(tasks => { if (alive) setCatalog({ id, tasks }); })
      .catch(() => { if (alive) setCatalog({ id, tasks: [], failed: true }); });
    return () => { alive = false; };
  }, [id, selected, boundary]);
  const tasks = catalog.id === id ? catalog.tasks : [];
  const task = tasks.find(item => item.logicalTaskId === selected);
  const busy = Boolean(owner);
  const title = task?.title || label || t('Задача');
  return <section className={`task-selector ${selected ? 'continuing' : 'new-task'}`} aria-label={t('Задача следующего сообщения')}>
    <div className="task-selector-heading" role="status">
      {selected ? <RotateCcw size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
      <strong>{owner === id ? t('Уточнение текущей задачи') : selected ? t('Следующее сообщение: продолжение задачи') : t('Следующее сообщение: новая задача')}</strong>
    </div>
    <div className="task-selector-row">
      <select aria-label={t('Выбрать задачу')} disabled={busy} value={selected ?? ''} onChange={event => { const target = tasks.find(item => item.logicalTaskId === event.target.value); choose(target?.logicalTaskId ?? null, target?.title); }}>
        <option value="">{owner === id ? t('Уточнение текущей задачи') : t('Новая задача')}</option>
        {selected && !task && <option value={selected}>{title}</option>}
        {tasks.map(item => <option value={item.logicalTaskId} key={item.logicalTaskId}>{item.title || t('Задача')}{item.projects.length ? ` · ${item.projects.map(project => folder(project.path)).join(', ')}` : ''}</option>)}
      </select>
      {selectedId && !busy && <button type="button" className="task-selector-reset" onClick={() => choose(null)}><X size={14} />{t('Новая задача')}</button>}
    </div>
    {selected && <div className="task-selector-project" title={task?.projects.map(project => `${project.path}${project.id ? ` (${project.id})` : ''}`).join('\n')}>
      <Folder size={14} aria-hidden="true" />{task?.projects.length ? task.projects.map(project => project.path).join(' · ') : t('Проект не указан')}
    </div>}
    {catalog.id === id && catalog.failed && <small role="status">{t('Не удалось загрузить список задач. Кнопки продолжения доступны в истории.')}</small>}
  </section>;
}
