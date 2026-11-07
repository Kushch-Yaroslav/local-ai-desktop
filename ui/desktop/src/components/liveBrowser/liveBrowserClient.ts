/**
 * Live Browser renderer client for the runtime control API.
 *
 * All calls go to 127.0.0.1 (the runtime is loopback-only) with the bearer
 * token obtained from the Electron main process. The renderer never drives
 * Chromium directly — the runtime owns the Playwright Page.
 */
import type {
  LadCaptureResponse,
  LadControlMeta,
  LadGroundResponse,
  LadReadResponse,
} from '../../../live-browser/shared/api';
import type {
  LadArea,
  LadRegion,
  LadWorkspaceSettings,
} from '../../../live-browser/shared/types';

export interface LiveBrowserEndpoint {
  url: string;
  token: string;
}

export interface LiveBrowserStateSnapshot {
  meta: LadControlMeta | null;
  areas: LadArea[];
  regions: LadRegion[];
  workspace: LadWorkspaceSettings;
}

export class LiveBrowserApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LiveBrowserApiError';
  }
}

export class LiveBrowserClient {
  constructor(readonly endpoint: LiveBrowserEndpoint) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.endpoint.token}`,
      'content-type': 'application/json',
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.endpoint.url}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new LiveBrowserApiError(
        `live-browser runtime unreachable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: text.slice(0, 300) };
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : `HTTP ${response.status}`;
      throw new LiveBrowserApiError(message, response.status);
    }
    return payload as T;
  }

  health(): Promise<{ ok: boolean; sessions: string[]; active: string | null }> {
    return this.request('GET', '/health');
  }

  state(conversationId: string): Promise<LiveBrowserStateSnapshot> {
    return this.request('GET', `/control/state?conversation=${encodeURIComponent(conversationId)}`);
  }

  setActive(conversationId: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/control/active', { conversationId });
  }

  ground(
    conversationId: string,
    rect: { x: number; y: number; width: number; height: number },
    opts?: { areaId?: string; note?: string },
  ): Promise<LadGroundResponse> {
    return this.request('POST', `/control/ground?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      rect,
      areaId: opts?.areaId,
      note: opts?.note,
    });
  }

  createArea(
    conversationId: string,
    body: { name: string; description?: string; status?: string },
  ): Promise<{ ok: boolean; area: LadArea }> {
    return this.request('POST', `/control/area?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      ...body,
    });
  }

  updateArea(
    conversationId: string,
    areaId: string,
    body: { name?: string; description?: string; status?: string; statusSource?: string },
  ): Promise<{ ok: boolean; area: LadArea }> {
    return this.request('POST', `/control/area/update?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      areaId,
      ...body,
    });
  }

  removeArea(conversationId: string, areaId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/control/area/remove?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      areaId,
    });
  }

  removeRegion(conversationId: string, regionId: string): Promise<{ ok: boolean }> {
    return this.request(
      'POST',
      `/control/region/remove?conversation=${encodeURIComponent(conversationId)}`,
      { conversationId, regionId },
    );
  }

  attachRegion(
    conversationId: string,
    regionId: string,
    areaId: string,
  ): Promise<{ ok: boolean; region: LadRegion; area: LadArea }> {
    return this.request('POST', `/control/region/attach?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      regionId,
      areaId,
    });
  }

  setWorkspace(
    conversationId: string,
    workspace: Partial<LadWorkspaceSettings>,
  ): Promise<{ ok: boolean; workspace: LadWorkspaceSettings }> {
    return this.request('POST', `/control/workspace?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      workspace,
    });
  }

  setOwnership(conversationId: string, ownership: 'user' | 'agent'): Promise<{ ok: boolean }> {
    return this.request('POST', `/control/ownership?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      ownership,
    });
  }

  setViewport(
    conversationId: string,
    body: { width: number; height: number; zoom?: number },
  ): Promise<{ ok: boolean }> {
    return this.request('POST', `/control/viewport?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      ...body,
    });
  }

  setVisible(conversationId: string, visible: boolean): Promise<{ ok: boolean }> {
    return this.request('POST', `/control/visibility?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      visible,
    });
  }

  navigate(
    conversationId: string,
    action: 'open' | 'back' | 'forward' | 'reload',
    url?: string,
  ): Promise<{ ok: boolean; summary?: string }> {
    return this.request('POST', `/control/navigate?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      action,
      url,
    });
  }

  act(
    conversationId: string,
    body: { action: string; selector?: string; value?: string; x?: number; y?: number },
  ): Promise<{ ok: boolean; summary?: string }> {
    return this.request('POST', `/control/act?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      ...body,
    });
  }

  captureCrop(
    conversationId: string,
    rect: { x: number; y: number; width: number; height: number },
    maxEdge = 1280,
  ): Promise<LadCaptureResponse> {
    return this.request('POST', `/control/capture?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      rect,
      maxEdge,
    });
  }

  read(conversationId: string, maxChars = 12000, selector?: string): Promise<LadReadResponse> {
    return this.request('POST', `/control/read?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      maxChars,
      selector,
    });
  }

  /** Live page snapshot for coordinate mapping (document ↔ canvas). */
  scrollSnapshot(
    conversationId: string,
  ): Promise<{
    ok: boolean;
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    dpr: number;
    url: string;
  }> {
    return this.request('GET', `/control/scroll?conversation=${encodeURIComponent(conversationId)}`);
  }

  liveProjection(conversationId: string, regionId: string): Promise<{ ok: boolean; region: LadRegion }> {
    return this.request('POST', `/control/projection?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      regionId,
    });
  }

  recordCheck(
    conversationId: string,
    areaId: string,
    body: { result?: string; reason?: string; newStatus?: string },
  ): Promise<{ ok: boolean; area: LadArea }> {
    return this.request('POST', `/control/check?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
      areaId,
      ...body,
    });
  }

  closeSession(conversationId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/control/session/close?conversation=${encodeURIComponent(conversationId)}`, {
      conversationId,
    });
  }

  /** SSE URL (EventSource cannot set headers → token in query). */
  sseUrl(conversationId: string): string {
    const token = encodeURIComponent(this.endpoint.token);
    const conversation = encodeURIComponent(conversationId);
    return `${this.endpoint.url}/control/events?conversation=${conversation}&token=${token}`;
  }
}
