import { ReloadDialog } from './ReloadDialog';
import { ControlHelp } from './ControlHelp';
import { useEffect, useState } from 'react';
import type { MtpMode, MtpStatus } from '../../shared/types';
import { useLocale } from '../use-locale';
import { useAppStore } from '../store/app-store';

export function MtpControl({ modelId, onStatusChange }: { modelId: string | null | undefined; onStatusChange?: (status: MtpStatus | undefined) => void }) {
  const ru = useLocale() === 'ru';
  const generating = useAppStore(state => Boolean(state.generationOwnerId));
  const [status, setStatus] = useState<MtpStatus>();
  const [draft, setDraft] = useState<MtpMode>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setStatus(undefined); setDraft(undefined); setConfirm(false); setError(undefined);
    if (!modelId) return;
    let alive = true;
    const poll = () => { void window.localAi.mtp.status(modelId).then(value => { if (alive) setStatus(value); }).catch(reason => { if (alive) setError(String(reason)); }); };
    poll(); const interval = window.setInterval(poll, 4000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [modelId]);
  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);
  if (!modelId) return null;
  const reload = ru ? 'Для изменения требуется перезагрузка модели или контекста.' : 'Changing MTP requires a model/context reload.';
  const hint = ru ? 'MTP использует дополнительные предсказания токенов для потенциального ускорения генерации. Эффективность зависит от модели и backend.' : 'MTP predicts additional tokens to potentially accelerate generation. Results depend on the model and backend.';
  const labels: Record<MtpStatus['effective'], string> = { active: 'Active', disabled: 'Disabled', unsupported: 'Unsupported', 'requires-weights': 'Requires additional weights', 'reload-required': 'Reload required', error: 'Error' };
  const diagnostics = status?.diagnostics;
  const details = [hint, reload, generating ? (ru ? 'Дождитесь завершения ответа или остановите задачу.' : 'Wait for completion or Stop the task.') : '', status?.capability.reason, status?.error,
    diagnostics ? `MTP · server lifetime: ${diagnostics.accepted}/${diagnostics.drafted} accepted${diagnostics.acceptanceRate === undefined ? '' : ` (${(100 * diagnostics.acceptanceRate).toFixed(1)}%)`}` : 'MTP acceptance: unavailable before backend counters are available.'].filter(Boolean).join('\n');
  const apply = async () => {
    if (!draft || generating) return;
    setBusy(true); setError(undefined);
    try { setStatus(await window.localAi.mtp.apply(modelId, draft, true)); setDraft(undefined); setConfirm(false); await useAppStore.getState().refreshRuntime(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="mtp-control" title={details}>
    <label className="control"><span title="Multi-Token Prediction · Reload Required">MTP ⟳ <small role="status" className="mtp-effective">{draft && draft !== status?.activeMode ? 'Reload required' : status ? labels[status.effective] : '…'}</small></span><select aria-label="Multi-Token Prediction (MTP)" disabled={generating || busy || !status} value={draft ?? status?.requested ?? 'auto'} onChange={event => { setDraft(event.target.value as MtpMode); setConfirm(true); setError(undefined); }}><option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option></select></label>
    <ControlHelp label="MTP · Reload Required">{hint+' '+reload}</ControlHelp>
    {confirm && <ReloadDialog title={ru ? 'Применение MTP' : 'Apply MTP'} busy={busy} disabled={generating} error={error} onCancel={() => { setConfirm(false); setDraft(undefined); setError(undefined); }} onApply={() => void apply()}><p>{ru ? 'Незагруженная модель: выбор сохранится для следующей загрузки. Перезагрузка активной модели сохраняет задачу и историю. MTP не гарантирует ускорения.' : 'For an unloaded model, the choice is saved for its next load. Reloading an active model preserves the task and history. MTP does not guarantee acceleration.'}</p><p>{status?.capability.reason}</p></ReloadDialog>}
    {!confirm && error && <small role="alert">{error}</small>}
  </div>;
}
