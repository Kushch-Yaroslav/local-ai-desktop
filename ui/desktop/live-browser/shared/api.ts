/**
 * Live Browser runtime ↔ Electron renderer protocol.
 *
 * The runtime owns ONE real Playwright Page per conversation. The renderer only
 * renders frames and sends user intent; it never drives Chromium directly.
 *
 * Wire formats here are intentionally small and JSON-serializable (ACP-safe).
 */
import type { LadArea, LadRegion, LadWorkspaceSettings } from './types';

// ---------------------------------------------------------------------------
// Control HTTP API (127.0.0.1, bearer token)
// ---------------------------------------------------------------------------

export interface LadControlMeta {
  native?: boolean;
  conversationId: string;
  url: string;
  title: string;
  ready: boolean;
  ownership: 'user' | 'agent';
  visible: boolean;
  /** Page zoom factor (1 = 100%). Multiplies CSS px into device px. */
  zoom: number;
  /** Device pixel ratio of the display the page renders against. */
  dpr: number;
  viewport: { width: number; height: number };
  agentBusy: boolean;
  /** Last error reported by the browser runtime, if any. */
  lastError?: string;
}

export interface LadControlStateResponse {
  ok: true;
  meta: LadControlMeta;
  areas: LadArea[];
  regions: LadRegion[];
  workspace: LadWorkspaceSettings;
}

/** Screencast frame (JPEG, base64). Coordinates are device pixels. */
export interface LadFrame {
  t: 'frame';
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
  /** Frame timestamp (ms) at capture. */
  ts: number;
}

export type LadControlEvent =
  | {
      t: 'meta';
      meta: LadControlMeta;
    }
  | {
      t: 'state';
      areas: LadArea[];
      regions: LadRegion[];
      workspace: LadWorkspaceSettings;
    }
  | {
      t: 'action';
      source: 'user' | 'agent';
      tool: string;
      summary: string;
      at: string;
    }
  | {
      t: 'error';
      code: 'browser-restarted' | 'page-crashed' | 'navigation-blocked' | 'runtime-error';
      message: string;
    }
  | {
      t: 'ack';
      request: string;
      ok: boolean;
      error?: string;
    };

export type LadWsMessage = LadFrame | LadControlEvent;

// ---------------------------------------------------------------------------
// Region / area request bodies
// ---------------------------------------------------------------------------

export interface LadRectBody {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LadGroundRequest {
  conversationId?: string;
  /** Viewport-relative CSS rectangle drawn by the user. */
  rect: LadRectBody;
  /** Optional area to attach the region to. */
  areaId?: string;
  /** Optional user-provided note recorded on the region. */
  note?: string;
}

export interface LadGroundResponse {
  ok: true;
  region: LadRegion;
  area: LadArea | null;
}

export interface LadCreateAreaRequest {
  conversationId?: string;
  name: string;
  description?: string;
  status?: string;
}

export interface LadCreateAreaResponse {
  ok: true;
  area: LadArea;
}

export interface LadUpdateAreaRequest {
  areaId: string;
  name?: string;
  description?: string;
  status?: string;
  /** Explicit source of a status change (user vs agent check). */
  statusSource?: 'user' | 'agent' | 'runtime';
}

export interface LadCaptureRequest {
  conversationId?: string;
  /** Viewport-relative CSS rectangle. */
  rect: LadRectBody;
  /** Cap for output edge length in device px (default 1600). */
  maxEdge?: number;
  format?: 'jpeg' | 'png';
  quality?: number;
}

export interface LadCaptureResponse {
  ok: true;
  mime: 'image/jpeg' | 'image/png';
  data: string;
  width: number;
  height: number;
}

export interface LadReadRequest {
  conversationId?: string;
  /** Bounded readable text of the page (default 12000 chars). */
  maxChars?: number;
  /** Optional CSS selector scope. */
  selector?: string;
  /** Include bounded HTML fragment (default false). */
  html?: boolean;
}

export interface LadReadResponse {
  ok: true;
  url: string;
  title: string;
  text: string;
  html?: string;
  truncated: boolean;
}

export interface LadInspectRequest {
  conversationId?: string;
  selector: string;
  maxChars?: number;
}

export interface LadInspectResponse {
  ok: true;
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  accessibleName: string | null;
  role: string | null;
  html: string;
  truncated: boolean;
}

export interface LadActionResult {
  ok: boolean;
  summary: string;
  error?: string;
}

export interface LadWorkspaceRequest {
  conversationId?: string;
  workspace: Partial<LadWorkspaceSettings>;
}

export interface LadOwnershipRequest {
  conversationId?: string;
  ownership: 'user' | 'agent';
}

export interface LadActiveRequest {
  conversationId: string;
}

export interface LadListSessionsResponse {
  ok: true;
  sessions: Array<{ conversationId: string; url: string; title: string; ready: boolean }>;
  active: string | null;
}
