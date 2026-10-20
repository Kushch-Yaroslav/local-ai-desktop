import { useAppStore } from '../store/app-store';
import { useLocale } from '../use-locale';
import { t } from '../../shared/locale';
import { permissionPresentation } from '../../shared/agent-presentation';
import { ShieldCheck, Copy, Check } from 'lucide-react';
import { ProjectBadge } from './ProjectBadge';
import { useEffect, useState } from 'react';

export function ApprovalPanel() {
  useLocale();
  const pending = useAppStore(state => state.pendingApproval);
  const submitting = useAppStore(state => state.approvalSubmitting);
  const approve = useAppStore(state => state.approveAction);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => { setCopied(false); setCopyError(false); }, [pending?.approval.approvalId]);
  if (!pending) return null;
  const { approval } = pending;
  const presentation = permissionPresentation(approval.category, approval.detail);
  const command = approval.category === 'system_command' || approval.category.startsWith('git_') || approval.category.startsWith('shell_') || approval.category.startsWith('package_');
  const copy = async () => { try { await navigator.clipboard.writeText(approval.detail ?? ''); setCopied(true); setCopyError(false); } catch { setCopyError(true); } };
  return <section className="approval-panel" role="alertdialog" aria-modal="false" aria-label={t('Разрешение на операцию')} aria-busy={submitting}>
    <header><ShieldCheck size={19} /><strong>{presentation.title}</strong><span className="permission-risk">{presentation.destructive ? t('Удаление данных') : t('Требуется разрешение')}</span></header>
    <p>{presentation.description}</p>
    {approval.root && <ProjectBadge path={approval.root} tabIndex={0} />}
    {command && <div className="permission-command"><pre>{approval.detail}</pre><button className="agent-button" onClick={() => void copy()} aria-label={t('Копировать команду')}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t('Скопировано') : t('Копировать')}</button></div>}
    {copyError && <p role="alert">{t('Не удалось скопировать')}</p>}
    {!command && approval.detail && <details><summary>{t('Технические детали')}</summary><pre>{approval.detail}</pre></details>}
    <p className="permission-scope">{t('Один раз — для текущего вызова. В этой сессии — для того же действия, проекта и origin в текущем чате до отзыва, смены области или режима и закрытия приложения.')}</p>
    <div className="permission-actions">
      <button className="agent-button primary" disabled={submitting} onClick={() => void approve('once')}>{t('Разрешить один раз')}</button>
      <button className="agent-button" disabled={submitting} onClick={() => void approve('session')}>{t('Всегда разрешать в этой сессии')}</button>
      <button className="agent-button danger" disabled={submitting} onClick={() => void approve('reject')}>{t('Отклонить')}</button>
    </div>
  </section>;
}
