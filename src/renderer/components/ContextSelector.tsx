import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { t, localizeMessage } from '../../shared/locale';
import { cacheModeLabel, contextChoiceId, type ContextChoice } from '../../shared/context-options';

export function ContextSelector({ options, selected, disabled, onChange }: {
  options: ContextChoice[]; selected?: ContextChoice; disabled: boolean; onChange: (option: ContextChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [popupLayout,setPopupLayout] = useState<{left:number;width:number}>();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const rows = useRef<Array<HTMLDivElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex(option => selected && contextChoiceId(option) === contextChoiceId(selected)));
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const left=container.current?.getBoundingClientRect().left ?? 0;
      const mainLeft=document.querySelector('.main')?.getBoundingClientRect().left ?? 0;
      const width=Math.min(580,window.innerWidth-mainLeft-24);
      setPopupLayout({width,left:Math.max(mainLeft+12,Math.min(left,window.innerWidth-width-12))-left});
    };
    place();window.addEventListener('resize',place);
    return () => window.removeEventListener('resize',place);
  },[open]);
  useEffect(() => { setOpen(false); }, [disabled, options.map(contextChoiceId).join('|')]);
  useEffect(() => {
    if (!open) return;
    rows.current[active]?.scrollIntoView({ block: 'nearest' });
    const close = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open, active]);
  const choose = (index: number) => { if (options[index]) onChange(options[index]); setOpen(false); trigger.current?.focus(); };
  return <div className="context-selector" ref={container}>
    <span className="context-selector-label" id={`${id}-label`}>{t('Контекст')}</span>
    <button className="context-selector-trigger" ref={trigger} role="combobox" type="button" disabled={disabled || !options.length}
      aria-labelledby={`${id}-label`} aria-describedby={`${id}-value`} title={localizeMessage(selected?.warning ?? selected?.explanation ?? 'Не оценено для этой конфигурации')} aria-expanded={open} aria-controls={`${id}-list`} aria-haspopup="listbox"
      aria-activedescendant={open ? `${id}-${active}` : undefined}
      onClick={() => { setActive(selectedIndex); setOpen(!open); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); return; }
        if (event.key === 'Tab') { setOpen(false); return; }
        if (['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
          event.preventDefault();
          if (!open) { setActive(event.key === 'End' ? options.length - 1 : event.key === 'Home' ? 0 : selectedIndex); setOpen(true); }
          else setActive(index => {
            if (event.key === 'Home') return 0;
            if (event.key === 'End') return options.length - 1;
            const current = options[index];
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              const target = event.key === 'ArrowLeft' ? 'f16' : 'q8_0';
              return options.map((option,i) => ({ option,i })).filter(row => row.option.kvCacheType === target)
                .sort((a,b) => Math.abs(a.option.contextWindow-current.contextWindow)-Math.abs(b.option.contextWindow-current.contextWindow))[0]?.i ?? index;
            }
            const indices = options.flatMap((option,i) => option.kvCacheType === current.kvCacheType ? [i] : []);
            return indices[Math.max(0,Math.min(indices.length-1,indices.indexOf(index)+(event.key === 'ArrowDown' ? 1 : -1)))];
          });
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); if (open) choose(active); else { setActive(selectedIndex); setOpen(true); }
        }
      }}>
      <span className={`context-fit-dot ${selected?.status ?? 'unevaluated'}`} aria-hidden="true" />
      <span id={`${id}-value`}>{selected?.label ?? '—'}</span><ChevronDown size={13} />
    </button>
    {open && <div role="listbox" id={`${id}-list`} aria-labelledby={`${id}-label`} className="context-selector-list" style={popupLayout}>
      {(['f16','q8_0'] as const).filter(type => options.some(option => option.kvCacheType === type)).map(type => <div className="context-selector-column" role="group" aria-label={cacheModeLabel(type)} key={type}>
      <strong className="context-selector-column-title">{cacheModeLabel(type)}</strong>
      {options.map((option,index) => option.kvCacheType === type && <div role="option" id={`${id}-${index}`} key={contextChoiceId(option)}
        ref={node => { rows.current[index] = node; }} aria-selected={Boolean(selected && contextChoiceId(selected) === contextChoiceId(option))}
        data-context-id={contextChoiceId(option)} data-fit-status={option.status ?? 'unevaluated'}
        title={[option.explanation, option.warning].filter(Boolean).map(value => localizeMessage(value!)).join('\n')}
        className={`context-selector-option ${index === active ? 'active' : ''}`} onMouseMove={() => setActive(index)} onClick={() => choose(index)}>
        <span className={`context-fit-dot ${option.status ?? 'unevaluated'}`} aria-hidden="true" />
        <span><b>{option.label}</b><small>{localizeMessage(option.explanation ?? t('Не оценено для этой конфигурации'))}</small>{option.warning && <small className="context-fit-warning">{localizeMessage(option.warning)}</small>}</span>
      </div>)}
      </div>)}
    </div>}
  </div>;
}
