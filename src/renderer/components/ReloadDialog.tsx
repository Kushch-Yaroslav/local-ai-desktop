import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import { useLocale } from '../use-locale';

export function ReloadDialog({ title, busy, disabled, error, children, onCancel, onApply }: { title: string; busy?: boolean; disabled?: boolean; error?: string; children?: ReactNode; onCancel(): void; onApply(): void }) {
  const ru = useLocale() === 'ru', id = useId(), ref = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const dialog = ref.current; dialog?.showModal(); cancel.current?.focus(); return () => { dialog?.close(); if (previous?.closest('[inert]')) document.querySelector<HTMLButtonElement>('.panel-mode-toggle')?.focus(); else previous?.focus(); }; }, []);
  return createPortal(<dialog ref={ref} className="reload-dialog" aria-label={title} aria-describedby={id} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <div className="reload-heading"><span className="reload-symbol"><RefreshCw size={22} /></span><div><small>{title}</small><h2>{ru ? 'Перезагрузить модель?' : 'Reload model?'}</h2></div></div>
    <p id={id}>{ru ? 'Для применения параметров модель может быть загружена заново. История чата и checkpoint сохранятся. Вычислительный контекст и KV-cache при перезагрузке будут пересозданы.' : 'Applying these settings may reload the model. Chat history and checkpoints are preserved. Reloading recreates the inference context and KV cache.'}</p>
    {children && <details><summary>{ru ? 'Подробности изменения' : 'Change details'}</summary><div className="reload-detail">{children}</div></details>}
    {error && <p role="alert" className="reload-error">{error}</p>}
    <footer><button ref={cancel} disabled={busy} className="secondary" onClick={onCancel}>{ru ? 'Отмена' : 'Cancel'}</button><button disabled={busy || disabled} className="primary" aria-busy={busy} onClick={onApply}>{busy ? (ru ? 'Применение…' : 'Applying…') : ru ? 'Применить и перезагрузить' : 'Apply and reload'}</button></footer>
  </dialog>, document.body);
}
