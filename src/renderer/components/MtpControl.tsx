import { ReloadDialog } from './ReloadDialog';
import { ControlHelp } from './ControlHelp';
import { useEffect, useState } from 'react';
import type { MtpMode, MtpStatus } from '../../shared/types';
import { useLocale } from '../use-locale';
import { useAppStore } from '../store/app-store';
import { localizeMessage, t } from '../../shared/locale';

export function MtpControl({ modelId, onStatusChange }: { modelId: string | null | undefined; onStatusChange?: (status: MtpStatus | undefined) => void }) {
  const ru = useLocale() === 'ru';
  const chatId = useAppStore(state => state.activeId);
  const runtime = useAppStore(state => state.settings?.llamaRuntime);
  const models = useAppStore(state => state.models);
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
    const poll = () => { void window.localAi.mtp.status(modelId, chatId ?? undefined).then(value => { if (alive) setStatus(value); }).catch(reason => { if (alive) setError(String(reason)); }); };
    poll(); const interval = window.setInterval(poll, 4000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [modelId, chatId]);
  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);
  if (!modelId) return null;
  const reload = ru ? 'Для изменения требуется перезагрузка модели или контекста.' : 'Changing MTP requires a model/context reload.';
  const hint = t('Multi-Token Prediction ускоряет генерацию, предлагая несколько следующих токенов сразу. Нужна поддержка модели и runtime; функция может занять дополнительную память и требует перезагрузки.');
  const labels: Record<MtpStatus['effective'], string> = { unloaded: ru ? 'Модель не загружена' : 'Model unloaded', available: ru ? 'MTP доступен, не активен' : 'Available, inactive', active: t('MTP включён'), disabled: t('MTP выключен'), unsupported: t('MTP не поддерживается'), 'requires-weights': t('Нужны дополнительные веса'), 'reload-required': t('Нужна перезагрузка'), error: status?.capability.state === 'misconfigured' ? (ru ? 'Требуется настройка' : 'Needs configuration') : status?.capability.state === 'backend-unavailable' ? (ru ? 'Backend недоступен' : 'Backend unavailable') : (ru ? 'Возможности неизвестны' : 'Capability unknown') };
  const diagnostics = status?.diagnostics;
  const diagnosticsHint = diagnostics
    ? `${ru ? 'Принято' : 'Accepted'} ${diagnostics.accepted}/${diagnostics.drafted}${diagnostics.acceptanceRate === undefined ? '' : ` (${(100 * diagnostics.acceptanceRate).toFixed(1)}%)`}`
    : t('Статистика MTP доступна только когда её передаёт runtime.');
  const apply = async () => {
    if (!draft || generating) return;
    setBusy(true); setError(undefined);
    try { setStatus(await window.localAi.mtp.apply(modelId, draft, true, chatId ?? undefined)); setDraft(undefined); setConfirm(false); await useAppStore.getState().refreshRuntime(); }
    catch (reason) { setError(String(reason)); await useAppStore.getState().refreshRuntime(); }
    finally { setBusy(false); }
  };
  return <div className="mtp-control">
    <label className="control"><span>{t('MTP')} <small role="status" className="mtp-effective">{draft && !error && draft !== status?.activeMode ? t('Нужна перезагрузка') : status ? status.capability.state === 'unknown' && status.effective === 'unsupported' ? (ru ? 'Возможности неизвестны' : 'Capability unknown') : labels[status.effective] : ru ? 'Проверяется…' : 'Checking…'}</small></span><select aria-label={t('MTP')} disabled={generating || busy || !status || (!status.capability.supported && status.capability.status !== 'error' && status.capability.state !== 'unknown')} value={draft ?? status?.requested ?? 'auto'} onChange={event => { setDraft(event.target.value as MtpMode); setConfirm(true); setError(undefined); }}><option value="auto">Auto</option><option value="on" disabled={!status?.capability.supported}>On</option><option value="off">Off</option></select></label>
    <ControlHelp label={t('MTP')}>{hint} {ru?'Сохранённый выбор:':'Stored preference:'} {status?.requested??'—'}. {ru?'Активный MTP:':'Active MTP:'} {status?.effective==='active'?'On':status?.activeMode?'Off':(ru?'Модель не загружена':'Unloaded')}. {generating ? t('MTP нельзя изменить во время генерации; после ответа потребуется перезагрузка модели.') : reload} {status?.effective === 'active' ? t('Настройка применена runtime.') : status?.effective === 'unsupported' || status?.effective === 'disabled' ? t('Подсказка: MTP выключен или не поддерживается.') : ''} {localizeMessage(status?.capability.reason ?? '')} {localizeMessage(status?.error ?? '')} {diagnosticsHint}</ControlHelp>
    {confirm && <ReloadDialog title={ru ? 'Применение MTP' : 'Apply MTP'} busy={busy} disabled={generating || !draft || (draft === 'on' && !status?.capability.supported)} error={error ? localizeMessage(error) : undefined} onCancel={() => { setConfirm(false); setDraft(undefined); setError(undefined); }} onApply={() => void apply()}><p>{ru ? 'Если модель не загружена, выбор сохранится до её первой загрузки. Перезагрузка активной модели сохраняет задачу и историю. MTP не гарантирует ускорения.' : 'For an unloaded model, the choice is saved for its next load. Reloading an active model preserves the task and history. MTP does not guarantee acceleration.'}</p><dl className="reload-comparison"><dt>{ru?'Активная модель':'Active model'}</dt><dd>{runtime?.status === 'ready' ? models.find(m=>m.id===runtime.modelId)?.name ?? runtime.modelId : ru?'Не загружена':'Unloaded'}</dd><dt>{ru?'Целевая модель':'Target model'}</dt><dd>{models.find(m=>m.id===modelId)?.name ?? modelId}</dd><dt>{t('Контекст')}</dt><dd>{runtime?.modelId === modelId && runtime.contextWindow ? `${runtime.contextWindow / 1024}K → ${runtime.contextWindow / 1024}K` : '—'}</dd><dt>MTP</dt><dd>{status?.activeMode ?? '—'} → {draft}</dd></dl><p>{localizeMessage(status?.capability.reason ?? '')}</p></ReloadDialog>}
    {!confirm && error && <small role="alert">{localizeMessage(error)}</small>}
  </div>;
}
