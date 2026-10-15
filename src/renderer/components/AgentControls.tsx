import { t, tr, localizeMessage } from '../../shared/locale';
import { useLocale } from '../use-locale';
import { useEffect, useId, useRef, useState } from 'react';
import { Shield, ChevronDown } from 'lucide-react';
import { autonomyDescriptions, autonomyModes, normalizeAutonomyMode, type AgentPermissions, type LoopAction, type SessionGrant } from '../../shared/autonomy';
import { useAppStore } from '../store/app-store';

export function AgentControls() {
  useLocale();
  const id = useAppStore(s => s.activeId);
  const runId = useAppStore(s => s.generationId);
  const approval = useAppStore(s => s.pendingApproval);
  const telemetry = useAppStore(s => s.agentTelemetry);
  const [permissions, setPermissions] = useState<AgentPermissions>({ mode: 'strict', trusted_roots: [] });
  const [grants, setGrants] = useState<SessionGrant[]>([]);
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const refreshGrants = async () => setGrants(id && runId ? await window.localAi.chat.grants(id, runId) : []);
  useEffect(() => { let live = true; setOpen(false); setAdvanced(false); setError(''); if (id) void window.localAi.chat.permissions(id).then(p => { if (live) setPermissions({ ...p, mode: normalizeAutonomyMode(p.mode) }); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [id]);
  useEffect(() => { let live = true; if (id && runId) void window.localAi.chat.grants(id, runId).then(g => { if (live) setGrants(g); }); else setGrants([]); return () => { live = false; }; }, [id, runId, approval]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!container.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const change = async (mode: AgentPermissions['mode'], trust = false) => {
    if (!id) return; setBusy(true); setError('');
    try { setPermissions(await window.localAi.chat.setPermissions(id, mode, trust)); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const revoke = async (grantId?: string) => { if (!id || !runId) return; setBusy(true); try { await window.localAi.chat.revokeApprovals(id, runId, grantId); await refreshGrants(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const info = autonomyDescriptions[permissions.mode];
  return <div ref={container} className={`agent-controls autonomy-${permissions.mode}`} onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } }}>
    <button ref={trigger} type="button" className="autonomy-trigger" aria-expanded={open} aria-controls={descriptionId} aria-describedby={`${descriptionId}-tooltip`} disabled={!id} onClick={() => { setOpen(!open); void refreshGrants(); }}>
      <Shield size={14} /><span className="autonomy-dot" /><span>{t(info.name)}</span><ChevronDown size={12} />
    </button>
    <span className="autonomy-tooltip" role="tooltip" id={`${descriptionId}-tooltip`}>{localizeMessage(info.description)} {localizeMessage(info.risk)}</span>
    {open && <div className="autonomy-popover" id={descriptionId} role="dialog" aria-label={t("Автономность и разрешения агента")}>
      <strong>{t("Автономность агента")}</strong>
      {autonomyModes.map(mode => { const entry = autonomyDescriptions[mode]; return <div className={`autonomy-option autonomy-${mode}`} key={mode}>
        <button type="button" aria-pressed={permissions.mode === mode} disabled={busy} onClick={() => void change(mode)}><span className="autonomy-dot" />{t(entry.name)}{permissions.mode === mode ? ' ✓' : ''}</button>
        <p className="autonomy-description">{t(entry.description)}</p>{advanced && <details><summary>{t("Политика разрешений")}</summary><p>{t("Разрешено автоматически:")} {localizeMessage(entry.allowed)}</p><p>{t("Требуется разрешение:")} {localizeMessage(entry.approval)}</p><p>{localizeMessage(entry.risk)}</p></details>}
      </div>; })}
      <button className="agent-button" type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? t('Скрыть расширенные настройки') : t('Расширенные настройки')}</button>
      {advanced && <div className="autonomy-advanced">
      <strong>{tr`Разрешения сессии (${grants.length})`}</strong>
      <p>{approval ? t("Ожидается разрешение") : runId ? t("Сессия активна") : t("Нет активной сессии агента")}. {t("Разрешения истекают при завершении запуска.")}</p>
      {grants.map(grant => <div className="session-grant" key={grant.id}><span>{t('Разрешённая операция')}<small>{grant.root}</small><code>{grant.detail}</code></span><button className="agent-button" type="button" disabled={busy} onClick={() => void revoke(grant.id)}>{t("Отозвать")}</button></div>)}
      <button className="agent-button" type="button" disabled={busy || !grants.length} onClick={() => void revoke()}>{t("Отозвать все разрешения сессии")}</button>
      {telemetry && <details><summary>{t('Диагностика runtime')}</summary><p>{tr`Действия: ${telemetry.actions}; ходы: ${telemetry.turn}`}</p><p>{tr`Детектор циклов: ${telemetry.loopObservations ?? 0} наблюдений; ${telemetry.loopGuidance ?? 0} подсказок; ${telemetry.loopWarnings ?? 0} предупреждений; ${telemetry.loopPauses ?? 0} пауз`}</p></details>}
      </div>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}

export function LoopWarning() {
  useLocale();
  const notice = useAppStore(s => s.loopNotice);
  const paused = useAppStore(s => s.loopPaused);
  const id = useAppStore(s => s.activeId);
  const runId = useAppStore(s => s.generationId);
  const generating = useAppStore(s => s.isGenerating);
  const stop = useAppStore(s => s.stop);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pendingAction = useRef(false);
  if (!notice || !id || !runId || !generating) return null;
  const act = async (action: LoopAction) => { if (pendingAction.current) return; pendingAction.current = true; setBusy(true); setError(''); try { await window.localAi.chat.loopControl(id, runId, notice.signature, action); } catch (e) { setError(String(e)); } finally { pendingAction.current = false; setBusy(false); } };
  const repeated = /^.+ \((.*)\) returned the same (deterministic failure|observation) (\d+) times with unchanged arguments$/.exec(notice.evidence);
  const cycle = /^The same (\d+)-action sequence repeated (\d+) times without a new observation$/.exec(notice.evidence);
  const stalled = /^Recovery made no observable progress in (\d+) tool outcomes$/.exec(notice.evidence);
  const evidence = repeated ? tr`Одинаковый результат для ${repeated[1]} получен ${repeated[3]} раз.` : cycle ? tr`Последовательность из ${cycle[1]} действий повторилась ${cycle[2]} раз без нового наблюдения.` : stalled ? tr`После продолжения не было наблюдаемого прогресса за ${stalled[1]} действий.` : t('Повторяются действия без новых наблюдений. Проверьте технические детали.');
  return <section className="agent-loop-warning" role="status" aria-live="polite"><strong>{paused ? t("Агент приостановлен: повторяющийся цикл действий") : t("Возможен цикл действий")}</strong><p>{evidence}</p><details><summary>{t('Технические детали')}</summary><pre>{notice.evidence}</pre></details>
    {notice.repair_exhausted && <p>{t('Лимит попыток исправления исчерпан. Можно остановить агента или явно продолжить без исправления; детектор остаётся включён.')}</p>}
    <div>{paused ? <><button className="agent-button" disabled={busy || notice.repair_exhausted} onClick={() => void act('correct_resume')}>{t("Исправить и продолжить")}</button><button className="agent-button" disabled={busy} onClick={() => void act('continue_anyway')}>{t("Продолжить без исправления")}</button><button className="agent-button" onClick={() => void stop()}>{t("Стоп")}</button></> : <><button className="agent-button" disabled={busy || notice.repair_exhausted} onClick={() => void act('correct')}>{t("Автоматическое исправление")}</button><button className="agent-button" disabled={busy} onClick={() => void act('continue')}>{t("Продолжить")}</button><button className="agent-button" disabled={busy} onClick={() => void act('pause')}>{t("Пауза")}</button></>}</div>
    {error && <p role="alert">{error}</p>}
    {busy && <p className="loop-control-pending" role="status">{t('Обработка действия восстановления…')}</p>}
  </section>;
}
