/** Local AI Desktop: compact workspace around the real shared native Page. */
import './liveBrowser.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe,
  Columns2,
  Maximize2,
  X,
  MousePointer2,
  Hand,
  ScanLine,
  Layers,
  SlidersHorizontal,
  LocateFixed,
  ChevronDown,
  Send,
  Trash2,
  Plus,
  Link2,
  LoaderCircle,
  CheckCircle2,
  SearchCheck,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu';
import { useLiveBrowser } from './useLiveBrowser';
import { useNativeBrowserView } from './useNativeBrowserView';
import { setPendingSelection } from './pendingContext';
import { buildAreaContextText } from '../../../live-browser/shared/context';
import { type LadArea, LAD_REGION_STATUSES } from '../../../live-browser/shared/types';
import { SelectionOverlay } from './SelectionOverlay';

interface Props {
  sessionId: string;
  mode: 'split' | 'expanded';
  onModeChange: (mode: 'split' | 'expanded' | 'chatOnly') => void;
  panelWidth: number;
  onPanelWidthChange: (width: number) => void;
  projectId?: string | null;
}
interface Preferences {
  viewport: 'auto' | { width: number; height: number };
  splitRatio: number;
  zoom: number;
  previewScale: 'fit' | number;
  pan: { x: number; y: number };
  toolsWidth: number;
  toolsHeight: number;
  toolsDock: 'side' | 'bottom';
}
const defaults: Preferences = {
  viewport: 'auto',
  splitRatio: 0.55,
  zoom: 1,
  previewScale: 'fit',
  pan: { x: 0, y: 0 },
  toolsWidth: 300,
  toolsHeight: 220,
  toolsDock: 'side',
};
const presets = [
  ['Auto', 'auto'],
  ['Mobile', '390x844'],
  ['Tablet', '768x1024'],
  ['Desktop', '1440x900'],
  ['Full HD', '1920x1080'],
  ['4K', '3840x2160'],
] as const;
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="lb2-choice" aria-label={label}>
          <span>{value}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="z-[200]">
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function LiveBrowserPanel({
  sessionId,
  mode,
  onModeChange,
  panelWidth,
  onPanelWidthChange,
  projectId,
}: Props) {
  const intl = useIntl();
  const ru = intl.locale.startsWith('ru');
  const t = (en: string, rus: string) => (ru ? rus : en);
  const live = useLiveBrowser(sessionId);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Preferences>(defaults);
  const [inspector, setInspector] = useState(false),
    [display, setDisplay] = useState(false),
    [interaction, setInteraction] = useState<'interact' | 'pan' | 'select'>('interact');
  const [replacing, setReplacing] = useState<{ id: string; at: string } | null>(null);
  const [crop, setCrop] = useState<{ id: string; url: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [address, setAddress] = useState(''),
    [draftAddress, setDraftAddress] = useState(false),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [navigating, setNavigating] = useState(false),
    [search, setSearch] = useState('');
  const vision = live.workspace.vision === 'on';
  const setVision = (enabled: boolean) =>
    void live.setWorkspacePatch({ vision: enabled ? 'on' : 'off' });
  const [custom, setCustom] = useState({ width: 1440, height: 900 });
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  useEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const measure = () => setWorkspaceWidth(parent.getBoundingClientRect().width);
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    measure();
    return () => observer.disconnect();
  }, []);
  const effectivePanelWidth = workspaceWidth
    ? Math.max(320, Math.min(workspaceWidth - 320, Math.round(workspaceWidth * prefs.splitRatio)))
    : panelWidth;
  const settings = useMemo(() => ({ ...prefs, mode: interaction }), [prefs, interaction]);
  const surface = useNativeBrowserView(
    sessionId,
    settings,
    Boolean(workspaceReady && live.meta?.native && live.meta.url !== 'about:blank'),
    setNativeError
  );
  const patch = (value: Partial<Preferences>) =>
    setPrefs((previous) => ({ ...previous, ...value }));
  const resizePanel = (width: number) => {
    onPanelWidthChange(width);
    if (workspaceWidth)
      patch({ splitRatio: Math.max(0.25, Math.min(0.75, width / workspaceWidth)) });
  };
  useEffect(() => {
    let cancelled = false;
    setWorkspaceReady(false);
    try {
      const saved = JSON.parse(localStorage.getItem(`lad.browser2:${sessionId}`) || '{}');
      setPrefs({
        ...defaults,
        ...saved,
        splitRatio: Number.isFinite(saved.splitRatio)
          ? Math.max(0.25, Math.min(0.75, saved.splitRatio))
          : defaults.splitRatio,
      });
    } catch {
      setPrefs(defaults);
    }
    setNativeError(null);
    setSelected(null);
    setInspector(false);
    setInteraction('interact');
    void window.electron
      .liveBrowserWorkspaceRead(sessionId)
      .then((native) => {
        if (cancelled) return;
        if (native) setPrefs((previous) => ({ ...previous, ...native }));
        setWorkspaceReady(true);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  useEffect(() => {
    try {
      localStorage.setItem(`lad.browser2:${sessionId}`, JSON.stringify(prefs));
    } catch {
      /* Storage unavailable. */
    }
  }, [prefs, sessionId]);
  useEffect(() => {
    void window.electron?.liveBrowserRegister?.(sessionId);
  }, [sessionId]);
  useEffect(() => {
    if (!draftAddress) setAddress(live.meta?.url === 'about:blank' ? '' : (live.meta?.url ?? ''));
  }, [live.meta?.url, draftAddress]);
  useEffect(
    () =>
      window.electron?.liveBrowserPan?.((value) => {
        if (value.conversationId === sessionId)
          setPrefs((previous) => ({ ...previous, pan: value.pan }));
      }),
    [sessionId]
  );
  useEffect(
    () =>
      window.electron?.liveBrowserWorkspace?.((value) => {
        if (value.conversationId === sessionId)
          setPrefs((previous) => ({ ...previous, viewport: value.viewport, zoom: value.zoom }));
      }),
    [sessionId]
  );
  useEffect(() => {
    if (live.meta?.ownership === 'agent') setInteraction('interact');
  }, [live.meta?.ownership]);
  useEffect(() => {
    if (replacing && live.regions.find((r) => r.id === replacing.id)?.updatedAt !== replacing.at) {
      setReplacing(null);
      setInteraction('interact');
    }
  }, [replacing, live.regions]);
  useEffect(() => {
    setReplacing(null);
    setCrop(null);
  }, [sessionId]);
  const previousCount = useRef(0);
  useEffect(() => {
    if (live.regions.length > previousCount.current && interaction === 'select') {
      setSelected(live.regions.at(-1)?.areaId ?? null);
      setInspector(true);
      setInteraction('interact');
    }
    previousCount.current = live.regions.length;
  }, [live.regions, interaction]);
  useEffect(() => {
    if (!live.connected) return;
    void live
      .act({
        action: 'selection',
        value:
          interaction === 'select'
            ? replacing
              ? `replace:${replacing.id}`
              : (selected ?? 'new')
            : 'off',
      })
      .catch(() => undefined);
  }, [interaction, selected, replacing, live.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const action = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  const navigate = () => {
    setDraftAddress(false);
    if (address.trim() && !navigating)
      void action(async () => {
        setNavigating(true);
        try {
          await live.navigate('open', address.trim());
        } finally {
          setNavigating(false);
        }
      });
  };
  const area = live.areas.find((a) => a.id === selected);
  const areas = live.areas.filter((a) =>
    `${a.name} ${a.description ?? ''}`.toLowerCase().includes(search.toLowerCase())
  );
  const regions = live.regions.filter((r) => area?.regionIds.includes(r.id));
  const include = async (selectedArea: LadArea) => {
    setBusy(true);
    try {
      const fresh = await Promise.all(
        live.regions
          .filter((r) => selectedArea.regionIds.includes(r.id))
          .map((r) => live.liveProjection(r.id))
      );
      const images: { data: string; mimeType: string }[] = [];
      if (vision)
        for (const region of fresh.slice(0, 3)) {
          if (region.live?.stale || !region.live?.rect) continue;
          try {
            const crop = await live.captureRegionCrop(region.live.rect, 1000);
            images.push({ data: crop.data, mimeType: crop.mime });
          } catch {
            /* Text evidence remains available. */
          }
        }
      const text = buildAreaContextText({
        areas: [selectedArea],
        regions: fresh,
        vision: vision ? 'on' : 'off',
        project: projectId
          ? projectId.startsWith('/')
            ? { name: projectId.split('/').at(-1), root: projectId }
            : { name: projectId }
          : undefined,
        live: Object.fromEntries(
          fresh
            .filter((r) => r.live)
            .map((r) => [
              r.id,
              { stale: r.live!.stale, reason: r.live!.reason, at: r.live!.observedAt },
            ])
        ),
      });
      const attachment = {
        id: window.crypto.randomUUID(),
        name: selectedArea.name,
        regionCount: fresh.length,
        projectRoot: projectId?.startsWith('/') ? projectId : undefined,
        projectBound: Boolean(projectId),
        url: fresh[0]?.url,
        vision,
        text: text
          .split('\n')
          .filter((line) => !line.startsWith('Project:'))
          .join('\n'),
        images,
      };
      setPendingSelection({
        text: '',
        images: [],
        areaNames: [selectedArea.name],
        createdAt: Date.now(),
        conversationId: sessionId,
        attachments: [attachment],
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const setViewport = (value: string) => {
    const viewport =
      value === 'auto'
        ? 'auto'
        : { width: Number(value.split('x')[0]), height: Number(value.split('x')[1]) };
    patch({ viewport, pan: { x: 0, y: 0 } });
    if (viewport !== 'auto')
      void action(() => live.setViewportSize({ ...viewport, zoom: prefs.zoom }));
  };
  const icon = (
    label: string,
    content: React.ReactNode,
    run: () => void,
    active = false,
    id?: string
  ) => (
    <button
      type="button"
      className={`lb2-icon ${active ? 'is-active' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={run}
      data-testid={id}
    >
      {content}
    </button>
  );
  return (
    <section
      ref={root}
      data-testid="live-browser-panel"
      data-mode={mode}
      className="lb2-panel no-drag"
      style={
        mode === 'split'
          ? { width: effectivePanelWidth, maxWidth: 'calc(100% - 320px)' }
          : { flex: 1, width: '100%' }
      }
    >
      {mode === 'split' && (
        <div
          className="lb2-splitter"
          role="separator"
          tabIndex={0}
          aria-label="Resize browser"
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={3840}
          aria-valuenow={effectivePanelWidth}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId) && root.current)
              resizePanel(
                Math.max(
                  320,
                  Math.min(
                    window.innerWidth - 320,
                    root.current.getBoundingClientRect().right - e.clientX
                  )
                )
              );
          }}
          onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
          onKeyDown={(e) => {
            if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
              e.preventDefault();
              resizePanel(
                Math.max(
                  320,
                  Math.min(
                    window.innerWidth - 320,
                    effectivePanelWidth + (e.key === 'ArrowLeft' ? 32 : -32)
                  )
                )
              );
            }
          }}
        />
      )}
      <header className="lb2-header">
        <span className="lb2-title">
          <Globe size={15} />
          Live Browser <i className={live.connected ? 'connected' : ''} />
        </span>
        <span
          className="lb2-project"
          title={
            projectId ??
            t(
              'No project bound. Choose a project in session settings.',
              'Проект не привязан. Выберите проект в настройках чата.'
            )
          }
        >
          <Link2 size={12} />
          {projectId ?? t('No project', 'Без проекта')}
        </span>
        <div className="lb2-spacer" />
        {icon(
          t('Find layout candidates', 'Найти проблемы вёрстки'),
          <SearchCheck size={15} />,
          () => void action(() => live.act({ action: 'detect' }))
        )}
        {icon(
          t('Split', 'Разделить'),
          <Columns2 size={15} />,
          () => onModeChange('split'),
          mode === 'split',
          'live-browser-mode-split'
        )}
        {icon(
          t('Expand', 'Развернуть'),
          <Maximize2 size={15} />,
          () => onModeChange('expanded'),
          mode === 'expanded',
          'live-browser-mode-expanded'
        )}
        {icon(
          t('Hide browser', 'Скрыть браузер'),
          <X size={16} />,
          () => onModeChange('chatOnly'),
          false,
          'live-browser-mode-close'
        )}
      </header>
      <form
        className="lb2-navigation"
        onSubmit={(e) => {
          e.preventDefault();
          navigate();
        }}
      >
        {icon(
          t('Back', 'Назад'),
          <ArrowLeft size={15} />,
          () => void action(() => live.navigate('back')),
          false,
          'live-browser-back'
        )}
        {icon(
          t('Forward', 'Вперёд'),
          <ArrowRight size={15} />,
          () => void action(() => live.navigate('forward')),
          false,
          'live-browser-forward'
        )}
        {icon(
          t('Reload', 'Обновить'),
          <RotateCw size={14} />,
          () => void action(() => live.navigate('reload')),
          false,
          'live-browser-reload'
        )}
        <Input
          data-testid="live-browser-url-input"
          className="lb2-address"
          aria-label={t('Page address', 'Адрес страницы')}
          placeholder="https://example.com"
          value={address}
          onFocus={() => setDraftAddress(true)}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraftAddress(false);
              e.currentTarget.blur();
            }
          }}
        />
        <button
          className="lb2-go"
          aria-label={t('Open page', 'Открыть страницу')}
          data-testid="live-browser-open"
          disabled={!address.trim() || navigating}
        >
          {live.connecting || navigating ? (
            <LoaderCircle size={15} className="animate-spin" />
          ) : (
            <ArrowRight size={15} />
          )}
        </button>
      </form>
      <div className="lb2-toolbar">
        <div
          className="lb2-modes"
          role="group"
          aria-label={t('Interaction mode', 'Режим взаимодействия')}
        >
          {icon(
            t('Interact with page', 'Работать со страницей'),
            <MousePointer2 size={15} />,
            () => setInteraction('interact'),
            interaction === 'interact'
          )}
          {icon(
            t(
              'Pan preview • middle drag also works',
              'Перемещать предпросмотр • также средней кнопкой'
            ),
            <Hand size={15} />,
            () => setInteraction('pan'),
            interaction === 'pan'
          )}
          {icon(
            t('Select a region for AI', 'Выделить область для AI'),
            <ScanLine size={15} />,
            () => {
              setSelected(null);
              setInteraction('select');
            },
            interaction === 'select',
            'live-browser-new-area'
          )}
        </div>
        <button
          className={`lb2-display-trigger ${display ? 'is-active' : ''}`}
          onClick={() => setDisplay(!display)}
          aria-expanded={display}
          data-testid="live-browser-display"
        >
          <SlidersHorizontal size={14} />
          <span>
            {prefs.viewport === 'auto'
              ? 'Auto'
              : `${prefs.viewport.width} × ${prefs.viewport.height}`}
          </span>
          <span className="lb2-dim">{Math.round(prefs.zoom * 100)}%</span>
          <ChevronDown size={12} />
        </button>
        <div className="lb2-spacer" />
        {icon(t('Reset preview', 'Сбросить положение'), <LocateFixed size={15} />, () =>
          patch({ previewScale: 'fit', pan: { x: 0, y: 0 } })
        )}
        <button
          className={`lb2-areas-trigger ${inspector ? 'is-active' : ''}`}
          onClick={() => setInspector(!inspector)}
          aria-expanded={inspector}
          data-testid="live-browser-tools-toggle"
        >
          <Layers size={15} />
          {t('Areas', 'Области')}
          <span>{live.areas.length}</span>
        </button>
      </div>
      {display && (
        <div className="lb2-display" data-testid="live-browser-display-settings">
          <label>
            Viewport
            <Choice
              label="Viewport preset"
              value={
                prefs.viewport === 'auto'
                  ? 'Auto'
                  : `${prefs.viewport.width} × ${prefs.viewport.height}`
              }
              options={presets.map((p) => ({ label: p[0], value: p[1] }))}
              onChange={setViewport}
            />
          </label>
          <label>
            {t('Page zoom', 'Масштаб страницы')}
            <Choice
              label="Page zoom"
              value={`${Math.round(prefs.zoom * 100)}%`}
              options={[0.25, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((n) => ({
                value: String(n),
                label: `${Math.round(n * 100)}%`,
              }))}
              onChange={(value) => {
                const zoom = Number(value);
                patch({ zoom, pan: { x: 0, y: 0 } });
                if (prefs.viewport !== 'auto')
                  void action(() =>
                    live.setViewportSize({
                      width: (prefs.viewport as { width: number; height: number }).width,
                      height: (prefs.viewport as { width: number; height: number }).height,
                      zoom,
                    })
                  );
              }}
            />
          </label>
          <label>
            {t('Preview', 'Предпросмотр')}
            <Choice
              label="Preview scale"
              value={prefs.previewScale === 'fit' ? 'Fit' : `${Number(prefs.previewScale) * 100}%`}
              options={[
                { label: 'Fit', value: 'fit' },
                ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => ({
                  label: `${n * 100}%`,
                  value: String(n),
                })),
              ]}
              onChange={(value) =>
                patch({
                  previewScale: value === 'fit' ? 'fit' : Number(value),
                  pan: { x: 0, y: 0 },
                })
              }
            />
          </label>
          <form
            className="lb2-custom"
            onSubmit={(e) => {
              e.preventDefault();
              setViewport(`${custom.width}x${custom.height}`);
            }}
          >
            <input
              type="number"
              aria-label="Viewport width"
              min={320}
              max={4096}
              value={custom.width}
              onChange={(e) => setCustom({ ...custom, width: Number(e.target.value) })}
            />
            <span>×</span>
            <input
              type="number"
              aria-label="Viewport height"
              min={240}
              max={4096}
              value={custom.height}
              onChange={(e) => setCustom({ ...custom, height: Number(e.target.value) })}
            />
            <button aria-label="Apply viewport">
              <CheckCircle2 size={15} />
            </button>
          </form>
          <p>
            {t(
              'Page zoom changes the page. Preview changes only its presentation. Middle drag pans; the wheel pans in Hand mode and scrolls the site in Interact mode.',
              'Масштаб страницы меняет страницу; предпросмотр — только её показ. Средняя кнопка перемещает поверхность. В режиме руки колесо двигает предпросмотр, в режиме указателя — страницу.'
            )}
          </p>
        </div>
      )}
      {(nativeError || error || live.lastError || live.runtime.error) && (
        <div className="lb2-error" role="alert">
          <span>
            {nativeError?.includes('another window')
              ? t(
                  'This browser is attached to another window. Return to that window to use it.',
                  'Браузер этого чата открыт в другом окне. Перейдите в то окно.'
                )
              : nativeError || error || live.lastError || live.runtime.error}
          </span>
          <button onClick={live.retryRuntime}>{t('Reconnect', 'Переподключить')}</button>
        </div>
      )}
      <div className={`lb2-body ${prefs.toolsDock === 'bottom' ? 'dock-bottom' : ''}`}>
        <div
          ref={surface}
          className="lb2-stage"
          data-testid="live-browser-surface"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setInteraction('interact');
          }}
        >
          {!live.meta?.native && (
            <div className="lb2-fallback">
              <canvas
                ref={(el) => {
                  canvas.current = el;
                  live.attachCanvas(el);
                }}
                data-testid="live-browser-canvas"
              />
              <SelectionOverlay
                canvas={canvas.current}
                meta={
                  live.meta
                    ? { viewport: live.meta.viewport, dpr: live.meta.dpr, zoom: live.meta.zoom }
                    : null
                }
                regions={live.regions}
                areas={live.areas}
                active={interaction === 'select'}
                onCommit={(rect) =>
                  void action(() => live.ground(rect, { areaId: selected ?? undefined }))
                }
                getScroll={live.scrollSnapshot}
                selectedRegionIds={[]}
              />
            </div>
          )}
          {(!live.runtime.endpoint || !live.meta || live.meta.url === 'about:blank') && (
            <div className="lb2-empty">
              <Globe size={32} />
              <strong>{t('Your browser workspace', 'Ваше браузерное пространство')}</strong>
              <p>
                {t(
                  'Open an address above. Select a region when you need the agent to inspect it.',
                  'Откройте адрес выше. Выделите область, когда нужна помощь агента.'
                )}
              </p>
              {live.connecting && <LoaderCircle className="animate-spin" size={16} />}
            </div>
          )}
        </div>
        {inspector && (
          <>
            <div
              className="lb2-inspector-resize"
              role="separator"
              tabIndex={0}
              aria-label="Resize areas"
              aria-orientation={prefs.toolsDock === 'side' ? 'vertical' : 'horizontal'}
              aria-valuemin={240}
              aria-valuemax={520}
              aria-valuenow={prefs.toolsWidth}
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId) && root.current) {
                  const b = root.current.getBoundingClientRect();
                  patch(
                    prefs.toolsDock === 'side'
                      ? { toolsWidth: Math.max(240, Math.min(520, b.right - e.clientX)) }
                      : { toolsHeight: Math.max(150, Math.min(360, b.bottom - e.clientY)) }
                  );
                }
              }}
              onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
              onKeyDown={(e) => {
                if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                  e.preventDefault();
                  patch({
                    toolsWidth: Math.max(
                      240,
                      Math.min(520, prefs.toolsWidth + (e.key === 'ArrowLeft' ? 16 : -16))
                    ),
                  });
                }
              }}
            />
            <aside
              className="lb2-inspector"
              data-testid="live-browser-areas"
              style={
                prefs.toolsDock === 'side'
                  ? { width: prefs.toolsWidth }
                  : { height: prefs.toolsHeight }
              }
            >
              <div className="lb2-inspector-heading">
                <strong>
                  {t('Areas', 'Области')} <span>{live.areas.length}</span>
                </strong>
                <div className="lb2-spacer" />
                <Choice
                  label="Inspector position"
                  value={prefs.toolsDock === 'side' ? '↔' : '↕'}
                  options={[
                    { label: t('Side inspector', 'Сбоку'), value: 'side' },
                    { label: t('Bottom inspector', 'Снизу'), value: 'bottom' },
                  ]}
                  onChange={(value) => patch({ toolsDock: value as Preferences['toolsDock'] })}
                />
                {icon(t('Close areas', 'Закрыть области'), <X size={14} />, () =>
                  setInspector(false)
                )}
              </div>
              {live.areas.length > 5 && (
                <Input
                  className="h-7 text-xs"
                  aria-label="Find area"
                  placeholder={t('Find area…', 'Найти область…')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              )}
              <div className="lb2-area-list">
                {areas.map((a) => (
                  <button
                    data-testid="live-browser-area-row"
                    key={a.id}
                    className={`lb2-area-row ${selected === a.id ? 'selected' : ''}`}
                    onClick={() => {
                      setSelected(a.id);
                      if (a.regionIds[0])
                        void action(() => live.act({ action: 'reveal', value: a.regionIds[0] }));
                    }}
                  >
                    <i style={{ background: a.color }} />
                    <span>{a.name}</span>
                    <small>{a.regionIds.length}</small>
                  </button>
                ))}
                {!areas.length && (
                  <p className="lb2-hint">
                    {t(
                      'Use the selection tool to mark a region.',
                      'Выделите область инструментом на панели.'
                    )}
                  </p>
                )}
              </div>
              {area && (
                <article className="lb2-area-editor" data-testid="live-browser-area">
                  <Input
                    data-testid="live-browser-area-name"
                    aria-label="Area name"
                    defaultValue={area.name}
                    key={area.id}
                    onBlur={(e) => {
                      if (e.target.value.trim() !== area.name)
                        void action(() =>
                          live.updateArea(area.id, { name: e.target.value.trim() })
                        );
                    }}
                  />
                  <textarea
                    data-testid="live-browser-area-desc"
                    aria-label="Area description"
                    key={`${area.id}-description`}
                    defaultValue={area.description}
                    placeholder={t('What should change?', 'Что нужно изменить?')}
                    rows={2}
                    onBlur={(e) =>
                      void action(() => live.updateArea(area.id, { description: e.target.value }))
                    }
                  />
                  <div className="lb2-editor-row">
                    <Choice
                      label="Area status"
                      value={
                        area.status === 'Verified' && area.verification?.outcome !== 'Verified'
                          ? t('Legacy claim • unverified', 'Старая запись • не проверено')
                          : area.status
                      }
                      options={LAD_REGION_STATUSES.filter((s) => s !== 'Verified').map((s) => ({
                        value: s,
                        label: s,
                      }))}
                      onChange={(status) => void action(() => live.updateArea(area.id, { status }))}
                    />
                    {icon(t('Add region', 'Добавить выделение'), <Plus size={14} />, () =>
                      setInteraction('select')
                    )}
                    {icon(
                      t('Remove area', 'Удалить область'),
                      <Trash2 size={14} />,
                      () => void action(() => live.removeArea(area.id))
                    )}
                  </div>
                  <label className="lb2-vision">
                    <input
                      type="checkbox"
                      checked={vision}
                      onChange={(e) => setVision(e.target.checked)}
                    />
                    Vision <span>{t('Include current crop', 'Прикрепить изображение')}</span>
                  </label>
                  <Button
                    className="w-full h-8 text-xs"
                    data-testid="live-browser-area-send"
                    disabled={busy}
                    onClick={() => void include(area)}
                  >
                    {busy ? (
                      <LoaderCircle size={14} className="animate-spin" />
                    ) : (
                      <Send size={14} />
                    )}{' '}
                    {t('Attach to message', 'Прикрепить к сообщению')}
                  </Button>
                  <button
                    className="lb2-recheck"
                    onClick={() =>
                      void action(async () => {
                        await live.act({ action: 'recheck', value: area.id });
                      })
                    }
                  >
                    <RotateCw size={12} />
                    {t('Recheck text fitting', 'Перепроверить обрезку текста')}
                  </button>
                  <div className="lb2-workflow">
                    <Choice
                      label={t('Task workflow', 'Состояние задачи')}
                      value={area.workflow?.state ?? 'active'}
                      options={[
                        { value: 'active', label: t('Active task', 'В работе') },
                        { value: 'completed', label: t('Complete task', 'Завершить задачу') },
                        { value: 'disputed', label: t('Dispute result', 'Оспорить результат') },
                      ]}
                      onChange={(value) =>
                        void action(() =>
                          live.act({ action: 'workflow', value: `${area.id}:${value}` })
                        )
                      }
                    />
                    <span className="lb2-dim">
                      {t('Completion does not certify a fix', 'Завершение не означает Verified')}
                    </span>
                  </div>
                  {area.verification && (
                    <p role="status" className="lb2-dim" data-testid="area-verification">
                      {area.verification.outcome} ·{' '}
                      {area.verification.reason ??
                        area.verification.source?.fingerprint.slice(0, 12)}
                    </p>
                  )}
                  <details>
                    <summary>{t('Evidence & history', 'Данные и история')}</summary>
                    <div className="lb2-evidence">
                      {regions.map((region) => (
                        <div key={region.id}>
                          <code>{region.id}</code>
                          <div className="flex gap-2 flex-wrap">
                            <button
                              onClick={() =>
                                void action(() => live.act({ action: 'reveal', value: region.id }))
                              }
                            >
                              {t('Reveal', 'Показать')}
                            </button>
                            <button
                              onClick={() =>
                                void action(() =>
                                  live.act({ action: 'navigate-region', value: region.id })
                                )
                              }
                            >
                              {t('Open saved page', 'Открыть сохранённую страницу')}
                            </button>
                            <button
                              onClick={() => {
                                setReplacing({ id: region.id, at: region.updatedAt });
                                setInteraction('select');
                              }}
                            >
                              {t('Reselect', 'Выделить заново')}
                            </button>
                            <button onClick={() => void action(() => live.removeRegion(region.id))}>
                              {t('Remove region', 'Удалить регион')}
                            </button>
                          </div>
                          {region.history?.map((evidence) => (
                            <details key={evidence.id} className="lb2-history-capture">
                              <summary>
                                {evidence.at} · {evidence.kind}
                              </summary>
                              <p>
                                {t(
                                  'Historical evidence, not current page state',
                                  'Исторические данные, не текущее состояние страницы'
                                )}
                              </p>
                              <p>{evidence.diagnostics.join(' · ')}</p>
                              <pre>
                                {JSON.stringify(
                                  {
                                    url: evidence.url,
                                    viewport: evidence.viewport,
                                    rect: evidence.rect,
                                    anchors: evidence.anchors,
                                    snapshot: evidence.snapshot,
                                  },
                                  null,
                                  2
                                )}
                              </pre>
                              {evidence.cropId && (
                                <button
                                  onClick={() =>
                                    void action(async () => {
                                      const endpoint = live.runtime.endpoint;
                                      if (!endpoint) return;
                                      const response = await fetch(
                                        `${endpoint.url}/control/evidence?conversation=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(evidence.cropId!)}`,
                                        { headers: { Authorization: `Bearer ${endpoint.token}` } }
                                      );
                                      if (!response.ok)
                                        throw new Error('Historical crop unavailable');
                                      const { evidence: image } = await response.json();
                                      if (image?.data)
                                        setCrop({
                                          id: evidence.id,
                                          url: `data:${image.mime};base64,${image.data}`,
                                        });
                                    })
                                  }
                                >
                                  {t('View saved crop', 'Сохранённый снимок')}
                                </button>
                              )}
                              {crop?.id === evidence.id && (
                                <img
                                  src={crop.url}
                                  alt={t(
                                    'Historical selection, not current page',
                                    'Историческое выделение, не текущая страница'
                                  )}
                                  className="max-w-full"
                                />
                              )}
                            </details>
                          ))}
                          <p>
                            {region.route} · {region.viewport.width}×{region.viewport.height}
                          </p>
                          <pre>
                            {JSON.stringify(
                              {
                                rect: region.rect,
                                anchors: region.anchors,
                                live: region.live,
                                diagnostics: region.diagnostics,
                              },
                              null,
                              2
                            )}
                          </pre>
                        </div>
                      ))}
                      {area.ledger?.map((record) => (
                        <details key={record.id}>
                          <summary>
                            {record.at} · {record.outcome}
                          </summary>
                          <pre>{JSON.stringify(record, null, 2)}</pre>
                        </details>
                      ))}
                      {area.events.map((event, index) => (
                        <p key={index}>
                          {event.at} · {event.action}
                        </p>
                      ))}
                    </div>
                  </details>
                </article>
              )}
            </aside>
          </>
        )}
      </div>
      <footer className="lb2-footer">
        <span className={live.connected ? 'connected' : ''}>●</span>
        {live.meta?.ownership === 'agent'
          ? t('Agent is controlling the page', 'Агент управляет страницей')
          : live.connected
            ? t('Connected', 'Подключён')
            : t('Connecting', 'Подключение')}
        <span className="lb2-dim">
          {live.meta?.native ? 'Native Chromium' : 'Chromium'} · {live.meta?.viewport.width ?? '–'}{' '}
          × {live.meta?.viewport.height ?? '–'}
        </span>
        <div className="lb2-spacer" />
        <span>
          {interaction === 'select'
            ? t('Drag to select • Esc to cancel', 'Выделите прямоугольник • Esc — отмена')
            : interaction === 'pan'
              ? t('Drag to pan', 'Перетаскивайте поверхность')
              : t('Page interaction', 'Управление страницей')}
        </span>
      </footer>
    </section>
  );
}
