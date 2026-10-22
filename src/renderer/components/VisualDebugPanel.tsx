import {useEffect, useState} from 'react';
import {useAppStore} from '../store/app-store';
import {useLocale} from '../use-locale';
import {visualGroupColor, type VisualCommand, type VisualDocument, type VisualRegion} from '../../shared/visual-debugging';

export function RegionChip({region, onRemove}:{region:VisualRegion;onRemove?:()=>void}) {
  const [error,setError]=useState('');
  return <span className="visual-region-chip" style={{borderColor:visualGroupColor(region.groupId)}}><button title={`${region.route} · ${region.groupId}`} onClick={()=>{window.dispatchEvent(new Event('visual-show-browser'));void window.localAi.visualDebug.open(region.conversationId).then(()=>window.localAi.visualDebug.command(region.conversationId,{action:'reveal',regionId:region.id})).catch(e=>setError(String(e)));}}>#{region.id}</button>{onRemove&&<button aria-label={`Remove ${region.id}`} onClick={onRemove}>×</button>}{error&&<small role="alert">{error}</small>}</span>;
}

export function VisualDebugPanel({conversationId,interactive}:{conversationId:string|null;interactive:boolean}) {
  const ru=useLocale()==='ru';
  const projectId=useAppStore(s=>s.conversations.find(c=>c.id===conversationId)?.primaryProjectId);
  const running=useAppStore(s=>Boolean(s.generationOwnerId));
  const [document,setDocument]=useState<VisualDocument>({regions:[],issues:[]});
  const [selected,setSelected]=useState<string[]>([]),[group,setGroup]=useState('group-1');
  const [selecting,setSelecting]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[mode,setMode]=useState('manual');
  const [vision,setVision]=useState(false);
  useEffect(()=>{let alive=true;setSelected([]);setSelecting(false);setDocument({regions:[],issues:[]});
    const poll=()=>{if(!conversationId)return;void window.localAi.visualDebug.document(conversationId).then(d=>{if(alive){setDocument(d);setSelecting(Boolean(d.selectionActive));}}).catch(()=>undefined);};
    poll();const timer=setInterval(poll,1200);
    void window.localAi.browserQa.status(conversationId??undefined).then(s=>{if(alive)setVision(s.available&&s.mode!=='off');}).catch(()=>undefined);
    return()=>{alive=false;clearInterval(timer);};
  },[conversationId,projectId]);
  const command=(cmd:VisualCommand)=>{if(!conversationId)return;setBusy(true);setError('');void window.localAi.visualDebug.command(conversationId,cmd).then(d=>{setDocument(d);if(cmd.action==='selection')setSelecting(cmd.enabled);else setSelecting(false);}).catch(e=>setError(String(e))).finally(()=>setBusy(false));};
  const enabled=interactive&&!running&&!busy;
  return <details className="visual-debug-panel" open><summary>Visual Debugging · {document.regions.length} {ru?'областей':'regions'}</summary>
    <p className="visual-capabilities">Visual Selection / Grounding / DOM QA {ru?'доступны без Vision':'work without Vision'}. Vision: {vision?'available':'Off / unavailable'}.</p>
    <div className="visual-controls"><select aria-label="Visual Debugging mode" value={mode} onChange={e=>setMode(e.target.value)}><option value="manual">Manual</option><option value="auto">Auto · DOM candidates</option></select>
      {mode==='manual'?<button disabled={!enabled} onClick={()=>command({action:'selection',enabled:!selecting,groupId:group})}>{selecting?(ru?'Завершить выделение':'Exit selection'):(ru?'Выделить область':'Select region')}</button>:<button disabled={!enabled} onClick={()=>command({action:'detect'})}>{ru?'Проверить текущую страницу':'Check current page'}</button>}
      <input aria-label="Group ID" value={group} maxLength={64} onChange={e=>setGroup(e.target.value)} />
      <button disabled={!enabled||!selected.length} onClick={()=>command({action:'group',regionIds:selected,groupId:group})}>{ru?'Сгруппировать':'Group'}</button>
      <button disabled={!selected.length||running} onClick={()=>{const regions=document.regions.filter(r=>selected.includes(r.id));window.dispatchEvent(new CustomEvent('visual-region-draft',{detail:{conversationId,regions}}));command({action:'selection',enabled:false});}}>{ru?'В чат → агенту':'To chat → agent'}</button>
    </div>
    <div className="visual-region-list">{document.regions.map((r,index)=><div key={r.id}><input type="checkbox" aria-label={`Select ${r.id}`} checked={selected.includes(r.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/><span>{index+1}.</span><RegionChip region={r}/><small>{r.groupId} · {r.anchors[0]?.tag??'screenshot-only'} · {r.route}</small><details><summary>DOM / geometry</summary>{r.anchors.map((a,i)=><p key={i}><code>{a.selector}</code> · {Math.round(a.confidence*100)}%<br/>{a.text}<br/>{a.diagnostics.join('; ')}</p>)}<small>{r.viewport.width}×{r.viewport.height} · DPR {r.dpr} · scroll {Math.round(r.scroll.y)} · {r.diagnostics.join('; ')}</small></details><button disabled={!enabled} aria-label={`Delete ${r.id}`} onClick={()=>command({action:'delete',regionId:r.id})}>×</button></div>)}</div>
    {document.issues.length>0&&<details><summary>{ru?'Группы дефектов':'Issue groups'}</summary>{document.issues.map(issue=><div className="visual-issue" key={issue.id}><strong>{issue.id}</strong><input aria-label={`Description ${issue.id}`} defaultValue={issue.description} key={issue.id+issue.description} onBlur={e=>{if(e.target.value!==issue.description)command({action:'issue',issueId:issue.id,description:e.target.value,status:issue.status==='Verified'?'Fixed':issue.status});}}/><select aria-label={`Status ${issue.id}`} disabled={!enabled} value={issue.status} onChange={e=>command({action:'issue',issueId:issue.id,description:issue.description,status:e.target.value as 'Confirmed'})}>{['Detected','Confirmed','In progress','Fixed',...(issue.status==='Verified'?['Verified']:[]),'Unresolved'].map(s=><option key={s}>{s}</option>)}</select><small>{issue.verification} · {issue.regionIds.length} regions</small></div>)}</details>}
    <small role="status">{busy?(ru?'Выполняется…':'Working…'):selecting?(ru?'Мышь: прямоугольник. Escape: отмена / выход. Колесо: прокрутка.':'Drag a rectangle. Escape: cancel / exit. Wheel: scroll.'):mode==='auto'?(ru?'Только текущая страница, до 12 layout-кандидатов; требуется подтверждение.':'Current page only, up to 12 layout suspects; confirmation required.'):''}</small>{error&&<p role="alert">{error}</p>}
  </details>;
}
