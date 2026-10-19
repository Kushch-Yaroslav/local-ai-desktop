import { useAppStore } from '../store/app-store';
import { useLocale } from '../use-locale';
import { qaReasonCode } from '../../shared/browser-qa';
import { ScanEye } from 'lucide-react';
import { t } from '../../shared/locale';
import { localizeMessage } from '../../shared/locale';
import { ControlHelp } from './ControlHelp';

const verificationLabel = (status: string, ru: boolean) => {
  void ru;
  if (status === 'Verified') return t('Проверено');
  if (status === 'Partially Verified') return t('Частично проверено');
  if (status === 'Failed') return t('Не прошла');
  if (status === 'Blocked') return t('Заблокировано');
  return t('Не проверено');
};

export function BrowserQaPanel() {
  const ru=useLocale()==='ru',activeId=useAppStore(s=>s.activeId),status=useAppStore(s=>activeId?s.qaStatuses[activeId]:undefined),saved=useAppStore(s=>s.agentPlan?.taskMemory?.browser_qa);
  const report=status?.report??saved;
  const reasonCode = report ? qaReasonCode(report) : undefined;
  const reasons = {
    QA_NO_PROGRESS: ru ? 'Повторная проверка не дала новых данных. Измените проект, сценарий или условия.' : 'Repeated QA produced no progress. Change the project, scenario or conditions.',
    QA_TIMEOUT: ru ? 'Проверка превысила время ожидания.' : 'This check timed out.',
    QA_TOOL_ERROR: ru ? 'Инструмент не смог завершить проверку.' : 'The tool could not complete this check.',
    VERIFICATION_INCOMPLETE: ru ? 'Недостаточно доказательств для подтверждения.' : 'Verification evidence is incomplete.',
    EVIDENCE_STALE: ru ? 'Нет свежей проверки текущей версии. Предыдущие доказательства сохранены.' : 'No fresh check of the current revision. Previous evidence is retained.',
    AUTH_REQUIRED: ru ? 'Требуется авторизация.' : 'Authentication required.',
    PERMISSION_REQUIRED: ru ? 'Требуется разрешение на браузер.' : 'Browser permission required.',
  };
  const reason = reasonCode ? reasons[reasonCode] : localizeMessage(report?.reason ?? '');
  if(!status&&!report)return null;
  const phases={started:t('Проверка браузера началась'),capturing:t('Захват снимка'),analyzing:t('Анализ изображения'),interacting:t('Проверка действий на странице'),issue:t('Обнаружена проблема'),fixing:t('Исправление проблемы'),retesting:t('Повторная проверка'),complete:verificationLabel(report?.status??'Not Verified',ru)};
  const summary = t('Показывает текущий этап проверки браузера и её результат. Результат основан на собранных данных; это не визуальная проверка, если анализ изображения явно не отмечен.');
  const outcomes = t('Проверено — проверка прошла с подтверждением. Частично проверено — прошла только часть. Ошибка — найдена проблема; Заблокировано — проверку нельзя выполнить; Не проверено — данных недостаточно.');
  const visual = report?.visual?.analyzed ? t('Изображение проверено означает, что совместимая модель действительно получила и проанализировала снимок. Без этого интерфейс не считается визуально проверенным.') : t('Подсказка: QA без анализа изображения.');
  return (
    <div className="browser-qa-panel-wrap">
      <details className={`browser-qa-panel ${report?.status === 'Failed' ? 'qa-failed' : ''}`}>
        <summary>
          <ScanEye size={16} />
          <strong>{t('Браузерная проверка')}</strong>
          <span role="status">{status ? phases[status.phase] : verificationLabel(report?.status ?? 'Not Verified', ru)}</span>
          {report && <small>{report.visual?.analyzed ? (ru ? 'Изображение проанализировано' : 'Image analyzed') : (ru ? 'Без визуального подтверждения' : 'No image confirmation')}</small>}
          {reason && <span className="qa-reason" role="status">{reason}</span>}
        </summary>
        {report && <div className="qa-report">
          <p>{report.functionalStatus && `${t('Функциональные проверки')}: ${verificationLabel(report.functionalStatus, ru)}. `}</p>
          {report.checks?.map((check, index) => <div className="qa-check" key={index}>
            <b>{check.status === 'Verified' ? '✓' : check.status === 'Failed' ? '×' : '◷'} {check.action}</b>
            <span>{verificationLabel(check.status, ru)}</span>
            <ControlHelp label={t('Итог проверки')}>{outcomes}</ControlHelp>
            <p>{t('Ожидалось')}: {localizeMessage(check.expected)}<br />{t('Получено')}: {localizeMessage(check.actual)}</p>
          </div>)}
          <div className="qa-visual-status"><strong>{report.visual?.summary ?? localizeMessage(report.visual?.reason ?? '')}</strong><ControlHelp label={t('Визуальная проверка')}>{visual}</ControlHelp></div>
          {report.visual?.issues?.map((issue, index) => <p key={index}>{issue.severity} · {Math.round(issue.confidence * 100)}% · {issue.description}<br />{issue.evidence}</p>)}
          {report.errors?.map((error,index)=><p key={index} className="qa-error">{localizeMessage(error)}</p>)}
          {reasonCode && report.reason && <details><summary>{ru?'Диагностика':'Diagnostics'}</summary><p>{report.reason}</p><code>{reasonCode}</code></details>}
          <small>{report.url}{Number.isFinite(report.elapsedMs) ? ` · ${report.elapsedMs.toFixed(0)} ms` : ''}{report.evidencePath && <><br />{report.evidencePath}</>}</small>
        </div>}
      </details>
      <ControlHelp label={t('Браузерная проверка')}>{`${summary} ${outcomes} ${visual}`}</ControlHelp>
    </div>
  );
}
