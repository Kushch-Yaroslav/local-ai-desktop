import { useEffect, useState } from 'react';
import type { BrowserVisionMode } from '../../shared/browser-qa';
import { useAppStore } from '../store/app-store';
import { useLocale } from '../use-locale';
import { ControlField } from './ControlField';
import { localizeMessage, t } from '../../shared/locale';
type Status=Awaited<ReturnType<typeof window.localAi.browserQa.status>>;

export function VisionControl({modelId,onStatusChange}:{modelId?:string|null;onStatusChange?:(status:Status|undefined)=>void}){
 const ru=useLocale()==='ru',chatId=useAppStore(s=>s.activeId),generating=useAppStore(s=>Boolean(s.generationOwnerId));
 const [value,setValue]=useState<Status>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let alive=true;setValue(undefined);setError('');const poll=()=>void window.localAi.browserQa.status(chatId??undefined,modelId??undefined).then(v=>{if(alive){setValue(v);setError('');}},e=>{if(alive)setError(String(e));});poll();const timer=setInterval(poll,4000);return()=>{alive=false;clearInterval(timer);};},[chatId,modelId]);
 useEffect(()=>{onStatusChange?.(value);},[value,onStatusChange]);
 const state=value?.capability?.state;
 const blocked=state!==undefined&&state!=='supported'&&state!=='unknown';
 const reason=value?.reason??'';
 const labels={supported:ru?'Доступно':'Available',unsupported:ru?'Не поддерживается':'Unsupported',unknown:ru?'Неизвестно':'Unknown',misconfigured:ru?'Требуется настройка':'Needs configuration','backend-unavailable':ru?'Backend недоступен':'Backend unavailable','initialization-failed':ru?'Ошибка инициализации':'Initialization failed'};
 const visionEnabled=Boolean(value?.available&&value.mode!=='off');
 const visionHint=ru?'Vision позволяет модели анализировать изображения из чата и скриншоты браузера. Для визуальных задач используйте Auto или On, если модель поддерживает изображения. DOM и Live Browser работают без Vision.':'Vision lets the model analyze chat images and browser screenshots. Use Auto or On for visual tasks when the model supports images. DOM tools and Live Browser work without Vision.';
 return <>
  <ControlField label="Vision" className="vision-control" status={<small role="status">{value?.available?(value.mode==='off'?(ru?'Готово, выключено':'Ready, off'):(ru?'Активно':'Active')):state?labels[state]:(ru?'Проверяется…':'Checking…')}</small>} help={<>{visionHint} {localizeMessage(reason)} {ru?'Сохранённый выбор:':'Stored preference:'} {value?.mode??'—'}. {ru?'Активный image input:':'Active image input:'} {visionEnabled?'On':'Off'}. {ru?'Подробности и пути — в настройках профиля модели.':'See the model profile for diagnostics and file paths.'}</>}>
   <select aria-label="Vision" disabled={generating||busy||!value||blocked||!modelId} value={value?.mode??'off'} onChange={event=>{const mode=event.target.value as BrowserVisionMode;setBusy(true);setError('');void window.localAi.browserQa.status(chatId??undefined,modelId??undefined).then(latest=>window.localAi.browserQa.configure(mode,latest.autonomous,true,chatId??undefined,modelId??undefined)).then(async()=>{setValue(await window.localAi.browserQa.status(chatId??undefined,modelId??undefined));}).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}><option value="auto">Auto</option><option value="on" disabled={state!=='supported'}>On</option><option value="off">Off</option></select>
  </ControlField>
  {error&&<small role="alert">{localizeMessage(error)}</small>}
 </>;
}

export function ComputerVisionControl({ visionStatus }: { visionStatus?: Status }) {
 const ru=useLocale()==='ru';
 const ready=useAppStore(s=>Boolean(s.conversations.find(c=>c.id===s.activeId)?.workingDirectory)&&!s.generationOwnerId);
 return <ControlField label="Visual Debugging" className="computer-vision-field" help={ru?'Выделяйте области в Native Browser, связывайте их с DOM и отправляйте агенту. Manual работает без Vision. Auto проверяет переполнение только текущей страницы.':'Select Native Browser regions, ground them in DOM and send them to the agent. Manual works without Vision. Auto checks overflow on the current page only.'}><button type="button" disabled={!ready} onClick={()=>window.dispatchEvent(new Event('visual-open-browser'))}>{ru?'Открыть браузер':'Open browser'}</button><small>{visionStatus?.available?'Vision available':'DOM / CSS / geometry'}</small></ControlField>;
}

/** Functional QA policy is independent from model image capabilities. */
export function BrowserQaControls(){
 const ru=useLocale()==='ru',chatId=useAppStore(s=>s.activeId),generating=useAppStore(s=>Boolean(s.generationOwnerId));
 const [value,setValue]=useState<Status>(),[error,setError]=useState('');
 useEffect(()=>{let alive=true;void window.localAi.browserQa.status(chatId??undefined).then(v=>{if(alive)setValue(v);});return()=>{alive=false;};},[chatId]);
 const label=t('Автоматическая проверка браузера');
 const help=ru?'Если включено, агент может автоматически запускать доступные Browser QA-проверки для задач, связанных с интерфейсом или браузером. Если выключено, автоматический запуск не выполняется, но Browser Tools и явно запрошенные разрешённые проверки остаются доступны. DOM, CSS, layout и функциональные проверки не требуют Vision. Настройка действует для последующих действий и не меняет завершённые проверки; во время активного запуска изменить её нельзя — дождитесь ответа или нажмите Stop. Каждая операция по-прежнему зависит от Agent Security и области проекта.':'When enabled, the agent may automatically run available Browser QA checks for UI- or browser-related tasks. When disabled, automatic checks do not start, but Browser Tools and explicitly requested, permitted checks remain available. DOM, CSS, layout and functional checks do not require Vision. The setting affects later actions and does not change completed checks; it cannot be changed during an active run, so wait or press Stop. Every operation remains subject to Agent Security and project scope.';
 return <ControlField label={label} className="browser-qa-control" help={help}>
  <div className="qa-toggle"><button type="button" role="switch" aria-label={label} aria-checked={value?.autonomous??false} disabled={generating||!value} onClick={()=>{void window.localAi.browserQa.status(chatId??undefined).then(latest=>window.localAi.browserQa.configure(latest.mode,!latest.autonomous,true,chatId??undefined)).then(async()=>setValue(await window.localAi.browserQa.status(chatId??undefined))).catch(e=>setError(String(e)));}}><i/>{ru?(value?.autonomous?'Вкл.':'Выкл.'):(value?.autonomous?'On':'Off')}</button></div>
  {error&&<small role="alert">{localizeMessage(error)}</small>}
 </ControlField>;
}
