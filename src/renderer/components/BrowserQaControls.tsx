import { useEffect, useState } from 'react';
import type { BrowserVisionMode } from '../../shared/browser-qa';
import { useAppStore } from '../store/app-store';
import { useLocale } from '../use-locale';
import { ControlHelp } from './ControlHelp';
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
 return <div className="control-help-field vision-control"><label className="control"><span>Vision <small role="status">{value?.available?(value.mode==='off'?(ru?'Готово, выключено':'Ready, off'):(ru?'Активно':'Active')):state?labels[state]:(ru?'Проверяется…':'Checking…')}</small></span><select aria-label="Vision" disabled={generating||busy||!value||blocked||!modelId} value={value?.mode??'off'} onChange={event=>{const mode=event.target.value as BrowserVisionMode;setBusy(true);setError('');void window.localAi.browserQa.status(chatId??undefined,modelId??undefined).then(latest=>window.localAi.browserQa.configure(mode,latest.autonomous,true,chatId??undefined,modelId??undefined)).then(async()=>{setValue(await window.localAi.browserQa.status(chatId??undefined,modelId??undefined));}).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}><option value="auto">Auto</option><option value="on" disabled={state!=='supported'}>On</option><option value="off">Off</option></select></label><ControlHelp label="Vision">{ru?'Vision позволяет модели анализировать изображения из чата и скриншоты браузера. Для более точной визуальной проверки рекомендуется Auto или On, если модель поддерживает изображения. Работа с DOM и Live Browser доступна без Vision.':'Vision lets the model analyze chat images and browser screenshots. Auto or On is recommended for more precise visual checks when supported. DOM tools and Live Browser work without Vision.'} {localizeMessage(reason)} {ru?'Сохранённый выбор:':'Stored preference:'} {value?.mode??'—'}. {ru?'Активный image input:':'Active image input:'} {value?.available&&value?.mode!=='off'?'On':'Off'}. {ru?'Подробности и пути — в настройках профиля модели.':'See the model profile for diagnostics and file paths.'}</ControlHelp>{error&&<small role="alert">{localizeMessage(error)}</small>}</div>;
}

/** Functional QA policy is independent from model image capabilities. */
export function BrowserQaControls(){
 const ru=useLocale()==='ru',chatId=useAppStore(s=>s.activeId),generating=useAppStore(s=>Boolean(s.generationOwnerId));
 const [value,setValue]=useState<Status>(),[error,setError]=useState('');
 useEffect(()=>{let alive=true;void window.localAi.browserQa.status(chatId??undefined).then(v=>{if(alive)setValue(v);});return()=>{alive=false;};},[chatId]);
 return <div className="control-help-field"><label className="control qa-toggle"><span>{t('Автоматическая проверка браузера')}</span><button role="switch" aria-label={t('Автоматическая проверка браузера')} aria-checked={value?.autonomous??false} disabled={generating||!value} onClick={()=>{void window.localAi.browserQa.status(chatId??undefined).then(latest=>window.localAi.browserQa.configure(latest.mode,!latest.autonomous,true,chatId??undefined)).then(async()=>setValue(await window.localAi.browserQa.status(chatId??undefined))).catch(e=>setError(String(e)));}}><i/>{ru?(value?.autonomous?'Вкл.':'Выкл.'):(value?.autonomous?'On':'Off')}</button></label><ControlHelp label={t('Автоматическая проверка браузера')}>{ru?'DOM, Live Browser и функциональные проверки работают без Vision. Требуются разрешения и доступ к проекту.':'DOM, Live Browser and functional checks work without Vision. Browser permissions and project access still apply.'}</ControlHelp>{error&&<small role="alert">{localizeMessage(error)}</small>}</div>;
}
