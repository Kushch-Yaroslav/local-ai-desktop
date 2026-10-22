import {t,tr} from './locale';
import type {VisualIssue,VisualIssueStatus} from './visual-debugging';
export const areaLabel=(number:number|undefined)=>tr`Область ${number??'?'}`;
const statuses:Record<VisualIssueStatus,string>={Detected:'Обнаружено',Confirmed:'Подтверждено','In progress':'В работе',Fixed:'Исправлено',Verified:'Проверено',Unresolved:'Не решено'};
export const visualStatusLabel=(status:VisualIssueStatus)=>t(statuses[status]??status);
export const visualDescription=(issue:Pick<VisualIssue,'description'>)=>/^(Visual issue candidate|Visual Issue Candidate|Responsive QA candidate:)/.test(issue.description)?t('Предполагаемый дефект'):issue.description;
export const visualCategoryLabel=(category:string)=>t(({'text-clipping':'Обрезка текста','horizontal-overflow':'Горизонтальное переполнение','vertical-overflow':'Вертикальное переполнение','element-overlap':'Перекрытие элементов','styling-mismatch':'Несоответствие стилей',unknown:'Требуется визуальное подтверждение'} as Record<string,string>)[category]??category);
