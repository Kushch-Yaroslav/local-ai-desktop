import { useLocale } from '../use-locale';
import { t, tr, localizeMessage } from '../../shared/locale';
import { memo, useEffect, useMemo, useState } from 'react';
import { activityPresentation } from '../../shared/agent-presentation';
import type { ChatMessage, DeliverableItem, PlanStepItem, TerminalExecution, ThinkingTimelineEvent, ToolActivity } from '../../shared/types';
import { Markdown } from './Markdown';
import { isStatusSnapshot } from '../../shared/agent-status';
import { thinkingTimeline } from '../../shared/thinking-timeline';
import { formatDuration, pluralRu } from '../../shared/localization';

type Props = { timeline?: ThinkingTimelineEvent[]; activities: ToolActivity[]; messages: ChatMessage[]; reasoning?: string; streaming: boolean; now: number; error?: string; cancelled?: boolean };

const elapsed = (start?: string, end?: string, now = Date.now()) => {
  if (!start || !Number.isFinite(Date.parse(start)) || (end && !Number.isFinite(Date.parse(end)))) return null; const seconds = Math.max(0, Math.round(((end ? new Date(end).getTime() : now) - new Date(start).getTime()) / 1000));
  return formatDuration(seconds);
};

type StructuredEntry = { path?: unknown; name?: unknown; id?: unknown; status?: unknown; truncated?: unknown; message?: unknown };
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
function entryLine(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) return JSON.stringify(entry);
  if (!entry || typeof entry !== 'object') return entry === null ? 'entry' : String(entry);
  const value = entry as StructuredEntry;
  const label = text(value.path) ?? text(value.name) ?? text(value.id) ?? 'entry';
  const status = text(value.status);
  const message = text(value.message);
  return [label, status && status !== 'ok' ? status : undefined, value.truncated === true ? t("обрезано") : undefined, message].filter(Boolean).join(' · ');
}
function structuredEntries(result: unknown): unknown[] | undefined {
  return result && typeof result === 'object' && !Array.isArray(result) && Array.isArray((result as { entries?: unknown }).entries) ? (result as { entries: unknown[] }).entries : undefined;
}
const deliverableMarker = { verified: '✓', implemented: '◐', done: '◐', blocked: '⊘', pending: '○', dropped: '–' } as const;
const planMarker = { skipped: '–', completed: '✓', in_progress: '▶', blocked: '⊘', pending: '○' } as const;
/** The requested-deliverables list from a `deliverables` tool result, as a checklist.
 * Only `verified` counts as checked; `implemented` is shown as not yet verified. */
export function deliverablesChecklist(output: string | undefined): { lines: string[]; verified: number; implemented: number; open: number; total: number } | undefined {
  if (!output) return undefined;
  try {
    const items = (JSON.parse(output) as { deliverables?: { items?: DeliverableItem[] } }).deliverables?.items;
    if (!Array.isArray(items)) return undefined;
    const live = items.filter((item) => item.status !== 'dropped');
    const note = (item: DeliverableItem) => item.status === 'blocked' && item.reason ? tr` — не выполнено: ${localizeMessage(item.reason)}`
      : (item.status === 'implemented' || item.status === 'done') ? tr` — реализовано, не проверено${item.failing ? tr`; проверка не прошла: ${item.failing}` : ''}` : '';
    return {
      lines: live.map((item) => `${deliverableMarker[item.status] ?? '○'} ${item.text}${note(item)}`),
      verified: live.filter((item) => item.status === 'verified').length,
      implemented: live.filter((item) => item.status === 'implemented' || item.status === 'done').length,
      open: live.filter((item) => item.status === 'pending').length, total: live.length,
    };
  } catch { return undefined; }
}
/** The agent's own execution plan from a `plan` tool result. */
export function planChecklist(output: string | undefined): { lines: string[]; completed: number; total: number } | undefined {
  if (!output) return undefined;
  try {
    const steps = (JSON.parse(output) as { plan?: { steps?: PlanStepItem[] } }).plan?.steps;
    if (!Array.isArray(steps)) return undefined;
    return { lines: steps.map((step) => `${planMarker[step.status] ?? '○'} ${step.text}${(step.status === 'blocked' || step.status === 'skipped') && step.note ? ` — ${step.note}` : ''}`), completed: steps.filter((step) => step.status === 'completed').length, total: steps.length };
  } catch { return undefined; }
}
export function toolResultSummary(activity: ToolActivity): string | undefined {
  const checklist = activity.detail === 'deliverables' ? deliverablesChecklist(activity.output) : undefined;
  if (checklist) return tr`проверено ${checklist.verified} из ${checklist.total}${checklist.implemented ? tr` · реализовано, не проверено ${checklist.implemented}` : ''}${checklist.open ? tr` · осталось ${checklist.open}` : ''}`;
  const plan = activity.detail === 'plan' ? planChecklist(activity.output) : undefined;
  if (plan) return tr`шагов выполнено ${plan.completed} из ${plan.total}`;
  if (activity.kind === 'directory') {
    try { const entries = structuredEntries(JSON.parse(activity.output ?? '')); return entries ? `${entries.length} ${pluralRu(entries.length, t("элемент"), t("элемента"), t("элементов"))}` : activity.detail; } catch { return activity.detail; }
  }
  return activity.detail;
}
export function displayToolResult(activity: ToolActivity): string | undefined {
  if (!activity.output) return undefined;
  const checklist = activity.detail === 'deliverables' ? deliverablesChecklist(activity.output) : undefined;
  if (checklist) return checklist.lines.join('\n');
  const plan = activity.detail === 'plan' ? planChecklist(activity.output) : undefined;
  if (plan) return plan.lines.join('\n');
  try {
    const result = JSON.parse(activity.output) as { command?: string; stdout?: string; stderr?: string; exit_code?: number; status?: string; timed_out?: boolean; cancelled?: boolean; content?: string };
    if (activity.kind === 'terminal') return `${result.command ? `$ ${result.command}\n` : ''}${result.status === 'partial_success' ? t("✓ частичный результат поиска (следующая команда закрыла канал после вывода)") : result.exit_code === 0 ? t("✓ код выхода 0") : result.exit_code !== undefined ? tr`✗ код выхода ${result.exit_code}` : ''}${result.timed_out ? t(" · превышено время") : ''}${result.cancelled ? t(" · отменено") : ''}${result.stdout ? `\n${result.stdout}` : ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
    if (typeof result.content === 'string') return result.content;
    const entries = structuredEntries(result);
    if (entries) return entries.map(entryLine).join('\n');
    return JSON.stringify(result, null, 2);
  } catch { /* Streaming tool output is already presentation text. */ }
  return activity.output;
}

function TerminalDetails({ terminal, fallback }: { terminal?: TerminalExecution; fallback?: string }) {
  useLocale();
  if (!terminal) return fallback ? <><h4>{t("Диагностика")}</h4><pre>{fallback}</pre></> : null;
  const status = terminal.status === 'completed' ? t("✓ завершено") : terminal.status === 'partial_success' ? t("✓ частичный результат поиска (следующая команда закрыла канал после вывода)") : terminal.status === 'cancelled' ? t("Отменено") : terminal.status === 'timed_out' ? t("Превышено время") : terminal.status === 'error' ? t("Ошибка") : t("Выполняется");
  return <>
    {terminal.command && <details className="terminal-command" open><summary>{t("Команда")}</summary><pre>{terminal.command}</pre></details>}
    <h4>{t("Диагностика")}</h4><pre>{[terminal.cwd && tr`каталог: ${terminal.cwd}`, terminal.pid && tr`pid: ${terminal.pid} · pgid: ${terminal.pgid ?? '—'} · сессия: ${terminal.sessionId ?? '—'}`, terminal.startedAt && tr`начато: ${terminal.startedAt}`, terminal.finishedAt && tr`завершено: ${terminal.finishedAt}`, tr`статус: ${status}`, terminal.exitCode !== null && terminal.exitCode !== undefined && tr`код выхода: ${terminal.exitCode}`, terminal.timedOut && t("превышено время: да"), terminal.cancelled && t("отменено: да")].filter(Boolean).join('\n')}</pre>
    {terminal.stdout && <><h4>{t("Стандартный вывод")}</h4><pre>{terminal.stdout}</pre></>}
    {terminal.stderr && <><h4>{t("Вывод ошибок")}</h4><pre>{terminal.stderr}</pre></>}
  </>;
}

/** Raw terminal output is persisted unchanged. In advanced details show fields
 * not already represented by the command/result blocks, including failure codes
 * and pipeline statuses. Do not pretty-print a second copy of large stdout. */
function terminalExtras(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const shown = new Set(['command', 'cwd', 'pid', 'pgid', 'session_id', 'started_at', 'finished_at', 'exit_code', 'timed_out', 'cancelled', 'status', 'stdout', 'stderr']);
    const remaining = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !shown.has(key) && key !== 'execution'));
    return { ...remaining(parsed), ...(parsed.execution && typeof parsed.execution === 'object' ? { execution: remaining(parsed.execution as Record<string, unknown>) } : {}) };
  } catch { return undefined; }
}

const Action = memo(function Action({ activity }: { activity: ToolActivity }) {
  useLocale();
  // A logical tool row is mounted on `started` then updated in place. Starting
  // it expanded made completed directory/read outputs remain giant cards; only
  // errors open themselves automatically.
  const [expanded, setExpanded] = useState(activity.state === 'error');
  const state = activity.state === 'error' ? '✗' : activity.state === 'completed' ? '✓' : '↳';
  const diff = activity.metadata?.diff;
  const output = expanded && !(activity.kind === 'terminal' && activity.terminal) ? displayToolResult(activity) : undefined;
  const presentation = activityPresentation(activity);
  const summary = presentation.context ?? (activity.kind === 'progress' ? activity.detail : undefined);
  const started = activity.kind === 'terminal' ? activity.terminal?.startedAt : activity.startedAt;
  const finished = activity.terminal?.finishedAt ?? activity.finishedAt;
  const running = activity.state === 'running' && !finished && (activity.kind !== 'terminal' || activity.terminal?.status === 'running');
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!running || !started) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, started]);
  const duration = elapsed(started, finished, clock);
  const hasBody = Boolean(activity.output || diff || activity.terminal || activity.arguments || activity.metadata);
  // The canonical command remains in TerminalDetails. Keep every other argument
  // in diagnostics, without repeating this same string under a JSON key.
  const terminalMetadata = expanded && activity.kind === 'terminal' ? terminalExtras(activity.rawOutput ?? activity.output) : undefined;
  const displayedCommand = activity.terminal?.command ?? (typeof activity.arguments?.command === 'string' && activity.output?.includes(JSON.stringify(activity.arguments.command)) ? activity.arguments.command : undefined);
  const diagnosticArguments = expanded && activity.kind === 'terminal' && displayedCommand
    ? Object.fromEntries(Object.entries(activity.arguments ?? {}).filter(([key, value]) => !(key === 'command' && value === displayedCommand)))
    : activity.arguments;
  return <section data-action-id={activity.id} className={`agent-timeline-action ${activity.kind ?? 'other'} ${activity.state ?? 'running'} ${expanded ? 'expanded' : ''}`}><button type="button" className="agent-timeline-action-head" onClick={() => hasBody && setExpanded((value) => !value)} aria-expanded={hasBody ? expanded : undefined}><b>{state} {presentation.title}</b>{summary && <span>{summary}</span>}{duration && <small className="action-elapsed">{duration}</small>}{running && <em>{started && <span className="terminal-running-indicator" aria-hidden="true" />}{t(started ? 'выполняется…' : 'Ожидание запуска')}</em>}</button>{activity.progress && <progress aria-label={t('Загрузка файла')} value={activity.progress.bytes} max={activity.progress.total ?? undefined} />}{expanded && <div className="agent-timeline-action-body">{activity.kind === 'context' && activity.metadata && <dl className="compaction-details"><dt>{t('Лимит контекста')}</dt><dd>{activity.metadata.context_window}</dd><dt>{t('Порог компактизации')}</dt><dd>{activity.metadata.trigger_threshold_tokens ?? "—"}</dd><dt>{t('Резерв ответа')}</dt><dd>{activity.metadata.preferred_output_tokens}</dd><dt>{t('Причина')}</dt><dd>{activity.metadata.trigger_reason === 'proactive_threshold' ? t('Проактивный порог') : activity.metadata.trigger_reason === 'output_capacity' ? t('Недостаточно места для ответа') : t('Ограничение контекста')}</dd></dl>}{activity.kind === 'terminal' ? <TerminalDetails terminal={activity.terminal} fallback={output} /> : output && <pre>{output}</pre>}{typeof diff === 'string' && <details><summary>{t("Изменения")}</summary><pre>{diff}</pre></details>}<details><summary>{t('Технические детали')}</summary><pre>{JSON.stringify({ tool: activity.toolName ?? activity.detail, arguments: diagnosticArguments, metadata: activity.metadata, ...(terminalMetadata ? { result: terminalMetadata } : {}) }, null, 2)}</pre></details></div>}</section>;
});

/** A finished thought never changes, so memoization on its primitive props skips it on every later frame. */
const Thought = memo(function Thought({ content, live, title, duration }: { content: string; live: boolean; title: string; duration: string | null }) {
  useLocale();
  const [expanded, setExpanded] = useState(true);
  return <section className="agent-timeline-thought"><header><button type="button" className="agent-timeline-action-head" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><b>{title}</b>{live && duration && <span>· {duration}</span>}</button></header>{expanded && <Markdown streaming={live} lazy>{content}</Markdown>}</section>;
});

export const AgentTimeline = memo(function AgentTimeline({ timeline, activities, messages, reasoning, streaming, now, error, cancelled }: Props) {
  useLocale();
  const items = useMemo(() => thinkingTimeline(reasoning, activities, streaming, timeline, messages, true), [reasoning, activities, streaming, timeline, messages]);
  if (!items.length && !error && !cancelled) return null;
  return <div className="agent-timeline">{items.map((item) => {
    if (item.kind === 'reasoning') {
      if (!item.content.trim()) return null;
      const duration = elapsed(item.startedAt, item.completedAt, now);
      // Only the paragraph still being written is live; later paragraphs of a finished thought carry no completion time.
      const live = streaming && item.live;
      return <Thought key={item.id} content={item.content} live={live} title={live ? t("Размышляет") : duration ? tr`Размышлял ${duration}` : t("Размышление")} duration={live ? duration : null} />;
    }
    if (item.kind === 'steering') return <section className={`agent-timeline-steering ${item.status}`} key={item.id}><header><b>{item.status === 'applied' ? t("Уточнение передано модели") : t("Уточнение в очереди")}</b>{item.status === 'accepted' && <span> {t(" — будет передано модели на следующем шаге")}</span>}</header><p>{item.message.content}</p></section>;
    if (item.kind === 'paused') return <section className="agent-timeline-steering paused" key={item.id}><header><b>{t("Работа на паузе")}</b></header><p>{t("Состояние и список невыполненного сохранены. Напишите «Продолжить», чтобы возобновить работу.")}</p></section>;
    if (item.kind === 'loop') {
      const labels = { soft_recovery: t('Предупреждение о повторении передано модели; контекст сохранён'), context_excluded: t('Повторяющийся участок исключён из контекста модели; история сохранена'), detected: t('Обнаружено повторение действий'), paused: t('Агент приостановлен: повторяющийся цикл действий'), repair_requested: t('Запрошено исправление стратегии'), recovery_attempted: t('Изменение стратегии передано модели'), recovery_succeeded: t('После продолжения появился прогресс'), recovery_failed: t('Продолжение не дало прогресса'), continued: t('Продолжено без исправления; детектор включён') };
      return <section className={`agent-timeline-steering loop-event ${item.lifecycle.stage}`} key={item.id} data-loop-stage={item.lifecycle.stage}><header><b>{item.lifecycle.stage === 'detected' && item.lifecycle.notice.level >= 2 ? item.lifecycle.notice.level >= 3 ? t('Подтверждён повторяющийся цикл') : t('Подозрение на повторяющийся цикл') : labels[item.lifecycle.stage]}</b></header>{item.lifecycle.stage === 'context_excluded' && <p>{item.lifecycle.notice.evidence}</p>}{item.lifecycle.notice.repair_exhausted && <p>{t('Лимит попыток исправления исчерпан. Можно остановить агента или явно продолжить без исправления; детектор остаётся включён.')}</p>}<details><summary>{t('Технические детали')}</summary><pre>{JSON.stringify(item.lifecycle, null, 2)}</pre></details></section>;
    }
    return isStatusSnapshot(item.activity) && item.activity.state !== 'error' ? null : <Action key={item.id} activity={item.activity} />;
  })}{error && <section className="agent-timeline-terminal error" role="status"><b>{t("Агент остановлен из-за ошибки")}</b><span>{localizeMessage(error)}</span></section>}{cancelled && <section className="agent-timeline-terminal cancelled" role="status"><b>{t("Агент остановлен")}</b></section>}</div>;
});
