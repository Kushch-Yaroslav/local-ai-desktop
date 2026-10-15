import { useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../shared/locale';
import { useLocale } from '../use-locale';
import type { ContextDiscoveryOption } from '../../shared/context-estimator';

export function MaximumContextPopover({ options, supportedContext, vram }: {
  options: ContextDiscoveryOption[];
  supportedContext: number | null;
  vram?: { total: number; used: number; free: number };
}) {
  useLocale();
  const [open,setOpen] = useState(false);
  const [layout,setLayout] = useState<{left:number;top:number;width:number;maxHeight:number}>();
  const container = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!summary.current || !panel.current) return;
      const anchor=summary.current.getBoundingClientRect();
      const margin=12, gap=8;
      const width=Math.min(420,Math.max(0,window.innerWidth-margin*2));
      panel.current.style.width=`${width}px`;
      const naturalHeight=panel.current.scrollHeight+2;
      const below=Math.max(0,window.innerHeight-anchor.bottom-gap-margin);
      const above=Math.max(0,Math.min(anchor.top-gap-margin,window.innerHeight-margin*2));
      const useBelow=below>=Math.min(naturalHeight,220) || below>=above;
      const maxHeight=Math.min(window.innerHeight-margin*2,useBelow?below:above);
      const height=Math.min(naturalHeight,maxHeight);
      const next={width,maxHeight,
        left:Math.max(margin,Math.min(anchor.right-width,window.innerWidth-width-margin)),
        top:Math.max(margin,Math.min(useBelow?anchor.bottom+gap:anchor.top-gap-height,window.innerHeight-height-margin))};
      setLayout(prior => prior && Object.keys(next).every(key=>prior[key as keyof typeof next]===next[key as keyof typeof next]) ? prior : next);
    };
    const closeOutside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    place();
    window.addEventListener('resize',place);
    window.addEventListener('scroll',place,true);
    document.addEventListener('pointerdown',closeOutside);
    return () => { window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);document.removeEventListener('pointerdown',closeOutside); };
  },[open,options,supportedContext,vram]);
  const gb=(bytes:number)=>(bytes/1024**3).toFixed(1);
  return <details className="context-estimate" ref={container} open={open} onToggle={event=>setOpen(event.currentTarget.open)}
    onKeyDown={event=>{if(event.key==='Escape'){setOpen(false);summary.current?.focus();}}}>
    <summary ref={summary}>{t('Максимальный контекст')}</summary>
    <div className="context-estimate-details" ref={panel} style={{...layout,visibility:open && layout?'visible':'hidden'}}>
      <p>{t('FP16 KV-кэш сохраняет более высокую числовую точность, но требует больше памяти. Q8 KV-кэш использует меньше памяти с возможной потерей точности.')}</p>
      <div className="context-memory-results">
        {(['f16','q8_0'] as const).map(type=>{
          const result=options.filter(option=>option.kvCacheType===type).sort((a,b)=>b.discoveredAt.localeCompare(a.discoveredAt) || b.contextWindow-a.contextWindow)[0];
          return <div className="context-memory-result" data-kv-type={type} key={type}>
            <span>{type==='f16'?t('Найденный максимум FP16'):t('Найденный максимум Q8')}</span>
            <b>{result?`${result.contextWindow/1024}K`:t('не измерен')}</b>
          </div>;
        })}
      </div>
      <section className="context-vram-summary" aria-label="VRAM">
        <strong>VRAM</strong>
        <dl>{([['total',t('Всего')],['used',t('Занято')],['free',t('Свободно')]] as const).map(([key,label])=><div key={key} data-vram={key}><dt>{label}</dt><dd>{vram?`${gb(vram[key])} ${t('ГиБ')}`:t('неизвестно')}</dd></div>)}</dl>
      </section>
      <p className="context-supported-limit"><span>{t('Предел выбранной модели/backend')}</span><b>{supportedContext?`${supportedContext/1024}K`:t('неизвестен')}</b></p>
    </div>
  </details>;
}
