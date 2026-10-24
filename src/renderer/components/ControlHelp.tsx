import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
import { tr } from '../../shared/locale';
import type { ReactNode } from 'react';

type TooltipPoint = { left: number; top: number; maxHeight: number };

/** Shared, keyboard-operable help for controls, including controls that are disabled. */
export function ControlHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = `control-help-${useId().replace(/:/g, '')}`;
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState<TooltipPoint>();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const place = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    const margin = 12;
    const width = Math.min(340, Math.max(0, window.innerWidth - margin * 2));
    let maxHeight = Math.min(360, Math.max(120, window.innerHeight - margin * 2));
    const height = Math.min(tooltip.current?.getBoundingClientRect().height ?? 120, maxHeight);
    const below = window.innerHeight - anchor.bottom - 9 - margin;
    const above = anchor.top - 9 - margin;
    let top = below >= Math.min(height, 120) || below >= above
      ? Math.min(anchor.bottom + 9, window.innerHeight - height - margin)
      : Math.max(margin, anchor.top - height - 9);
    const left = Math.max(margin, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - margin));
    // Native views are separate compositor surfaces. Keep help in renderer chrome
    // rather than hiding the entire live page to display a small portal.
    const surface=document.querySelector('.live-workspace:not(.mode-chat) .native-browser-surface')?.getBoundingClientRect();
    if(surface&&left<surface.right&&left+width>surface.left&&top<surface.bottom&&top+height>surface.top){
      maxHeight=Math.max(40,Math.min(maxHeight,surface.top-margin*2));
      top=Math.max(margin,surface.top-Math.min(height,maxHeight)-margin);
    }
    setPoint({ left, top, maxHeight });
  }, []);

  const cancelClose = () => { if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current); };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => { setOpen(false); setPoint(undefined); }, 140);
  };
  const show = () => { cancelClose(); setOpen(true); };
  const close = (returnFocus = false) => {
    cancelClose(); setOpen(false); setPoint(undefined);
    if (returnFocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, place, children]);

  return <span className="control-help" data-control-help="true" data-help-label={label}>
    <button ref={trigger} type="button" className="help-trigger" aria-label={tr`Справка: ${label}`} aria-haspopup="true" aria-expanded={open}
      aria-describedby={open ? id : undefined} onFocus={show} onBlur={scheduleClose} onMouseEnter={show} onMouseLeave={scheduleClose}
      onClick={event => { if (event.detail > 0 && open) close(); else show(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(true); } }}>
      <CircleHelp size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<span ref={tooltip} role="tooltip" id={id} className="control-tooltip" style={point} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      <strong>{label}</strong><span>{children}</span>
    </span>, document.body)}
  </span>;
}
