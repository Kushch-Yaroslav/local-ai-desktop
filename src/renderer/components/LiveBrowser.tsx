import {cssToPresentation,presentationToCss} from '../../shared/browser-coordinates';
import {BrowserWorkspaceControls} from './BrowserWorkspaceControls';
import { VisualDebugPanel } from './VisualDebugPanel';
import { useAppStore } from '../store/app-store';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Globe, Columns2, Maximize2, MessageSquare, X, Radio, RefreshCw, ArrowLeft, ArrowRight } from 'lucide-react';
import type { LiveBrowserState, BrowserInput } from '../../shared/live-browser';
import { t } from '../../shared/locale';
import { useLocale } from '../use-locale';
import { ControlHelp } from './ControlHelp';

type Mode = 'split' | 'expanded' | 'chat';
export function LiveBrowserWorkspace({ conversationId, children }: { conversationId: string | null; children: ReactNode }) {
  const ru=useLocale()==='ru';
  const running=useAppStore(s=>Boolean(s.generationOwnerId));
  const chat=useAppStore(s=>s.conversations.find(c=>c.id===conversationId));
  const [openError,setOpenError]=useState('');
  const [previewUrl,setPreviewUrl]=useState('');
  const openBrowser=()=>{if(!conversationId)return;setOpenError('');changeMode('split');void window.localAi.visualDebug.open(conversationId,previewUrl||undefined).then(()=>window.localAi.liveBrowser?.watch(conversationId,true)).catch(e=>setOpenError(String(e)));};

  const choices = useRef(new Map<string, Mode>());
  const [mode, setMode] = useState<Mode>('chat');
  const [browser, setBrowser] = useState<LiveBrowserState | null>(null);
  const [ratio, setRatio] = useState(50);
  const [narrow, setNarrow] = useState(false);
  const screen = useRef<HTMLDivElement>(null);
  const panTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const current = useRef<string | null>(null), session = useRef<string | null>(null);
  const visible = useRef(false);
  const changeMode = useCallback((next: Mode) => { if (conversationId) choices.current.set(conversationId, next); setMode(next); },[conversationId]);
  useEffect(()=>{const open=()=>{if(conversationId){changeMode('split');void window.localAi.visualDebug.open(conversationId).then(()=>window.localAi.liveBrowser?.watch(conversationId,true)).catch(e=>setOpenError(String(e)));}};window.addEventListener('visual-open-browser',open);return()=>window.removeEventListener('visual-open-browser',open);},[conversationId,changeMode]);
  useEffect(()=>{const show=()=>changeMode('split');window.addEventListener('visual-show-browser',show);return()=>window.removeEventListener('visual-show-browser',show);},[changeMode]);
  // Reset before paint so a chat switch can never flash the other chat's frame.
  useLayoutEffect(() => {
    current.current = conversationId; session.current = null;
    setPreviewUrl('');setOpenError('');setBrowser(null); setMode(conversationId ? choices.current.get(conversationId) ?? 'chat' : 'chat');
  }, [conversationId]);
  useEffect(() => {
    const api = window.localAi.liveBrowser;
    if (!api) return;
    const unsubscribe = api.onEvent(event => {
      if (event.state.conversationId !== current.current) return;
      session.current = event.state.sessionId;
      setBrowser(event.state);
      if (!choices.current.has(event.state.conversationId)) setMode('split');
    });
    return () => { unsubscribe(); void api.watch(null, false).catch(() => undefined); };
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
    const observer = new ResizeObserver(entries => { for (const entry of entries) setNarrow(entry.contentRect.width < 680); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const browserSessionId = browser?.sessionId;
  useLayoutEffect(() => {
    if (!browserSessionId || mode === 'chat') return;
    let scheduled = 0, last = '';
    const overlays = '[aria-modal="true"],dialog[open],[role="menu"],[role="tooltip"],[role="dialog"],[role="listbox"]';
    const update = () => {
      scheduled = 0;
      const rect = screen.current?.getBoundingClientRect();
      const obscured = [...document.querySelectorAll(overlays)].some(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && (element.getAttribute('aria-modal') === 'true' || rect && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top);
      });
      const bounds = rect && !document.hidden && !obscured ? { x: rect.x, y: rect.y, width: screen.current!.clientWidth, height: screen.current!.clientHeight } : null;
      const key = JSON.stringify(bounds);
      if (last === key) return;
      last = key;
      void window.localAi.liveBrowser?.layout(browserSessionId, bounds).catch(() => undefined);
    };
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule); if (screen.current) resize.observe(screen.current);
    const mutation = new MutationObserver(records => {
      const overlay = (node: Node) => node instanceof Element && (node.matches(overlays) || Boolean(node.querySelector(overlays)));
      if (records.some(record => record.type === 'attributes' ? record.target instanceof Element && (record.target.matches(overlays) || record.target instanceof HTMLDialogElement) : [...record.addedNodes,...record.removedNodes].some(overlay))) schedule();
    }); mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal', 'class'] });
    window.addEventListener('resize', schedule); document.addEventListener('visibilitychange', schedule);
    document.addEventListener('scroll', schedule, true); update();
    return () => { cancelAnimationFrame(scheduled); resize.disconnect(); mutation.disconnect(); window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true); document.removeEventListener('visibilitychange', schedule); void window.localAi.liveBrowser?.layout(browserSessionId, null).catch(() => undefined); };
  }, [browserSessionId, mode, conversationId]);
  const interactive = browser?.ownership === 'user' && browser.status === 'live';
  const [inputError, setInputError] = useState<string | null>(null);
  const input = (event: BrowserInput) => {
    if (!interactive || !browser) return;
    void window.localAi.liveBrowser?.input(browser.sessionId, event).then(() => setInputError(null)).catch(error => setInputError(String(error).slice(0, 180)));
  };
  const workspace=browser?.workspace;
  const configure=(settings:import('../../shared/live-browser').BrowserWorkspaceSettings)=>{if(browser)void window.localAi.liveBrowser?.workspace(browser.sessionId,settings).catch(e=>setInputError(String(e)));};
  useLayoutEffect(()=>{const element=screen.current;if(!element||!workspace)return;const factor=workspace.panel.width/Math.max(1,element.clientWidth);const position=cssToPresentation(workspace.settings.pan,workspace.displayScale*workspace.browserZoom/factor);element.scrollLeft=position.x;element.scrollTop=position.y;},[workspace]);
  useEffect(()=>()=>clearTimeout(panTimer.current),[conversationId]);
  const status = browser?.status;
  const statusText = status === 'loading' ? t('Загрузка') : status === 'live' ? t('Подключён') : status === 'error' ? t('Ошибка') : t('Браузер закрыт');
  const action = browser?.action;
  return <div ref={root} className={`live-workspace mode-${mode} ${narrow ? 'is-narrow' : ''}`} style={{ '--chat-share': `${ratio}%` } as CSSProperties}>
    <div className="live-chat">{chat?.workingDirectory&&<button className="live-manual-open" disabled={running} onClick={openBrowser}><Globe size={15}/>{ru?'Открыть браузер · Visual Debugging':'Open browser · Visual Debugging'}</button>}{openError&&<p role="alert">{openError}</p>}{browser && mode === 'chat' && <button className="live-reopen" onClick={() => changeMode('split')}><Globe size={15} />{t('Живой браузер')}<span>{statusText}</span></button>}{children}</div>
    {mode === 'split' && <div className="live-divider" role="separator" aria-label={t('Размер панелей')} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)} tabIndex={0}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setRatio(value => Math.max(25, Math.min(75, value + (event.key === 'ArrowLeft' ? -3 : 3)))); } }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId) || !root.current) return; const rect = root.current.getBoundingClientRect(); setRatio(Math.max(25, Math.min(75, 100 * (event.clientX - rect.left) / rect.width))); }}
      onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />}
    <aside className="live-browser" aria-label={t('Живой браузер')} aria-hidden={mode === 'chat'}>
      <header className="live-header"><span className="live-title"><Globe size={16} />{t('Живой браузер')}</span><div className="live-view-controls">
        <button className={mode === 'split' ? 'selected' : ''} title={t('Разделённый вид')} aria-label={t('Разделённый вид')} onClick={() => changeMode('split')}><Columns2 size={15} /></button>
        <button className={mode === 'expanded' ? 'selected' : ''} title={t('Браузер на весь экран')} aria-label={t('Браузер на весь экран')} onClick={() => changeMode('expanded')}><Maximize2 size={15} /></button>
        <button title={t('Только чат')} aria-label={t('Только чат')} onClick={() => changeMode('chat')}><MessageSquare size={15} /></button>
        <button title={t('Закрыть браузер')} aria-label={t('Закрыть браузер')} onClick={() => { if (browser) void window.localAi.liveBrowser?.close(browser.sessionId).catch(() => undefined); changeMode('chat'); }}><X size={16} /></button>
      </div></header>
      <div className="live-address"><button disabled={!interactive} title={t('Назад')} aria-label={t('Назад')} onClick={() => input({ kind: 'back' })}><ArrowLeft size={14} /></button><button disabled={!interactive} title={t('Вперёд')} aria-label={t('Вперёд')} onClick={() => input({ kind: 'forward' })}><ArrowRight size={14} /></button><button disabled={!interactive} title={t('Обновить')} aria-label={t('Обновить')} onClick={() => input({ kind: 'reload' })}><RefreshCw size={14} /></button><span className={`live-dot ${status ?? ''}`} /><span title={browser?.url}>{browser?.url || t('Ожидание страницы')}</span></div>
      <form className="visual-preview-url" onSubmit={e=>{e.preventDefault();openBrowser();}}><input aria-label={t('Разрешённый адрес preview')} placeholder={t('Файл проекта index.html или http://127.0.0.1:PORT')} value={previewUrl} onChange={e=>setPreviewUrl(e.target.value)}/><button disabled={running}>{ru?'Открыть URL':'Open URL'}</button></form>
      <VisualDebugPanel conversationId={conversationId} interactive={Boolean(interactive)}/>
      <BrowserWorkspaceControls state={workspace} disabled={!interactive||running} onChange={configure}/>
      <div ref={screen} className="live-screen native-browser-surface" onScroll={e=>{if(!workspace||!interactive||running)return;const element=e.currentTarget,factor=workspace.panel.width/Math.max(1,element.clientWidth),pan=presentationToCss({x:element.scrollLeft,y:element.scrollTop},workspace.displayScale*workspace.browserZoom/factor);if(Math.abs(pan.x-workspace.settings.pan.x)<1&&Math.abs(pan.y-workspace.settings.pan.y)<1)return;clearTimeout(panTimer.current);panTimer.current=setTimeout(()=>configure({...workspace.settings,pan}),60);}} tabIndex={interactive ? 0 : -1} onFocus={() => input({kind:'focus'})} aria-label={t('Страница браузера агента')}>
        {workspace&&<div aria-hidden="true" className="browser-virtual-surface" style={{width:workspace.surface.width/(Math.max(1,workspace.panel.width)/Math.max(1,screen.current?.clientWidth??workspace.panel.width)),height:workspace.surface.height/(Math.max(1,workspace.panel.height)/Math.max(1,screen.current?.clientHeight??workspace.panel.height))}}/>}
        {!browser && <div className="live-empty"><Globe size={28} />{t('Агент откроет страницу через web_project')}</div>}
      </div>
      <footer className="live-footer">{browser&&!interactive&&!running&&<button onClick={openBrowser}>{ru?'Вернуть управление':'Take control'}</button>}<span><Radio size={12} />{statusText}</span><span>{status === 'live' ? 'Chromium' : ''}</span><span className="live-action-label" title={action?.kind}>{interactive ? t('Вы управляете браузером') : browser?.ownership==='recovering'?(ru?'Браузер восстанавливается':'Browser recovering'):browser?.ownership==='blocked'?(ru?'Браузер заблокирован политикой':'Browser blocked by policy'): browser?.ownership === 'paused' ? t('Пауза') : browser?.ownership === 'closed' ? t('Браузер закрыт') : status === 'error' ? t('Браузер недоступен') : browser ? t('Агент управляет браузером') : t('Ожидание страницы')}</span>
        <ControlHelp label={t('Состояние браузера')}>{interactive ? t('Страница передана вам: можно нажимать, прокручивать и вводить текст.') : browser?.ownership === 'agent' ? t('Агент сейчас управляет этой страницей. После завершения задачи управление перейдёт вам.') : status === 'error' ? t('Браузер недоступен; проверьте сообщение об ошибке и повторно откройте страницу, если это безопасно.') : t('Браузер ожидает действий агента или открытия страницы.')}</ControlHelp>
        <button title={t('Переподключить просмотр')} aria-label={t('Переподключить просмотр')} onClick={() => { void window.localAi.liveBrowser?.watch(conversationId, true).catch(() => undefined); }}><RefreshCw size={13} /></button>
        {mode === 'expanded' && <button aria-label={t('Показать чат')} title={t('Показать чат')} onClick={() => changeMode('split')}><MessageSquare size={13} /></button>}
      </footer>
      {inputError && <p role="status" className="live-error">{inputError}</p>}
      {browser?.error && <p className="live-error" role="status">{browser.error}</p>}
    </aside>
  </div>;
}
