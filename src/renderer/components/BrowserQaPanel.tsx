import { useAppStore } from '../store/app-store';
import { useLocale } from '../use-locale';
import type { QaAssertion } from '../../shared/browser-qa';
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
  const deliverables=useAppStore(s=>s.agentPlan?.taskMemory?.deliverables?.items)??[];
  const report=status?.report??saved;
  const responsiveProgress=status?.phase==='complete'?undefined:status?.responsive;
  const visualProgress=status?.phase==='complete'?undefined:status?.visualLayout;
  const visualScenarios=report?.scenarios?.filter(s=>s.visualLayout)??[];
  const visualFindings=visualScenarios.flatMap(s=>s.visualLayout!.frames.flatMap(f=>f.findings));
  const responsiveScenarios=report?.scenarios?.filter(s=>s.viewport)??[];
  const responsiveViewportCount=new Set(responsiveScenarios.map(s=>`${s.viewport!.width}x${s.viewport!.height}`)).size;
  const responsiveIssues=responsiveScenarios.reduce((n,s)=>n+(s.responsive?.findings.length??0),0);
  const expectation=(a:QaAssertion)=>`${({equals:ru?'равно':'equals',changed:ru?'изменяется':'changes',increased:ru?'увеличивается':'increases',decreased:ru?'уменьшается':'decreases'})[a.operator]}${a.expected!==undefined?' '+String(a.expected):''}${a.sample_ms?' · '+(ru?'наблюдения во времени':'observations over time'):''}`;
  const reasonCode = report ? qaReasonCode(report) : undefined;
  const reasons = {
    QA_NO_PROGRESS: ru ? 'Повторная проверка не дала новых данных. Измените проект, сценарий или условия.' : 'Repeated QA produced no progress. Change the project, scenario or conditions.',
    QA_TIMEOUT: ru ? 'Проверка превысила время ожидания.' : 'This check timed out.',
    QA_TOOL_ERROR: ru ? 'Инструмент не смог завершить проверку.' : 'The tool could not complete this check.',
    VERIFICATION_INCOMPLETE: ru ? 'Недостаточно доказательств для подтверждения.' : 'Verification evidence is incomplete.',
    EVIDENCE_STALE: ru ? 'Нет свежей проверки текущей версии. Предыдущие доказательства сохранены.' : 'No fresh check of the current revision. Previous evidence is retained.',
    AUTH_REQUIRED: ru ? 'Требуется авторизация.' : 'Authentication required.',
    PRECONDITION_FAILED: ru ? 'Не выполнены условия сценария; действия не применялись.' : 'Scenario preconditions were not met; inputs were not delivered.',
    UNSUPPORTED_OPERATION: ru ? 'Операция недоступна в текущем состоянии приложения.' : 'The operation is unsupported in the current application state.',
    INCONCLUSIVE: ru ? 'Результат не установлен: наблюдений недостаточно для вывода.' : 'Inconclusive: the available observations do not establish the result.',
    FUNCTIONAL_REQUIREMENT_FAILED: ru ? 'Проверенное функциональное требование не выполнено.' : 'The tested functional requirement failed.',
    VISUAL_REQUIREMENT_FAILED: report?.scenarios?.some(s=>s.visualLayout?.status==='Failed')?(ru?'Заданное покрытие viewport нарушено; подтверждено измерениями.':'Declared viewport coverage failed; confirmed by measurements.'):ru ? 'Визуальное требование не подтверждено; оценка модели содержит неопределённость.' : 'The visual requirement was not confirmed; model assessment carries uncertainty.',
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
          {(responsiveProgress||responsiveScenarios.length>0)&&<small className="qa-responsive-status">Responsive QA · {responsiveProgress?`${responsiveProgress.viewport.width} × ${responsiveProgress.viewport.height} · ${responsiveProgress.checked}/${responsiveProgress.total}`:`${responsiveViewportCount} ${ru?'viewport проверено':'viewports checked'}`} · {responsiveProgress?.issues??responsiveIssues} {ru?'наблюдений':'findings'}</small>}
          {(visualProgress||visualScenarios.length>0)&&<small>Visual Layout QA · {visualProgress&&`${visualProgress.viewport.width} × ${visualProgress.viewport.height} · ${visualProgress.frames} ${ru?'кадров':'frames'} · `}{visualProgress?.suspected??visualFindings.filter(f=>f.status==='Suspected').length} {ru?'подозрений':'suspected'} · {visualProgress?.failures??visualFindings.filter(f=>f.status==='Failed').length} {ru?'нарушений':'failures'}</small>}
          <span role="status">{status ? phases[status.phase] : verificationLabel(report?.status ?? 'Not Verified', ru)}</span>
          {report && <small>{report.visual?.analyzed ? (ru ? 'Изображение проанализировано' : 'Image analyzed') : (ru ? 'Без визуального подтверждения' : 'No image confirmation')}</small>}
          {reason && <span className="qa-reason" role="status">{reason}</span>}
        </summary>
        {report && <div className="qa-report">
          <p>{report.functionalStatus && `${t('Функциональные проверки')}: ${verificationLabel(report.functionalStatus, ru)}. `}</p>
          {report.scenarios?.map(scenario=><section className="qa-scenario" key={scenario.id}>
            <strong>{scenario.goal}</strong><span>{verificationLabel(reasonCode==='EVIDENCE_STALE'?'Not Verified':scenario.status,ru)}</span>
            <p>{ru?'Где':'Where'}: {scenario.target}</p>
            {scenario.viewport&&<p>{ru?'Размер viewport':'Viewport'}: {scenario.viewport.width} × {scenario.viewport.height}{scenario.viewport.profile?` · ${scenario.viewport.profile}`:''}. {ru?'Эмуляция desktop Chromium; физическое мобильное устройство не проверялось.':'Desktop Chromium viewport emulation; no physical mobile device was tested.'}</p>}
            {scenario.visualLayout&&<div className="qa-visual-layout">
              <strong>Visual Layout QA · {reasonCode==='EVIDENCE_STALE'?(ru?'Устаревшие наблюдения':'Stale observations'):scenario.visualLayout.status==='Suspected'?(ru?'Требует проверки':'Suspected'):verificationLabel(scenario.status,ru)}</strong>
              <p>{ru?'Свойство':'Property'}: {scenario.visualLayout.property} · {scenario.visualLayout.selector??'body'}</p>
              {scenario.visualLayout.frames.map((frame,i)=><div key={frame.captureId}>
                <small>{frame.viewport.width} × {frame.viewport.height} · DPR {frame.dpr} · {ru?'Кадр':'Frame'} {i+1}</small>
                <ul>{frame.findings.map((f,j)=><li key={j}>{f.status==='Failed'?(ru?'Нарушение заданного покрытия':'Declared coverage failed'):(ru?'Подозрение; контекстная оценка':'Suspected; contextual review')} · {({'coverage':ru?'Покрытие viewport':'Viewport coverage','backing-store':ru?'Рисующая поверхность Canvas':'Canvas backing store','horizontal-seam':ru?'Горизонтальный шов':'Horizontal seam','vertical-seam':ru?'Вертикальный шов':'Vertical seam','resize-instability':ru?'Размеры ещё меняются':'Layout still changing'})[f.kind]} · {Math.round(f.region.x)}, {Math.round(f.region.y)} · {Math.round(f.region.width)} × {Math.round(f.region.height)} · {f.source==='pixels'?(ru?'пиксели':'pixels'):'DOM'}</li>)}</ul>
              </div>)}
              {scenario.visualLayout.comparison&&<p>{ru?'До / после':'Before / after'}: {scenario.visualLayout.comparison.matched?`${ru?'исчезло':'resolved'} ${scenario.visualLayout.comparison.resolved} · ${ru?'сохранилось':'persisting'} ${scenario.visualLayout.comparison.persisting} · ${ru?'новых кандидатов':'new candidates'} ${scenario.visualLayout.comparison.newCandidates}`:(ru?'Условия различаются — сравнение заблокировано':'Conditions differ — comparison blocked')}</p>}
              <small>{ru?'DOM, пиксельные кандидаты и Vision — разные источники. Результат относится только к указанному свойству; общая эстетика не подтверждена.':'DOM, pixel candidates and Vision are distinct sources. The result covers only the declared property; overall aesthetics are not certified.'}</small>
            </div>}
            {scenario.responsive&&<ul>{scenario.responsive.findings.map((finding,i)=><li key={i}><strong>{({ 'horizontal-overflow':ru?'Горизонтальное переполнение':'Horizontal overflow','viewport-fit':ru?'Выход за viewport':'Viewport fit',overlap:ru?'Перекрытие':'Overlap','text-clipping':ru?'Обрезание текста':'Text clipping','image-fit':ru?'Размер изображения':'Image fit' })[finding.kind]}</strong> · {finding.confidence==='confirmed'?(ru?'подтверждено DOM':'confirmed by DOM'):(ru?'кандидат; требуется проверка':'candidate; review needed')} · {finding.selector}</li>)}</ul>}
            {scenario.viewport&&<small>Vision: {scenario.visual?.analyzed?(ru?'Изображение проанализировано; оценка вероятностная':'Image analyzed; probabilistic assessment'):(ru?'Без анализа изображения':'No image analysis')}</small>}
            <p>{ru?'Ожидалось':'Expected'}: {expectation(scenario.assertion)}{scenario.observations.length>0&&<><br />{ru?'Получено':'Observed'}: {scenario.observations.map(o=>o.value===null?(ru?'данных нет':'unavailable'):String(o.value)).join(' → ')}</>}</p>
            {scenario.deliverableId&&<p>{ru?'Требование':'Deliverable'}: {deliverables.find(item=>item.id===scenario.deliverableId)?.text??scenario.goal}</p>}
            <small>{scenario.visualLayout?(ru?'DOM-измерения и пиксельные кандидаты; Vision отдельно':'DOM measurements and pixel candidates; Vision separate'):scenario.evidenceKind==='visual'?(ru?'Визуальные данные; вероятностная оценка':'Visual evidence; probabilistic assessment'):(ru?'Функциональные данные':'Functional evidence')}</small>
            {scenario.reason&&<p>{scenario.reasonCode ? reasons[scenario.reasonCode] : localizeMessage(scenario.reason)}</p>}
            <details><summary>{ru?'Ожидание, наблюдения и evidence':'Expectation, observations and evidence'}</summary>
              <p>{JSON.stringify(scenario.assertion)}</p><pre>{JSON.stringify(scenario.observations,null,2)}</pre>
              {scenario.visualLayout&&<pre>{JSON.stringify(scenario.visualLayout,null,2)}</pre>}
              {scenario.responsive&&<pre>{JSON.stringify(scenario.responsive,null,2)}</pre>}
              <small>{ru?'Сценарий':'Scenario'}: {scenario.id}{scenario.deliverableId&&<> · {scenario.deliverableId} / {scenario.criterionId}</>}</small>
              {scenario.preconditions.map((condition,i)=><p key={i}>{condition.expected} → {condition.actual} · {verificationLabel(condition.status,ru)}</p>)}
              {scenario.reason&&<p>{scenario.reason}</p>}
            </details>
          </section>)}
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
