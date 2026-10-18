import { useEffect, useState } from 'react';
import type { BrowserVisionMode } from '../../shared/browser-qa';
import { useAppStore } from '../store/app-store';
import { useLocale } from '../use-locale';
import { ReloadDialog } from './ReloadDialog';
import { ControlHelp } from './ControlHelp';

export function BrowserQaControls({ onStatusChange }: { onStatusChange?: (status: Awaited<ReturnType<typeof window.localAi.browserQa.status>> | undefined) => void }) {
  const ru=useLocale()==='ru', generating=useAppStore(state=>Boolean(state.generationOwnerId));
  const [value,setValue]=useState<Awaited<ReturnType<typeof window.localAi.browserQa.status>>>(),[draft,setDraft]=useState<{mode:BrowserVisionMode;autonomous:boolean}>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
  useEffect(()=>{let alive=true;const poll=()=>{void window.localAi.browserQa.status().then(v=>{if(alive)setValue(v);}).catch(e=>{if(alive)setError(String(e));});};poll();const timer=setInterval(poll,4000);return()=>{alive=false;clearInterval(timer);};},[]);
  useEffect(()=>{onStatusChange?.(value);},[value,onStatusChange]);
  const save=async(mode:BrowserVisionMode,autonomous:boolean)=>{setBusy(true);setError(undefined);try{await window.localAi.browserQa.configure(mode,autonomous,true);setValue(await window.localAi.browserQa.status());}catch(e){setError(String(e));}finally{setBusy(false);}};
  const apply=async()=>{if(!draft||generating)return;setBusy(true);try{await window.localAi.browserQa.configure(draft.mode,draft.autonomous,true);setValue(await window.localAi.browserQa.status());setDraft(undefined);setError(undefined);await useAppStore.getState().refreshRuntime();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <><label className="control"><span>Browser Vision ⟳</span><select aria-label="Browser Vision" disabled={generating||busy||!value} value={value?.mode??'off'} onChange={event=>{const mode=event.target.value as BrowserVisionMode;if(mode==='on'&&!value?.available)setDraft({mode,autonomous:value?.autonomous??false});else void save(mode,value?.autonomous??false);}}><option value="off">Off</option><option value="auto">Auto</option><option value="on">On</option></select></label>
    <span className="vision-availability" role="status" title={value?.reason}>{value?.mode==='off'?'Off':value?.available?(ru?'Готово к анализу':'Image ready'):(ru?'Только функциональный QA':'Functional QA only')}</span>
    <label className="control qa-toggle"><span>Autonomous QA ◴</span><button role="switch" aria-label="Autonomous Browser QA" aria-checked={value?.autonomous??false} disabled={generating||busy||!value} onClick={()=>void save(value?.mode??'off',!value?.autonomous)}><i/>{value?.autonomous?'On':'Off'}</button></label>
    <ControlHelp label={ru?'Vision и QA':'Vision & QA'}>{ru?'Vision отправляет выбранные PNG основной модели. Off не затрагивает обычные вложения. Auto использует доступный projector; On проверяет доступность. Autonomous QA отдельно запускает реальные проверки перед завершением веб-задачи. Менять после ответа; возможная перезагрузка сохраняет историю, но сбрасывает KV-cache.':'Vision sends selected PNG images to the main model. Off preserves ordinary image attachments. Auto uses an available projector; On requires capability. Autonomous QA separately checks browser tasks before completion. Change after response; a required reload preserves history and clears KV cache.'}</ControlHelp>
    {draft&&<ReloadDialog title={ru?'Browser Vision и QA':'Browser Vision & QA'} busy={busy} disabled={generating} error={error} onCancel={()=>{setDraft(undefined);setError(undefined);}} onApply={()=>void apply()}><p>{value?.reason}</p><p>{ru?'Модель и MTP не заменяются автоматически. Off/Auto обычно не требуют перезагрузки. Для QA требуется включённый Web и разрешение на браузер.':'The model and MTP are not substituted automatically. Off/Auto usually require no reload. QA requires Web enabled and browser approval.'}</p></ReloadDialog>}
    {!draft&&error&&<small role="alert">{error}</small>}
  </>;
}
