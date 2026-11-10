/**
 * Live Browser — shared data model.
 *
 * Ported and adapted from the original Local AI Desktop visual region model
 * (src/shared/visual-debugging.ts, live-browser.ts, browser-coordinates.ts)
 * into the Goose-based v0.4.0 architecture. The region/area semantics, the
 * diagnostics contract ("Screenshot-only Canvas/SVG region; no source
 * mapping") and the coordinate spaces are preserved deliberately: they are
 * part of the user-facing behavior of the original application.
 */

export interface LadRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LadPoint {
  x: number;
  y: number;
}

/** Bounded text identity used for stale-anchor detection. Never private inputs. */
export interface LadAnchorIdentity {
  text: string;
  context: string;
}

export interface LadAnchorFinding {
  category:
    | 'text-clipping'
    | 'horizontal-overflow'
    | 'vertical-overflow'
    | 'element-overlap'
    | 'styling-mismatch'
    | 'unknown';
  fact: string;
  candidate: boolean;
  /** Current DOM recheck state; missing means not rechecked yet. */
  state?: 'current' | 'stale';
}

export interface LadAnchorNeighbor {
  tag: string;
  rect: LadRect;
  intersects: boolean;
}

/**
 * A DOM anchor candidate for a selected rectangle.
 * `confidence >= 0.8` means the selector was unique at capture time; lower
 * values are ambiguous hints only. Canvas/SVG selections carry no anchors and
 * rely on the screenshot/geometry fallback.
 */
export interface LadAnchor {
  tag: string;
  selector: string;
  text: string;
  classes: string[];
  identity?: LadAnchorIdentity;
  geometry?: {
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    visible: boolean;
  };
  findings?: LadAnchorFinding[];
  neighbors?: LadAnchorNeighbor[];
  rect: LadRect;
  confidence: number;
  diagnostics: string[];
  styles: Record<string, string>;
}

export interface LadSurroundings {
  relation: 'between-siblings' | 'ambiguous';
  above?: { tag: string; selector?: string; text: string; rect: LadRect };
  below?: { tag: string; selector?: string; text: string; rect: LadRect };
  container?: string;
  confidence: number;
  coordinateSpace: 'document-css';
  diagnostics: string[];
}

/** Live re-projection of a region at a later observation time. */
export interface LadLiveProjection {
  url: string;
  viewport: { width: number; height: number };
  dpr: number;
  scroll: LadPoint;
  rect?: LadRect;
  stale: boolean;
  reason?: string;
  observedAt: string;
}

export const LAD_REGION_STATUSES = [
  'Detected',
  'Confirmed',
  'In progress',
  'Fixed',
  'Verified',
  'Unresolved',
] as const;
export type LadRegionStatus = (typeof LAD_REGION_STATUSES)[number];

/**
 * One selected rectangle on a page.
 *
 * Coordinate contract:
 * - `rect` is in DOCUMENT CSS pixels (viewport rect + scroll at capture time).
 * - `viewport` is the page viewport (innerWidth/innerHeight) at capture time.
 * - `dpr` is the device pixel ratio at capture time.
 * - `scroll` is window.scrollX/scrollY at capture time.
 * - `anchors[].rect` is in document CSS pixels.
 *
 * Regions are chat-scoped evidence: historical user selection, not current
 * browser state. `live` is a timestamped re-projection when available.
 */
export interface LadRegion {
  id: string;
  conversationId: string;
  areaId: string;
  url: string;
  route: string;
  viewport: { width: number; height: number };
  dpr: number;
  scroll: LadPoint;
  rect: LadRect;
  anchors: LadAnchor[];
  surroundings?: LadSurroundings;
  live?: LadLiveProjection;
  screenshot?: {
    width: number;
    height: number;
    bytes: number;
    savedAt: string;
    space: 'css';
  };
  createdAt: string;
  updatedAt: string;
  snapshot: string;
  projectRoot?: string;
  history?: LadVisualEvidence[];
  diagnostics: string[];
  events: Array<{
    at: string;
    source: 'user' | 'agent' | 'runtime';
    action: string;
    status?: LadRegionStatus;
  }>;
}

/** A named user area: one or more regions with a task and a status. */
export interface LadArea {
  id: string;
  conversationId: string;
  name: string;
  /** Areas created by automatic DOM analysis remain candidates until the user adopts them. */
  origin?: 'manual' | 'detected';
  description?: string;
  status: LadRegionStatus;
  statusSource?: 'user' | 'agent' | 'runtime';
  regionIds: string[];
  number: number;
  color: string;
  createdAt: string;
  updatedAt: string;
  events: Array<{
    at: string;
    source: 'user' | 'agent' | 'runtime';
    action: string;
    status?: LadRegionStatus;
  }>;
  workflow?: { state: 'active' | 'completed' | 'disputed'; at: string };
  verification?: LadVerification;
  ledger?: LadVerification[];
  check?: {
    status: string;
    reason?: string;
    at: string;
    url: string;
    viewport: { width: number; height: number };
  };
}

export interface LadWorkspaceSettings {
  /** Explicit permission to return browser images through agent tools. Defaults off. */
  vision?: 'on' | 'off';
  /** Split: chat left, browser right. Expanded: browser fills the view. chatOnly: hidden. */
  mode?: 'split' | 'expanded' | 'chatOnly';
  /** Panel width in px (split mode). */
  panelWidth?: number;
  /** Page viewport: 'auto' follows the panel, or fixed size. */
  viewport: 'auto' | { width: number; height: number };
  /** Page zoom factor (0.5..2). */
  zoom?: number;
  /** Preview scale: 'fit' or fixed 0.5..2 (renderer-side canvas scaling). */
  previewScale?: 'fit' | number;
  /** Scroll offset inside the rendered surface (CSS px of the page). */
  pan: { x: number; y: number };
  /** Whether the panel is visible for this chat. Hiding never closes the Page. */
  visible?: boolean;
}

export interface LadBrowserState {
  conversationId: string;
  sessionId: string;
  status: 'loading' | 'live' | 'ended' | 'error';
  url: string;
  title?: string;
  ownership: 'idle' | 'agent' | 'user' | 'paused' | 'closed' | 'error';
  error?: string;
  action?: { kind: string; detail?: string; at: number };
  viewport?: { width: number; height: number };
  dpr?: number;
  zoom?: number;
  screencast?: 'active' | 'suspended' | 'error';
  updatedAt: number;
}

export interface LadEvent {
  type: 'state' | 'region' | 'area' | 'screencast';
  state?: LadBrowserState;
  region?: LadRegion;
  area?: LadArea;
  removedRegionId?: string;
  removedAreaId?: string;
  screencast?: 'active' | 'suspended' | 'error';
  at: number;
}

export const LAD_DEFAULT_WORKSPACE: LadWorkspaceSettings = {
  vision: 'off',
  mode: 'split',
  panelWidth: 560,
  viewport: 'auto',
  previewScale: 'fit',
  pan: { x: 0, y: 0 },
  visible: true,
};

/** Deterministic area color by number (ported from the original areaColor). */
export function ladAreaColor(number: number): string {
  const hue = (number * 137.508) % 360;
  const c = 0.75;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = 0.18;
  const rgb =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, x, c]
          : hue < 240
            ? [0, c, x]
            : hue < 300
              ? [x, 0, c]
              : [0, x, c];
  return (
    '#' +
    rgb
      .map((n) =>
        Math.round((n + m) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

/** Sanitize a URL for agent context: redact credential-like params, strip user/password. */
export function ladPromptUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const secret = /token|secret|password|authorization|api[_-]?key|session|credential/i;
    for (const key of url.searchParams.keys()) {
      if (secret.test(key)) url.searchParams.set(key, '[redacted]');
    }
    if (url.hash.includes('?')) {
      const [route, query] = url.hash.split('?');
      const params = new URLSearchParams(query);
      for (const key of params.keys()) {
        if (secret.test(key)) params.set(key, '[redacted]');
      }
      url.hash = route + '?' + params.toString();
    }
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return raw;
  }
}

export function ladRoute(raw: string): string {
  try {
    return new URL(raw).pathname + new URL(raw).search + new URL(raw).hash;
  } catch {
    return raw;
  }
}

export function ladValidateWorkspace(value: unknown): LadWorkspaceSettings {
  const s = (value ?? {}) as Partial<LadWorkspaceSettings>;
  const out: LadWorkspaceSettings = {
    vision: s.vision === 'on' ? 'on' : 'off',
    mode: s.mode === 'expanded' || s.mode === 'chatOnly' ? s.mode : 'split',
    panelWidth:
      typeof s.panelWidth === 'number' && Number.isFinite(s.panelWidth)
        ? Math.max(320, Math.min(1600, Math.round(s.panelWidth)))
        : LAD_DEFAULT_WORKSPACE.panelWidth!,
    viewport:
      s.viewport === 'auto'
        ? 'auto'
        : s.viewport &&
            typeof s.viewport.width === 'number' &&
            typeof s.viewport.height === 'number' &&
            s.viewport.width >= 240 &&
            s.viewport.width <= 4096 &&
            s.viewport.height >= 240 &&
            s.viewport.height <= 4096 &&
            s.viewport.width * s.viewport.height <= 8847360
          ? { width: Math.round(s.viewport.width), height: Math.round(s.viewport.height) }
          : 'auto',
    zoom:
      typeof s.zoom === 'number' && Number.isFinite(s.zoom)
        ? Math.max(0.5, Math.min(2, s.zoom))
        : undefined,
    previewScale:
      s.previewScale === 'fit'
        ? 'fit'
        : typeof s.previewScale === 'number'
          ? Math.max(0.25, Math.min(4, s.previewScale))
          : 'fit',
    pan:
      s.pan && typeof s.pan.x === 'number' && typeof s.pan.y === 'number'
        ? { x: Math.max(0, Math.min(8192, s.pan.x)), y: Math.max(0, Math.min(8192, s.pan.y)) }
        : { x: 0, y: 0 },
    visible: typeof s.visible === 'boolean' ? s.visible : true,
  };
  return out;
}

export interface LadSourceRevision {
  root: string;
  fingerprint: string;
  files: Record<string, string>;
  capturedAt: string;
  scope: string;
}
export interface LadVisualEvidence {
  id: string;
  at: string;
  kind: 'selection' | 'reselection' | 'recheck';
  url: string;
  viewport: { width: number; height: number };
  snapshot: string;
  anchors: LadAnchor[];
  rect: LadRect;
  cropId?: string;
  diagnostics: string[];
}
export interface LadVerification {
  id: string;
  at: string;
  outcome: 'Verified' | 'Failed' | 'Not Verified';
  reason?: string;
  criterion?: 'text_fit';
  source?: Pick<LadSourceRevision, 'root' | 'fingerprint' | 'scope'>;
  regions: {
    id: string;
    snapshot: string;
    url: string;
    viewport: { width: number; height: number };
    selector?: string;
    expected: 0;
    observed: number | null;
  }[];
  errors: string[];
  servedSources?: string[];
  sourceDiagnostics?: string[];
}
