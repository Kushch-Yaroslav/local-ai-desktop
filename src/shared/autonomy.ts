export const autonomyModes = ['strict', 'autonomous'] as const;
// Legacy values are accepted at the IPC boundary, never offered as modes.
export type AutonomyMode = typeof autonomyModes[number] | 'trusted' | 'absolute_autopilot';
export const normalizeAutonomyMode = (mode: AutonomyMode): 'strict' | 'autonomous' => mode === 'strict' ? 'strict' : 'autonomous';
export type AgentPermissions = { mode: typeof autonomyModes[number]; trusted_roots: string[] };
export type SessionGrant = { id: string; category: string; root?: string; detail: string };
export type LoopNotice = { signature: string; level: number; evidence: string; guidance: string; repair_exhausted?: boolean };
export type LoopLifecycleStage = 'detected' | 'paused' | 'repair_requested' | 'recovery_attempted' | 'recovery_succeeded' | 'recovery_failed' | 'continued' | 'soft_recovery' | 'context_excluded';
export type LoopLifecycle = { stage: LoopLifecycleStage; notice: LoopNotice; attempt: number };
export function isLoopLifecycle(value: unknown): value is LoopLifecycle {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>, notice = item.notice as Partial<LoopNotice> | undefined;
  return ['detected', 'paused', 'repair_requested', 'recovery_attempted', 'recovery_succeeded', 'recovery_failed', 'continued', 'soft_recovery', 'context_excluded'].includes(String(item.stage))
    && Number.isSafeInteger(item.attempt) && Number(item.attempt) >= 0
    && Boolean(notice) && typeof notice?.signature === 'string' && typeof notice.evidence === 'string' && typeof notice.guidance === 'string'
    && [1,2,3].includes(Number(notice.level));
}
export type LoopAction = 'correct' | 'continue' | 'pause' | 'correct_resume' | 'continue_anyway';
export const autonomyDescriptions: Record<typeof autonomyModes[number], { name: string; description: string; allowed: string; approval: string; risk: string }> = {
  strict: { name: 'Запрашивать подтверждение', description: 'Максимальный контроль: изменения и запуск кода требуют разрешения.', allowed: 'Чтение, ls, cat, grep, git status', approval: 'Правки файлов, сборка, тесты, установки, Git-изменения', risk: 'Разрешённые команды могут исполнять код проекта.' },
  autonomous: { name: 'Абсолютный автопилот', description: 'Разрешённые действия выполняются без подтверждений в текущем scope задачи.', allowed: 'Чтение, правки, сборка и тесты в выбранном проекте', approval: 'Внешние операции и обязательные запреты блокируются; для ручного разрешения предусмотрен режим подтверждений', risk: 'Зависимости и скрипты могут менять данные без отдельных запросов.' },
};
