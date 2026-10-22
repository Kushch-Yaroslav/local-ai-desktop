import {useState} from 'react';
import {t} from '../../shared/locale';
import type {BrowserWorkspaceSettings,BrowserWorkspaceState} from '../../shared/live-browser';
const presets=[['Auto',0,0],['Mobile',390,844],['Tablet',768,1024],['Desktop',1440,900],['Full HD',1920,1080],['4K',3840,2160]] as const;
export function BrowserWorkspaceControls({state,disabled,onChange}:{state?:BrowserWorkspaceState;disabled:boolean;onChange:(settings:BrowserWorkspaceSettings)=>void}){
  const [custom,setCustom]=useState(false),[width,setWidth]=useState(1440),[height,setHeight]=useState(900);
  if(!state)return null;
  const settings=state.settings;
  const preset=settings.viewport==='auto'?'Auto':presets.find(p=>p[1]===state.viewport.width&&p[2]===state.viewport.height)?.[0]??'Custom';
  const pan=(dx:number,dy:number)=>onChange({...settings,pan:{x:Math.max(0,settings.pan.x+dx/state.displayScale/state.browserZoom),y:Math.max(0,settings.pan.y+dy/state.displayScale/state.browserZoom)}});
  return <details name="browser-tools" className="browser-workspace-controls"><summary>{t('Экран браузера')} · {state.viewport.width} × {state.viewport.height} · {Math.round(state.displayScale*100)}% · {settings.scale==='fit'?t('Вписать'):t('Фиксированный viewport')}</summary>
    <div><label>Viewport <select aria-label="CSS viewport" disabled={disabled} value={custom?'Custom':preset} onChange={e=>{const p=presets.find(p=>p[0]===e.target.value);setCustom(!p);if(!p){setWidth(state.viewport.width);setHeight(state.viewport.height);}if(p)onChange({...settings,viewport:p[0]==='Auto'?'auto':{width:p[1],height:p[2]},pan:{x:0,y:0}});}}>{presets.map(p=><option key={p[0]} value={p[0]}>{p[0]} {p[1]?`${p[1]}×${p[2]}`:''}</option>)}<option value="Custom">{t('Свой размер')}</option></select></label>
    <label>{t('Масштаб показа')} <select aria-label={t('Масштаб показа')} disabled={disabled} value={settings.scale} onChange={e=>onChange({...settings,scale:e.target.value==='fit'?'fit':Number(e.target.value),pan:{x:0,y:0}})}><option value="fit">Fit</option>{[.5,.75,1,1.25].map(s=><option value={s} key={s}>{s*100}% · {t('Фиксированный viewport')}</option>)}</select></label>
    {(custom||preset==='Custom')&&<form onSubmit={e=>{e.preventDefault();onChange({...settings,viewport:{width,height},pan:{x:0,y:0}});setCustom(false);}}><input aria-label={t('Ширина viewport')} type="number" min="240" max="4096" value={width} onChange={e=>setWidth(Number(e.target.value))}/><span>×</span><input aria-label={t('Высота viewport')} type="number" min="240" max="4096" value={height} onChange={e=>setHeight(Number(e.target.value))}/><button disabled={disabled}>{t('Применить')}</button></form>}
    <span className="browser-pan-pad" tabIndex={disabled?-1:0} title={t('Колесо и трекпад здесь перемещают поверхность, а не страницу.')} onWheel={e=>{if(!disabled){e.preventDefault();pan(e.deltaX,e.deltaY);}}} onKeyDown={e=>{if(!disabled&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();pan(e.key==='ArrowLeft'?-80:e.key==='ArrowRight'?80:0,e.key==='ArrowUp'?-80:e.key==='ArrowDown'?80:0);}}}>{t('Поверхность ↔ ↕')}</span>
    <button disabled={disabled} onClick={()=>onChange({...settings,pan:{x:0,y:0}})}>{t('В начало поверхности')}</button></div>
    <small>{t('Зажмите среднее колесо мыши и перемещайте поверхность браузера')} · {t('Масштаб показа не меняет CSS viewport. Колесо над сайтом прокручивает страницу; полосы прокрутки — поверхность.')} · Zoom {Math.round(state.browserZoom*100)}% · DSF {state.deviceScaleFactor}</small>{state.error&&<p role="alert">{state.error}</p>}
  </details>;
}
