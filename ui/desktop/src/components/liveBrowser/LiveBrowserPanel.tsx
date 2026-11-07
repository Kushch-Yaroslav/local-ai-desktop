/**
 * LiveBrowserPanel — the right-side Live Browser panel for one chat.
 *
 * Layout (Split mode): chat on the left, this panel on the right.
 * The panel renders the live screencast of the SAME Playwright Page the Goose
 * agent drives (MCP browser_* tools → runtime → Playwright Page → screencast).
 *
 * Regions: the user toggles "New area", drags a rectangle, renames/annotates
 * the area, picks its status, inspects technical data (geometry, anchors,
 * diagnostics), marks areas for the next agent message, and records checks.
 * Hiding the panel (chatOnly) never stops the browser or the agent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import {
  ChevronLeft,
  ChevronRight,
  Globe,
  LayoutPanelLeft,
  LoaderCircle,
  Maximize2,
  MousePointerSquareDashed,
  RotateCw,
  X,
} from 'lucide-react';
import { cn } from '../../utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/Select';
import { Switch } from '../ui/switch';
import { i18n } from './i18n';
import { SelectionOverlay } from './SelectionOverlay';
import { useLiveBrowser } from './useLiveBrowser';
import { peekPendingSelection, setPendingSelection } from './pendingContext';
import { buildAreaContextText } from '../../../live-browser/shared/context';
import {
  LAD_REGION_STATUSES,
  type LadArea,
  type LadRegion,
} from '../../../live-browser/shared/types';

/** Per-region live-check summary in the shape buildAreaContextText expects. */
function liveRecord(
  regions: LadRegion[],
): Record<string, { stale: boolean; reason?: string; at: string }> {
  const record: Record<string, { stale: boolean; reason?: string; at: string }> = {};
  for (const region of regions) {
    if (region.live) {
      record[region.id] = { stale: region.live.stale, reason: region.live.reason, at: region.live.observedAt };
    }
  }
  return record;
}

const ZOOM_OPTIONS = ['0.5', '0.75', '1', '1.25', '1.5', '2'] as const;

interface LiveBrowserPanelProps {
  sessionId: string;
  /** 'split' = side by side; 'expanded' = panel fills the view. */
  mode: 'split' | 'expanded';
  onModeChange: (mode: 'split' | 'expanded' | 'chatOnly') => void;
  panelWidth: number;
  onPanelWidthChange: (width: number) => void;
}

export function LiveBrowserPanel({
  sessionId,
  mode,
  onModeChange,
  panelWidth,
  onPanelWidthChange,
}: LiveBrowserPanelProps) {
  const intl = useIntl();
  const live = useLiveBrowser(sessionId);
  const attachCanvas = live.attachCanvas;
  const [urlInput, setUrlInput] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [includeAreaIds, setIncludeAreaIds] = useState<Set<string>>(new Set());
  const [expandedAreaId, setExpandedAreaId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<Record<string, string>>({});
  const [descDraft, setDescDraft] = useState<Record<string, string>>({});
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const [scroll, setScroll] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // Keep the canvas attached for frame drawing.
  useEffect(() => {
    attachCanvas(canvasRef.current);
    return () => attachCanvas(null);
  }, [attachCanvas]);

  // Keep the live scroll snapshot fresh while the panel is mounted so region
  // outlines track the page position correctly.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      live.scrollSnapshot()
        .then((s) =>
          // Keep state stable when the scroll position did not change so the
          // panel (and the overlay) do not re-render on every poll.
          setScroll((prev) => (prev && prev.x === s.scrollX && prev.y === s.scrollY ? prev : { x: s.scrollX, y: s.scrollY })),
        )
        .catch(() => undefined);
    };
    void refresh();
    timer = setInterval(() => void refresh(), 2500);
    return () => {
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.connected, sessionId]);

  // Panel width dragging (split mode).
  useEffect(() => {
    if (mode !== 'split') return;
    const onMove = (event: MouseEvent) => {
      if (!draggingRef.current || !panelRef.current) return;
      const rect = panelRef.current.getBoundingClientRect();
      const width = Math.round(rect.right - event.clientX);
      onPanelWidthChange(Math.max(360, Math.min(1200, width)));
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [mode, onPanelWidthChange]);

  const meta = live.meta;
  const areaOfRegion = useCallback(
    (region: LadRegion): LadArea | undefined => live.areas.find((a) => a.regionIds.includes(region.id)),
    [live.areas],
  );

  const handleCommitSelection = useCallback(
    async (rect: { x: number; y: number; width: number; height: number }) => {
      setSelectionMode(false);
      try {
        const result = await live.ground(rect);
        const createdArea = result.area;
        if (createdArea) {
          setIncludeAreaIds((prev) => new Set(prev).add(createdArea.id));
          setExpandedAreaId(createdArea.id);
        }
        setErrorNote(null);
      } catch (error) {
        setErrorNote(error instanceof Error ? error.message : String(error));
      }
    },
    [live],
  );

  const toggleInclude = useCallback((areaId: string) => {
    setIncludeAreaIds((prev) => {
      const next = new Set(prev);
      if (next.has(areaId)) next.delete(areaId);
      else next.add(areaId);
      return next;
    });
  }, []);

  const sendToAgent = useCallback(
    async (area: LadArea) => {
      try {
        const regions = live.regions.filter((r) => area.regionIds.includes(r.id));
        const text = buildAreaContextText({
          areas: [area],
          regions,
          project: undefined,
          vision: undefined,
          live: liveRecord(regions),
        });
        const images: Array<{ data: string; mimeType: string }> = [];
        for (const region of regions.slice(0, 3)) {
          try {
            const crop = await live.captureRegionCrop(region.rect, 1280);
            images.push({ data: crop.data, mimeType: crop.mime });
          } catch {
            // capture failed — text context still goes through
          }
        }
        setPendingSelection({
          text,
          images,
          areaNames: [area.name],
          createdAt: Date.now(),
        });
      } catch (error) {
        setErrorNote(error instanceof Error ? error.message : String(error));
      }
    },
    [live],
  );

  const sendAllToAgent = useCallback(async () => {
    try {
      const selected = live.areas.filter((a) => includeAreaIds.has(a.id));
      const list = selected.length > 0 ? selected : live.areas;
      const regions = live.regions.filter((r) => list.some((a) => a.regionIds.includes(r.id)));
      const text = buildAreaContextText({
        areas: list,
        regions,
        project: undefined,
        vision: undefined,
        live: liveRecord(regions),
      });
      const images: Array<{ data: string; mimeType: string }> = [];
      for (const region of regions.slice(0, 6)) {
        try {
          const crop = await live.captureRegionCrop(region.rect, 1024);
          images.push({ data: crop.data, mimeType: crop.mime });
        } catch {
          // ignore
        }
      }
      setPendingSelection({
        text,
        images,
        areaNames: list.map((a) => a.name),
        createdAt: Date.now(),
      });
    } catch (error) {
      setErrorNote(error instanceof Error ? error.message : String(error));
    }
  }, [live, includeAreaIds]);

  const pending = peekPendingSelection();

  return (
    <div
      ref={panelRef}
      data-testid="live-browser-panel"
      data-mode={mode}
      className={cn(
        'relative z-[100] flex h-full min-h-0 border-l border-border-primary bg-background-primary no-drag',
        mode === 'split' ? '' : 'h-full',
      )}
      style={mode === 'split' ? { width: panelWidth } : { width: '100%', flex: 1 }}
    >
      {mode === 'split' && (
        <div
          className="w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-border-active transition-colors"
          onMouseDown={(event) => {
            event.preventDefault();
            draggingRef.current = true;
          }}
          title={intl.formatMessage(i18n.closePanel)}
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border-primary px-2 py-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <Globe className="h-3.5 w-3.5" />
            {intl.formatMessage(i18n.panelTitle)}
            {live.meta?.agentBusy && (
              <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                <LoaderCircle className="h-3 w-3 animate-spin" />
                {intl.formatMessage(i18n.agentBusy)}
              </span>
            )}
            {live.meta && (
              <span className="rounded-full bg-background-secondary px-1.5 text-[10px] text-text-secondary">
                {live.meta.ownership === 'agent'
                  ? intl.formatMessage(i18n.ownershipAgent)
                  : intl.formatMessage(i18n.ownershipUser)}
              </span>
            )}
          </span>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7"
              title={intl.formatMessage(i18n.modeSplit)}
              data-testid="live-browser-mode-split"
              onClick={() => onModeChange('split')}
            >
              <LayoutPanelLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7"
              title={intl.formatMessage(i18n.modeExpanded)}
              data-testid="live-browser-mode-expanded"
              onClick={() => onModeChange('expanded')}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7"
              title={intl.formatMessage(i18n.closePanel)}
              data-testid="live-browser-mode-close"
              onClick={() => onModeChange('chatOnly')}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* URL bar */}
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border-primary px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7"
            title={intl.formatMessage(i18n.back)}
            data-testid="live-browser-back"
            onClick={() => void live.navigate('back')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7"
            title={intl.formatMessage(i18n.forward)}
            data-testid="live-browser-forward"
            onClick={() => void live.navigate('forward')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7"
            title={intl.formatMessage(i18n.reload)}
            data-testid="live-browser-reload"
            onClick={() => void live.navigate('reload')}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
          <Input
            className="h-7 flex-1 text-xs"
            data-testid="live-browser-url-input"
            placeholder={intl.formatMessage(i18n.urlPlaceholder)}
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && urlInput.trim()) {
                void live.navigate('open', urlInput.trim()).then(() => setUrlInput(''));
              }
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            data-testid="live-browser-open"
            onClick={() => {
              if (urlInput.trim()) void live.navigate('open', urlInput.trim()).then(() => setUrlInput(''));
            }}
          >
            {intl.formatMessage(i18n.open)}
          </Button>
        </div>

        {/* View controls */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-primary px-2 py-1.5 text-xs text-text-secondary">
          <span>{intl.formatMessage(i18n.viewportLabel)}:</span>
          <div className="w-28" data-testid="live-browser-viewport-select">
            <Select
              isSearchable={false}
              options={(() => {
                const current = meta ? `${meta.viewport.width}x${meta.viewport.height}` : '1280x800';
                const base = ['1280x800', '1024x768', '1920x1080', '1366x768'].map((v) => ({
                  value: v,
                  label: v.replace('x', '×'),
                }));
                return base.some((o) => o.value === current) ? base : [{ value: current, label: current.replace('x', '×') }, ...base];
              })()}
              value={(() => {
                const current = meta ? `${meta.viewport.width}x${meta.viewport.height}` : '1280x800';
                return { value: current, label: current.replace('x', '×') };
              })()}
              onChange={(option) => {
                if (!option) return;
                const { value } = option as { value: string };
                const [w, h] = value.split('x').map(Number);
                if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
                  void live.setViewportSize({ width: w, height: h });
                }
              }}
            />
          </div>
          <span>{intl.formatMessage(i18n.pageZoom)}:</span>
          <div className="w-24" data-testid="live-browser-zoom-select">
            <Select
              isSearchable={false}
              options={(() => {
                const current = meta ? String(meta.zoom) : '1';
                const base = ZOOM_OPTIONS.map((z) => ({ value: z, label: `${Math.round(Number(z) * 100)}%` }));
                return base.some((o) => o.value === current)
                  ? base
                  : [{ value: current, label: `${Math.round(Number(current) * 100)}%` }, ...base];
              })()}
              value={(() => {
                const current = meta ? String(meta.zoom) : '1';
                return { value: current, label: `${Math.round(Number(current) * 100)}%` };
              })()}
              onChange={(option) => {
                if (!option || !meta) return;
                const zoom = Number((option as { value: string }).value);
                if (Number.isFinite(zoom) && zoom > 0) {
                  void live.setViewportSize({ width: meta.viewport.width, height: meta.viewport.height, zoom });
                }
              }}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6"
            onClick={() => setSelectionMode((v) => !v)}
            title={intl.formatMessage(i18n.newArea)}
            data-testid="live-browser-new-area"
          >
            <MousePointerSquareDashed className="mr-1 h-3.5 w-3.5" />
            {selectionMode ? '✓ ' : ''}
            {intl.formatMessage(i18n.newArea)}
          </Button>
          {live.areas.length > 0 && (
            <div className="ml-auto flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-6 text-xs" data-testid="live-browser-include-all" onClick={() => void sendAllToAgent()}>
                → {intl.formatMessage(i18n.includeInNext)}
              </Button>
            </div>
          )}
        </div>

        {errorNote && (
          <div className="shrink-0 border-b border-border-primary bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
            {errorNote}
          </div>
        )}

        {/* Body: screencast + areas */}
        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1 overflow-auto bg-black">
            {!live.runtime.endpoint ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-text-secondary" data-testid="live-browser-connecting">
                {live.runtime.error ? (
                  <>
                    <p>{intl.formatMessage(i18n.runtimeError, { error: live.runtime.error })}</p>
                    <Button variant="outline" size="sm" onClick={live.retryRuntime}>
                      {intl.formatMessage(i18n.retry)}
                    </Button>
                  </>
                ) : (
                  <p className="flex items-center gap-2">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    {intl.formatMessage(i18n.connecting)}
                  </p>
                )}
              </div>
            ) : (
              <div className="flex min-h-full items-start justify-center p-2">
                <div className="relative w-full max-w-full" style={{ aspectRatio: meta ? `${meta.viewport.width} / ${meta.viewport.height}` : '16 / 10' }}>
                  <canvas
                    ref={canvasRef}
                    data-testid="live-browser-canvas"
                    className="h-full w-full bg-black"
                    style={{ objectFit: 'fill', display: 'block' }}
                  />
                  <SelectionOverlay
                    canvas={canvasRef.current}
                    meta={
                      meta
                        ? { viewport: meta.viewport, dpr: meta.dpr, zoom: meta.zoom }
                        : null
                    }
                    regions={live.regions}
                    areas={live.areas}
                    active={selectionMode}
                    onCommit={(rect) => void handleCommitSelection(rect)}
                    getScroll={live.scrollSnapshot}
                    activeArea={null}
                    selectedRegionIds={[]}
                    scroll={scroll}
                  />
                  {!live.hasFrame && (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
                      {meta?.url ? meta.url : intl.formatMessage(i18n.noPage)}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Areas sidebar */}
          <div className="flex w-72 shrink-0 flex-col overflow-hidden border-l border-border-primary" data-testid="live-browser-areas">
            <div className="flex shrink-0 items-center justify-between border-b border-border-primary px-2 py-1.5">
              <span className="text-xs font-medium text-text-secondary">
                {intl.formatMessage(i18n.regionsCount, { count: live.regions.length })}
              </span>
              {live.areas.length > 0 && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px]"
                    data-testid="live-browser-select-all"
                    onClick={() => setIncludeAreaIds(new Set(live.areas.map((a) => a.id)))}
                  >
                    {intl.formatMessage(i18n.selectAll)}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 text-[10px]" data-testid="live-browser-deselect-all" onClick={() => setIncludeAreaIds(new Set())}>
                    {intl.formatMessage(i18n.deselectAll)}
                  </Button>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {live.areas.map((area) => {
                const regionList = live.regions.filter((r) => area.regionIds.includes(r.id));
                const expanded = expandedAreaId === area.id;
                const included = includeAreaIds.has(area.id);
                return (
                  <div key={area.id} className="border-b border-border-primary px-2 py-2" data-testid="live-browser-area" data-area-name={area.name}>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: area.color }} />
                      <input
                        className="min-w-0 flex-1 bg-transparent text-xs font-medium text-text-primary outline-none"
                        data-testid="live-browser-area-name"
                        value={nameDraft[area.id] ?? area.name}
                        onChange={(event) => setNameDraft((prev) => ({ ...prev, [area.id]: event.target.value }))}
                        onBlur={() => {
                          const name = (nameDraft[area.id] ?? '').trim();
                          if (name && name !== area.name) void live.updateArea(area.id, { name });
                          setNameDraft((prev) => {
                            const next = { ...prev };
                            delete next[area.id];
                            return next;
                          });
                        }}
                      />
                      <span className="rounded-full px-1.5 py-0.5 text-[9px] font-medium" style={{ backgroundColor: `${area.color}33`, color: area.color }}>
                        {area.status}
                      </span>
                    </div>

                    <textarea
                      className="mt-1.5 w-full resize-none rounded-md bg-background-secondary px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-secondary"
                      data-testid="live-browser-area-desc"
                      rows={2}
                      placeholder={intl.formatMessage(i18n.areaDescription)}
                      value={descDraft[area.id] ?? area.description ?? ''}
                      onChange={(event) => setDescDraft((prev) => ({ ...prev, [area.id]: event.target.value }))}
                      onBlur={() => {
                        const description = (descDraft[area.id] ?? '').trim();
                        if (description !== (area.description ?? '')) void live.updateArea(area.id, { description: description || undefined });
                        setDescDraft((prev) => {
                          const next = { ...prev };
                          delete next[area.id];
                          return next;
                        });
                      }}
                    />

                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <div className="w-28" data-testid="live-browser-area-status">
                        <Select
                          isSearchable={false}
                          options={LAD_REGION_STATUSES.map((status) => ({ value: status, label: status }))}
                          value={{ value: area.status, label: area.status }}
                          onChange={(option) => {
                            if (option) void live.updateArea(area.id, { status: (option as { value: string }).value });
                          }}
                        />
                      </div>
                      <label className="flex cursor-pointer items-center gap-1 text-[10px] text-text-secondary">
                        <Switch
                          checked={included}
                          onCheckedChange={() => toggleInclude(area.id)}
                        />
                        {intl.formatMessage(i18n.includeInNext)}
                      </label>
                    </div>

                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => setExpandedAreaId(expanded ? null : area.id)}>
                        {expanded ? '−' : '+'} {intl.formatMessage(i18n.technicalData)}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 text-[10px]"
                        onClick={() => void live.liveProjection(regionList[0]?.id ?? '')}
                        disabled={regionList.length === 0}
                      >
                        {intl.formatMessage(i18n.liveCheck)}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 text-[10px] text-red-500"
                        onClick={() => void live.removeArea(area.id)}
                      >
                        {intl.formatMessage(i18n.removeArea)}
                      </Button>
                    </div>

                    {expanded && (
                      <div className="mt-2 space-y-2 rounded-md bg-background-secondary p-2 text-[10px] text-text-secondary">
                        {regionList.map((region) => {
                          const areaHere = areaOfRegion(region);
                          const anchor = region.anchors[0];
                          const stale = region.live?.stale === true;
                          return (
                            <div key={region.id} className="space-y-1 border-b border-border-primary pb-2 last:border-b-0 last:pb-0">
                              <div className="flex justify-between">
                                <span>{intl.formatMessage(i18n.viewportLabel)}</span>
                                <span className="font-mono">
                                  {region.viewport.width}×{region.viewport.height} @ {region.dpr}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>{intl.formatMessage(i18n.scrollLabel)}</span>
                                <span className="font-mono">
                                  {Math.round(region.scroll.x)},{Math.round(region.scroll.y)}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>rect</span>
                                <span className="font-mono">
                                  {Math.round(region.rect.x)},{Math.round(region.rect.y)} {Math.round(region.rect.width)}×{Math.round(region.rect.height)}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>{intl.formatMessage(i18n.urlLabel)}</span>
                                <span className="max-w-[10rem] truncate font-mono">{region.route}</span>
                              </div>
                              <div className="flex justify-between">
                                <span>{intl.formatMessage(i18n.anchorsCount, { count: region.anchors.length })}</span>
                                {anchor && (
                                  <span className="max-w-[10rem] truncate font-mono">
                                    {anchor.tag} {anchor.selector}
                                  </span>
                                )}
                              </div>
                              {anchor && (
                                <div className="flex justify-between">
                                  <span>{intl.formatMessage(i18n.confidenceLabel)}</span>
                                  <span className="font-mono">{Math.round(anchor.confidence * 100)}%</span>
                                </div>
                              )}
                              {stale && (
                                <div className="rounded bg-amber-500/15 px-1.5 py-1 text-amber-600 dark:text-amber-400">
                                  {intl.formatMessage(i18n.staleBinding)}
                                  {region.live?.reason ? ` (${region.live.reason})` : ''}
                                </div>
                              )}
                              {region.diagnostics.length > 0 && (
                                <div>
                                  <div className="font-medium text-text-primary">
                                    {intl.formatMessage(i18n.diagnosticsLabel)}
                                  </div>
                                  {region.diagnostics.map((diagnostic, i) => (
                                    <div key={i} className="italic">
                                      {diagnostic}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {areaHere?.check && (
                                <div>
                                  <div className="font-medium text-text-primary">
                                    {intl.formatMessage(i18n.lastCheckLabel)}
                                  </div>
                                  <div>
                                    {areaHere.check.status}
                                    {areaHere.check.reason ? ` — ${areaHere.check.reason}` : ''}
                                  </div>
                                </div>
                              )}
                              <div className="flex gap-1 pt-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 text-[10px]"
                                  onClick={() => void live.recordCheck(area.id, { result: 'verified', newStatus: 'Verified' })}
                                >
                                  {intl.formatMessage(i18n.markVerified)}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 text-[10px]"
                                  onClick={() => void live.recordCheck(area.id, { result: 'broken', newStatus: 'Unresolved' })}
                                >
                                  {intl.formatMessage(i18n.markUnresolved)}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 text-[10px]"
                                  data-testid="live-browser-area-send"
                                  onClick={() => void sendToAgent(area)}
                                >
                                  → agent
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                        {regionList.length === 0 && (
                          <div className="italic">{intl.formatMessage(i18n.regionsCount, { count: 0 })}</div>
                        )}
                        {live.runtime.endpoint && (
                          <div className="flex gap-1 pt-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 text-[10px]"
                              onClick={() => void sendToAgent(area)}
                            >
                              → {intl.formatMessage(i18n.includeInNext)}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 text-[10px] text-red-500"
                              onClick={() => void live.closeSession()}
                            >
                              {intl.formatMessage(i18n.closeBrowser)}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {live.areas.length === 0 && (
                <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-text-secondary">
                  <Globe className="h-6 w-6 opacity-40" />
                  <p>{intl.formatMessage(i18n.newArea)}</p>
                  <p className="max-w-[12rem]">{intl.formatMessage(i18n.selectHint)}</p>
                </div>
              )}
            </div>

            {pending && (
              <div className="shrink-0 border-t border-border-primary bg-blue-500/10 px-2 py-1.5 text-[10px] text-blue-600 dark:text-blue-400">
                {intl.formatMessage(i18n.sendingContext, { names: pending.areaNames.join(', ') })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
