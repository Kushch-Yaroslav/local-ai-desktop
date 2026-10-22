import {t,tr} from './locale';
import type {VisualIssue,VisualIssueStatus} from './visual-debugging';
export const areaLabel=(number:number|undefined)=>tr`Область ${number??'?'}`;
const statuses:Record<VisualIssueStatus,string>={Detected:'Обнаружено',Confirmed:'Подтверждено','In progress':'В работе',Fixed:'Исправлено',Verified:'Проверено',Unresolved:'Не решено'};
export const visualStatusLabel=(status:VisualIssueStatus)=>t(statuses[status]??status);
export const visualDescription=(issue:Pick<VisualIssue,'description'|'generatedDescription'>)=>issue.generatedDescription!==false&&(/^(Visual issue candidate|Visual Issue Candidate)$/.test(issue.description)||issue.description.startsWith('Responsive QA candidate:'))?t('Предполагаемый дефект'):issue.description;
export const visualCategoryLabel=(category:string)=>t(({'text-clipping':'Обрезка текста','horizontal-overflow':'Горизонтальное переполнение','vertical-overflow':'Вертикальное переполнение','element-overlap':'Перекрытие элементов','styling-mismatch':'Несоответствие стилей',unknown:'Требуется визуальное подтверждение'} as Record<string,string>)[category]??category);

export const visualStaleReason=(reason?:string)=>t(({
  'element-missing':'Элемент не найден', 'ambiguous-anchor':'DOM-привязка неоднозначна',
  'anchor-identity-changed':'Содержимое элемента изменилось', 'route':'Другой URL',
  'rotated-or-3d-anchor-needs-reselection':'Поворот, отражение или 3D transform не поддерживается',
  'dom-not-ready':'DOM ещё не готов', 'anchor-hidden':'Элемент скрыт',
  'screenshot-only-document-changed':'Документ снимка перезагружен',
  'screenshot-only-viewport-changed':'Изменились условия screenshot-региона',
  'selection-changed':'Выбор изменился во время перехода',
  'invalid-selector':'Селектор недоступен', 'invalid-original-anchor':'Нет исходной геометрии',
} as Record<string,string>)[reason??'']??'Состояние привязки неизвестно');
export const visualBindingLabel=(binding:import('./visual-debugging').VisualBindingState|undefined,region:import('./visual-debugging').VisualRegion)=>binding?.stale?visualStaleReason(binding.reason):!region.anchors.length?t('Сохранено · Только снимок'):region.anchors[0].confidence<.8?t('Сохранено · DOM неоднозначен'):t('Сохранено · DOM найден');
