import type { ToolActivity } from './types';
import { localizeMessage, t } from './locale';

/** Presentation follows the current round, never accumulated message length. */
export function progressIndicatorLabel(state: string, activities: ToolActivity[], agent = false): string | null {
  if (state === 'thinking') {
    const last=activities.at(-1);
    if(!agent&&last?.state==='error'&&last.metadata?.chatSource===true)return `${t('Обработка источника не завершена')} · ${localizeMessage(last.detail??'')}`;
    return 'Ожидаю ответ модели…';
  }
  if (state === 'stopping') return 'Останавливаю';
  if (state === 'waiting-for-approval') return agent ? null : 'Ожидает подтверждения';
  if (state === 'using-tool' || state === 'running-terminal') {
    // Agent already presents running tools in its timeline.
    if (agent) return null;
    const current=activities.findLast((activity) => activity.state === 'running' && activity.kind !== 'progress');
    return current?.metadata?.documentReading===true&&current.detail?`${t(current.label)} · ${current.detail.split(' · ').map(localizeMessage).join(' · ')}`:current?.label ?? 'Использую инструмент';
  }
  return null;
}
