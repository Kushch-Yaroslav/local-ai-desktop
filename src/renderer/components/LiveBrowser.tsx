import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Globe, Columns2, Maximize2, MessageSquare, X, Radio, RefreshCw } from 'lucide-react';
import type { BrowserFrame, LiveBrowserState } from '../../shared/live-browser';
import { useLocale } from '../use-locale';

type Mode = 'split' | 'expanded' | 'chat';
export function LiveBrowserWorkspace({ conversationId, children }: { conversationId: string | null; children: ReactNode }) {
  const language = useLocale();
  const ru = language === 'ru';
  const choices = useRef(new Map<string, Mode>());
  const [mode, setMode] = useState<Mode>('chat');
  const [browser, setBrowser] = useState<LiveBrowserState | null>(null);
  const [ratio, setRatio] = useState(50);
  const [narrow, setNarrow] = useState(false);
  const [fps, setFps] = useState(0);
  const [screenWidth, setScreenWidth] = useState(1280);
  const screen = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef<string | null>(null), session = useRef<string | null>(null);
  const paintEpoch = useRef(0), painted = useRef(0), decoding = useRef(false);
  const visible = useRef(false);
  const changeMode = (next: Mode) => { if (conversationId) choices.current.set(conversationId, next); setMode(next); };
  // Reset before paint so a chat switch can never flash the other chat's frame.
  useLayoutEffect(() => {
    current.current = conversationId; session.current = null; paintEpoch.current++;
    setBrowser(null); setMode(conversationId ? choices.current.get(conversationId) ?? 'chat' : 'chat');
    const context = canvas.current?.getContext('2d'); context?.clearRect(0, 0, 1280, 900);
  }, [conversationId]);
  useEffect(() => {
    const api = window.localAi.liveBrowser;
    if (!api) return;
    let mounted = true;
    const draw = async (frame: BrowserFrame) => {
      if (frame.conversationId !== current.current || frame.sessionId !== session.current || !visible.current || decoding.current) { api.acknowledge(frame.sessionId, frame.sequence); return; }
      const epoch = paintEpoch.current;
      decoding.current = true;
      let bitmap: ImageBitmap | undefined;
      try {
        // No data-URL image cache; release the decoded bitmap immediately after paint.
        const bytes = Uint8Array.from(atob(frame.data), character => character.charCodeAt(0));
        bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        if (mounted && epoch === paintEpoch.current && frame.sessionId === session.current && visible.current && canvas.current) {
          if (canvas.current.width !== bitmap.width) canvas.current.width = bitmap.width;
          if (canvas.current.height !== bitmap.height) canvas.current.height = bitmap.height;
          canvas.current.getContext('2d')?.drawImage(bitmap, 0, 0); painted.current++;
        }
      } catch { /* A damaged frame is dropped; the next CDP frame can recover. */ }
      finally { bitmap?.close(); decoding.current = false; api.acknowledge(frame.sessionId, frame.sequence); }
    };
    const unsubscribe = api.onEvent(event => {
      if (event.type === 'frame') void draw(event.frame);
      else if (event.state.conversationId === current.current) {
        if (session.current !== event.state.sessionId) {
          paintEpoch.current++; session.current = event.state.sessionId;
          canvas.current?.getContext('2d')?.clearRect(0, 0, 1280, 900);
        }
        setBrowser(event.state);
        if (!choices.current.has(event.state.conversationId)) setMode('split');
      }
    });
    return () => { mounted = false; unsubscribe(); void api.watch(null, false).catch(() => undefined); };
  }, []);
  useEffect(() => {
    visible.current = mode !== 'chat' && !document.hidden;
    const api = window.localAi.liveBrowser;
    const watch = () => { visible.current = mode !== 'chat' && !document.hidden; void api?.watch(conversationId, visible.current).catch(() => undefined); };
    watch(); document.addEventListener('visibilitychange', watch);
    return () => document.removeEventListener('visibilitychange', watch);
  }, [conversationId, mode]);
  useEffect(() => {
    const element = root.current; if (!element) return;
    const observer = new ResizeObserver(entries => { for (const entry of entries) { if (entry.target === element) setNarrow(entry.contentRect.width < 680); else setScreenWidth(Math.max(1, Math.min(entry.contentRect.width - 20, entry.contentRect.height * 1280 / 900))); } }); observer.observe(element); if (screen.current) observer.observe(screen.current);
    const interval = window.setInterval(() => { setFps(painted.current); painted.current = 0; }, 1000);
    return () => { observer.disconnect(); window.clearInterval(interval); };
  }, []);
  const status = browser?.status;
  const statusText = status === 'loading' ? (ru ? 'Загрузка' : 'Loading') : status === 'live' ? (ru ? 'Подключён' : 'Connected') : status === 'error' ? (ru ? 'Ошибка' : 'Error') : (ru ? 'Последний кадр' : 'Last frame');
  const action = browser?.action;
  return <div ref={root} className={`live-workspace mode-${mode} ${narrow ? 'is-narrow' : ''}`} style={{ '--chat-share': `${ratio}%` } as CSSProperties}>
    <div className="live-chat">{browser && mode === 'chat' && <button className="live-reopen" onClick={() => changeMode('split')}><Globe size={15} />Live Browser<span>{statusText}</span></button>}{children}</div>
    {mode === 'split' && <div className="live-divider" role="separator" aria-label={ru ? 'Размер панелей' : 'Panel size'} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)} tabIndex={0}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setRatio(value => Math.max(25, Math.min(75, value + (event.key === 'ArrowLeft' ? -3 : 3)))); } }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId) || !root.current) return; const rect = root.current.getBoundingClientRect(); setRatio(Math.max(25, Math.min(75, 100 * (event.clientX - rect.left) / rect.width))); }}
      onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />}
    <aside className="live-browser" aria-label="Live Browser" aria-hidden={mode === 'chat'}>
      <header className="live-header"><span className="live-title"><Globe size={16} />Live Browser</span><div className="live-view-controls">
        <button className={mode === 'split' ? 'selected' : ''} title="Split View" aria-label="Split View" onClick={() => changeMode('split')}><Columns2 size={15} /></button>
        <button className={mode === 'expanded' ? 'selected' : ''} title="Browser Expanded" aria-label="Browser Expanded" onClick={() => changeMode('expanded')}><Maximize2 size={15} /></button>
        <button title="Chat Only" aria-label="Chat Only" onClick={() => changeMode('chat')}><X size={16} /></button>
      </div></header>
      <div className="live-address"><span className={`live-dot ${status ?? ''}`} /><span title={browser?.url}>{browser?.url || (ru ? 'Ожидание страницы' : 'Waiting for a page')}</span></div>
      <div ref={screen} className="live-screen"><div className="live-viewport" style={{ width: screenWidth }}><canvas ref={canvas} width={1280} height={900} aria-label={ru ? 'Страница браузера агента' : 'Agent browser page'} />
        {action && action.x !== undefined && action.y !== undefined && <span key={`${browser?.sessionId}:${action.at}`} className={`live-action action-${action.kind}`} style={{ left: `${100 * action.x / 1280}%`, top: `${100 * action.y / 900}%` }} />}
      </div>{!browser && <div className="live-empty"><Globe size={28} />{ru ? 'Agent откроет страницу через web_project' : 'The Agent opens pages with web_project'}</div>}</div>
      <footer className="live-footer"><span><Radio size={12} />{statusText}</span><span>{status === 'live' ? `${fps} fps` : ''}</span><span className="live-action-label">{action && Date.now() - action.at < 2500 ? action.kind : (ru ? 'Наблюдение' : 'Observe only')}</span>
        <button title={ru ? 'Переподключить просмотр' : 'Reconnect live view'} aria-label="Reconnect live view" onClick={() => { void window.localAi.liveBrowser?.watch(conversationId, true).catch(() => undefined); }}><RefreshCw size={13} /></button>
        {mode === 'expanded' && <button aria-label="Show chat" onClick={() => changeMode('split')}><MessageSquare size={13} /></button>}
      </footer>
      {browser?.error && <p className="live-error" role="status">{browser.error}</p>}
    </aside>
  </div>;
}
