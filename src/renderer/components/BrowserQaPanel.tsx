import { useAppStore } from '../store/app-store';
import { useLocale } from '../use-locale';
import { ScanEye } from 'lucide-react';
export function BrowserQaPanel() {
  const ru=useLocale()==='ru',activeId=useAppStore(s=>s.activeId),status=useAppStore(s=>activeId?s.qaStatuses[activeId]:undefined),saved=useAppStore(s=>s.agentPlan?.taskMemory?.browser_qa);
  const report=status?.report??saved;
  if(!status&&!report)return null;
  const phases={started:ru?'Browser QA запущен':'Browser QA started',capturing:ru?'Захват изображения':'Capturing screenshot',analyzing:ru?'Анализ изображения':'Analyzing image',interacting:ru?'Проверка взаимодействий':'Running interaction tests',issue:ru?'Обнаружена проблема':'Issue detected',fixing:ru?'Применение исправления':'Applying fix',retesting:ru?'Повторная проверка':'Retesting',complete:report?.status??'Not Verified'};
  return <details className={`browser-qa-panel ${report?.status==='Failed'?'qa-failed':''}`}><summary><ScanEye size={16}/><strong>Browser QA</strong><span role="status">{status?phases[status.phase]:report?.status}</span>{report&&<small>{report.visual?.analyzed?(ru?'Изображение проанализировано':'Image analyzed'):(ru?'Без визуального подтверждения':'No image confirmation')}</small>}</summary>
    {report&&<div className="qa-report"><p>{report.functionalStatus && `${ru?'Функциональные проверки':'Functional checks'}: ${report.functionalStatus}. `}{report.reason}</p>{report.checks?.map((check,index)=><div className="qa-check" key={index}><b>{check.status==='Verified'?'✓':check.status==='Failed'?'×':'◷'} {check.action}</b><span>{check.status}</span><p>{ru?'Ожидалось':'Expected'}: {check.expected}<br/>{ru?'Получено':'Observed'}: {check.actual}</p></div>)}<p>{report.visual?.summary??report.visual?.reason}</p>{report.visual?.issues?.map((issue,index)=><p key={index}>{issue.severity} · {Math.round(issue.confidence*100)}% · {issue.description}<br/>{issue.evidence}</p>)}<small>{report.url} · {report.elapsedMs?.toFixed(0)} ms<br/>{report.evidencePath}</small></div>}
  </details>;
}
