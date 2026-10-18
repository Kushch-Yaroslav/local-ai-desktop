import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
export function ControlHelp({ label, children }: { label: string; children: string }) {
  const id = useId(), [point, setPoint] = useState<{x:number;y:number}>();
  return <span className="control-help"><button type="button" className="help-trigger" aria-label={label} aria-describedby={point ? id : undefined} onFocus={event => { const r=event.currentTarget.getBoundingClientRect(); setPoint({x:r.left,y:r.bottom+8}); }} onBlur={() => setPoint(undefined)} onMouseEnter={event => {const r=event.currentTarget.getBoundingClientRect();setPoint({x:r.left,y:r.bottom+8});}} onMouseLeave={() => setPoint(undefined)} onKeyDown={event => {if(event.key==='Escape')setPoint(undefined);}}><CircleHelp size={14}/></button>{point && createPortal(<span role="tooltip" id={id} className="control-tooltip" style={{left:Math.max(8,Math.min(point.x,window.innerWidth-316)),top:Math.min(point.y,window.innerHeight-140)}}><strong>{label}</strong>{children}</span>,document.body)}</span>;
}
