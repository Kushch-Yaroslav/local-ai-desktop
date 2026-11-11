/**
 * SelectionOverlay — draws saved regions on top of the screencast canvas and
 * lets the user drag a new rectangle.
 *
 * Coordinate mapping (runtime contract):
 * - meta.viewport is the layout CSS viewport (W×H).
 * - The screencast frame is W*dpr*zoom device px wide.
 * - A saved region rect is in DOCUMENT CSS px (viewport rect + scroll at capture).
 * - The overlay maps document CSS px ↔ canvas display px through the live
 *   scroll snapshot and meta (dpr, zoom), so selections stay correct across
 *   viewport changes, page zoom and DPR.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { i18n } from './i18n';
import type { LadArea, LadRegion } from '../../../live-browser/shared/types';
import { ladAreaColor } from '../../../live-browser/shared/types';
import { docToDisplay, displayToDoc } from '../../../live-browser/shared/coords';

export interface OverlayMeta {
  viewport: { width: number; height: number };
  dpr: number;
  zoom: number;
}

interface SelectionOverlayProps {
  /** The canvas this overlay covers (must be positioned relative). */
  canvas: HTMLCanvasElement | null;
  meta: OverlayMeta | null;
  regions: LadRegion[];
  areas: LadArea[];
  /** Selection mode on: dragging creates a new region. */
  active: boolean;
  /** Committed rectangle in DOCUMENT CSS px. */
  onCommit: (rect: { x: number; y: number; width: number; height: number }) => void;
  /** Live page scroll snapshot for mapping. */
  getScroll: () => Promise<{ scrollX: number; scrollY: number }>;
  /** Highlighted area (its color + number) for the new selection. */
  activeArea?: { color: string; number: number } | null;
  selectedRegionIds: string[];
  onRegionClick?: (regionId: string) => void;
  /** Live page scroll (document CSS px), kept fresh by the panel. */
  scroll?: { x: number; y: number } | null;
}

interface Draft {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function SelectionOverlay({
  canvas,
  meta,
  regions,
  areas,
  active,
  onCommit,
  getScroll,
  activeArea,
  selectedRegionIds,
  onRegionClick,
  scroll,
}: SelectionOverlayProps) {
  const intl = useIntl();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 });
  const draggingRef = useRef(false);

  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
  };

  // Keep the overlay sized to the canvas element.
  useEffect(() => {
    if (!canvas) return;
    const update = () => {
      const rect = canvas.getBoundingClientRect();
      setBoxSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvas]);

  // Mapping: display px ↔ viewport CSS px (device pixels dpr*zoom cancel
  // between the captured frame and the display scale), then viewport CSS
  // px ↔ document CSS px via the live scroll snapshot.
  const toDocRect = useCallback(
    async (a: { x: number; y: number }, b: { x: number; y: number }) => {
      if (!meta || boxSize.width === 0 || boxSize.height === 0) return null;
      let current = scroll;
      if (!current) {
        try {
          const snapshot = await getScroll();
          current = { x: snapshot.scrollX, y: snapshot.scrollY };
        } catch {
          current = { x: 0, y: 0 };
        }
      }
      return displayToDoc(a, b, { viewport: meta.viewport, display: boxSize, scroll: current });
    },
    [meta, boxSize, scroll, getScroll],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!active) return;
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      draggingRef.current = true;
      setDraft({ x0: x, y0: y, x1: x, y1: y });
    },
    [active],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setDraft((prev) => (prev ? { ...prev, x1: x, y1: y } : prev));
    },
    [],
  );

  const onPointerUp = useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const current = draft;
      setDraft(null);
      if (!current) return;
      const w = Math.abs(current.x1 - current.x0);
      const h = Math.abs(current.y1 - current.y0);
      if (w < 4 || h < 4) return;
      const rect = await toDocRect({ x: current.x0, y: current.y0 }, { x: current.x1, y: current.y1 });
      if (rect) onCommit(rect);
      void event;
    },
    [draft, toDocRect, onCommit],
  );

  // Map a document-space rect to overlay display coordinates (shared, tested).
  const toDisplay = useCallback(
    (doc: { x: number; y: number; width: number; height: number }) => {
      if (!meta || boxSize.width === 0) return null;
      return docToDisplay(doc, {
        viewport: meta.viewport,
        display: boxSize,
        scroll: scroll ?? { x: 0, y: 0 },
      });
    },
    [meta, boxSize, scroll],
  );

  return (
    <div
      style={overlayStyle}
      className={active ? 'cursor-crosshair' : 'pointer-events-none'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {regions.map((region) => {
        const display = toDisplay(region.rect);
        if (!display) return null;
        const area = areas.find((a) => a.regionIds.includes(region.id));
        const color = activeArea?.color ?? ladAreaColor(area?.number ?? 1);
        const selected = selectedRegionIds.includes(region.id);
        const stale = region.live?.stale === true;
        return (
          <div
            key={region.id}
            data-region-id={region.id}
            className={
              'absolute border-2 rounded-sm flex items-start justify-start ' +
              (onRegionClick ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none')
            }
            style={{
              left: Math.max(0, display.left),
              top: Math.max(0, display.top),
              width: Math.max(8, display.width),
              height: Math.max(8, display.height),
              borderColor: color,
              backgroundColor: `${color}22`,
              outline: selected ? `2px solid ${color}` : 'none',
              outlineOffset: 2,
              opacity: stale ? 0.55 : 1,
            }}
            title={
              stale
                ? intl.formatMessage(i18n.staleBinding)
                : region.anchors.length > 0
                  ? `${region.anchors[0].tag} ${region.anchors[0].selector}`
                  : intl.formatMessage(i18n.diagnosticsLabel)
            }
            onClick={onRegionClick ? () => onRegionClick(region.id) : undefined}
          >
            <span
              className="absolute -top-5 left-0 px-1 rounded text-[10px] font-semibold whitespace-nowrap"
              style={{ backgroundColor: color, color: '#fff' }}
            >
              {stale ? '⚠ ' : ''}
              {region.anchors.length > 0
                ? region.anchors[0].tag
                : intl.formatMessage(i18n.anchorsCount, { count: 0 })}
            </span>
          </div>
        );
      })}

      {draft && (
        <div
          className="absolute border-2 border-dashed rounded-sm"
          style={{
            left: Math.min(draft.x0, draft.x1),
            top: Math.min(draft.y0, draft.y1),
            width: Math.abs(draft.x1 - draft.x0),
            height: Math.abs(draft.y1 - draft.y0),
            borderColor: activeArea?.color ?? '#3b82f6',
            backgroundColor: `${(activeArea?.color ?? '#3b82f6')}22`,
          }}
        />
      )}

      {active && !draft && (
        <div className="absolute left-1/2 -translate-x-1/2 top-2 px-2 py-1 rounded-md bg-black/60 text-white text-xs pointer-events-none">
          {intl.formatMessage(i18n.selectHint)}
        </div>
      )}
    </div>
  );
}
