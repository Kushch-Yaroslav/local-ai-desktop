/**
 * useLiveBrowser — renderer state for one chat's Live Browser panel.
 *
 * Connects to the runtime control/SSE API for a conversation, keeps the latest
 * screencast frame, meta, areas, regions and workspace in React state, and
 * exposes the control operations. Hiding the panel never stops the runtime or
 * the Playwright Page — only the SSE subscription (frame production) stops.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveBrowserApiError, LiveBrowserClient, type LiveBrowserEndpoint } from './liveBrowserClient';
import type { LadControlMeta } from '../../../live-browser/shared/api';
import type {
  LadArea,
  LadRegion,
  LadWorkspaceSettings,
} from '../../../live-browser/shared/types';

export interface LiveBrowserRuntimeInfo {
  running: boolean;
  endpoint: LiveBrowserEndpoint | null;
  error: string | null;
  node: string | null;
}

function getRuntimeInfo(): Promise<LiveBrowserRuntimeInfo> {
  if (!window.electron) {
    return Promise.resolve({ running: false, endpoint: null, error: 'not-in-electron', node: null });
  }
  return window.electron
    .liveBrowserStatus()
    .then((status) => ({
      running: status.running,
      endpoint: status.endpoint ? { url: status.endpoint.url, token: status.endpoint.token } : null,
      error: status.error,
      node: status.node,
    }))
    .catch((error) => ({
      running: false,
      endpoint: null,
      error: error instanceof Error ? error.message : String(error),
      node: null,
    }));
}

function startRuntime(): Promise<{ ok: boolean; error?: string; endpoint?: LiveBrowserEndpoint }> {
  if (!window.electron) {
    return Promise.resolve({ ok: false, error: 'not-in-electron' });
  }
  return window.electron
    .liveBrowserStart()
    .then((result) => {
      if (result.ok && result.endpoint) {
        return { ok: true, endpoint: { url: result.endpoint.url, token: result.endpoint.token } };
      }
      return { ok: false, error: result.error ?? 'unknown error' };
    })
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}

export interface UseLiveBrowser {
  runtime: LiveBrowserRuntimeInfo;
  retryRuntime: () => void;
  connected: boolean;
  connecting: boolean;
  meta: LadControlMeta | null;
  areas: LadArea[];
  regions: LadRegion[];
  workspace: LadWorkspaceSettings;
  lastError: string | null;
  /** Register the canvas that receives screencast frames. */
  attachCanvas: (canvas: HTMLCanvasElement | null) => void;
  /** True when a frame has been received for this conversation. */
  hasFrame: boolean;
  navigate: (action: 'open' | 'back' | 'forward' | 'reload', url?: string) => Promise<void>;
  ground: (
    rect: { x: number; y: number; width: number; height: number },
    opts?: { areaId?: string; note?: string },
  ) => Promise<{ region: LadRegion; area: LadArea | null }>;
  createArea: (body: { name: string; description?: string; status?: string }) => Promise<LadArea>;
  updateArea: (
    areaId: string,
    body: { name?: string; description?: string; status?: string },
  ) => Promise<LadArea>;
  removeArea: (areaId: string) => Promise<void>;
  removeRegion: (regionId: string) => Promise<void>;
  attachRegion: (regionId: string, areaId: string) => Promise<void>;
  setWorkspacePatch: (patch: Partial<LadWorkspaceSettings>) => Promise<void>;
  setOwnership: (ownership: 'user' | 'agent') => Promise<void>;
  setViewportSize: (body: { width: number; height: number; zoom?: number }) => Promise<void>;
  setVisible: (visible: boolean) => Promise<void>;
  act: (body: {
    action: string;
    selector?: string;
    value?: string;
    x?: number;
    y?: number;
  }) => Promise<void>;
  captureRegionCrop: (
    rect: { x: number; y: number; width: number; height: number },
    maxEdge?: number,
  ) => Promise<{ data: string; mime: string; width: number; height: number }>;
  readPage: (maxChars?: number, selector?: string) => Promise<string>;
  liveProjection: (regionId: string) => Promise<LadRegion>;
  recordCheck: (
    areaId: string,
    body: { result?: string; reason?: string; newStatus?: string },
  ) => Promise<LadArea>;
  closeSession: () => Promise<void>;
  scrollSnapshot: () => Promise<{
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    dpr: number;
    url: string;
  }>;
}

export function useLiveBrowser(conversationId: string | null): UseLiveBrowser {
  const [runtime, setRuntime] = useState<LiveBrowserRuntimeInfo>({
    running: false,
    endpoint: null,
    error: null,
    node: null,
  });
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [meta, setMeta] = useState<LadControlMeta | null>(null);
  const [areas, setAreas] = useState<LadArea[]>([]);
  const [regions, setRegions] = useState<LadRegion[]>([]);
  const [workspace, setWorkspace] = useState<LadWorkspaceSettings>({
    mode: 'split',
    panelWidth: 560,
    viewport: 'auto',
    previewScale: 'fit',
    pan: { x: 0, y: 0 },
    visible: true,
  });
  const [lastError, setLastError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<LiveBrowserClient | null>(null);
  const conversationIdRef = useRef<string | null>(conversationId);
  conversationIdRef.current = conversationId;

  // --- runtime bootstrap -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void getRuntimeInfo().then((info) => {
      if (cancelled) return;
      setRuntime(info);
      if (!info.endpoint) {
        void startRuntime().then((result) => {
          if (cancelled) return;
          if (result.ok && result.endpoint) {
            setRuntime((prev) => ({ ...prev, running: true, endpoint: result.endpoint!, error: null }));
          } else {
            setRuntime((prev) => ({ ...prev, running: false, error: result.error ?? prev.error }));
          }
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const retryRuntime = useCallback(() => {
    setRuntime((prev) => ({ ...prev, error: null }));
    setConnecting(true);
    void startRuntime()
      .then((result) => {
        if (result.ok && result.endpoint) {
          setRuntime({ running: true, endpoint: result.endpoint, error: null, node: null });
        } else {
          setRuntime((prev) => ({ ...prev, running: false, error: result.error ?? 'start failed' }));
        }
      })
      .finally(() => setConnecting(false));
  }, []);

  // --- canvas attachment --------------------------------------------------
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
  }, []);

  // --- SSE connection ------------------------------------------------------
  useEffect(() => {
    if (!conversationId || !runtime.endpoint) return;
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    setConnecting(true);

    const endpoint = runtime.endpoint;
    const client = new LiveBrowserClient(endpoint);
    clientRef.current = client;

    const drawFrame = (data: string, width: number, height: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !width || !height) return;
      // The canvas buffer matches the frame's device pixels; CSS layout
      // (object-fit) handles the display scaling.
      if (canvas.width !== Math.round(width) || canvas.height !== Math.round(height)) {
        canvas.width = Math.round(width);
        canvas.height = Math.round(height);
      }
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      createImageBitmap(blob)
        .then((bitmap) => {
          if (cancelled) {
            bitmap.close();
            return;
          }
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            bitmap.close();
            return;
          }
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          setHasFrame(true);
        })
        .catch(() => {
          // frame decode failed; keep the previous frame
        });
    };

    const connect = () => {
      if (cancelled) return;
      es?.close();
      es = new EventSource(client.sseUrl(conversationId));
      es.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        setConnecting(false);
      };
      es.onerror = () => {
        // EventSource auto-reconnects; reflect state and give up after the
        // browser's retries if the runtime is gone.
        setConnected(false);
      };
      es.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as {
            t: string;
            data?: string;
            width?: number;
            height?: number;
            meta?: LadControlMeta;
            areas?: LadArea[];
            regions?: LadRegion[];
            workspace?: LadWorkspaceSettings;
          };
          if (message.t === 'frame' && message.data) {
            drawFrame(message.data, message.width ?? 0, message.height ?? 0);
          } else if (message.t === 'meta' && message.meta) {
            setMeta(message.meta);
          } else if (message.t === 'state' && message.areas) {
            setAreas(message.areas);
            setRegions(message.regions ?? []);
            if (message.workspace) setWorkspace(message.workspace);
          }
        } catch {
          // ignore malformed SSE payloads
        }
      };
    };

    void client
      .setActive(conversationId)
      .then(() => connect())
      .catch((error) => {
        setLastError(error instanceof Error ? error.message : String(error));
        setConnecting(false);
      });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      clientRef.current = null;
      setConnected(false);
    };
  }, [conversationId, runtime.endpoint]);

  // --- control helpers -----------------------------------------------------
  const client = useCallback((): LiveBrowserClient | null => {
    const conversation = conversationIdRef.current;
    if (!clientRef.current || !conversation) return null;
    return clientRef.current;
  }, []);

  const guard = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        const result = await fn();
        setLastError(null);
        return result;
      } catch (error) {
        const message = error instanceof LiveBrowserApiError ? error.message : String(error);
        setLastError(message);
        throw error;
      }
    },
    [],
  );

  const navigate = useCallback(
    (action: 'open' | 'back' | 'forward' | 'reload', url?: string) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.resolve();
      return guard(async () => {
        await c.navigate(conversation, action, url);
        const state = await c.state(conversation);
        if (state.meta) setMeta(state.meta);
      });
    },
    [client, guard],
  );

  const ground = useCallback(
    (
      rect: { x: number; y: number; width: number; height: number },
      opts?: { areaId?: string; note?: string },
    ) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) {
        return Promise.reject(new Error('live-browser not connected'));
      }
      return guard(async () => {
        const result = await c.ground(conversation, rect, opts);
        const state = await c.state(conversation);
        setAreas(state.areas);
        setRegions(state.regions);
        if (state.workspace) setWorkspace(state.workspace);
        if (state.meta) setMeta(state.meta);
        return result;
      });
    },
    [client, guard],
  );

  const refreshState = useCallback(async (c: LiveBrowserClient, conversation: string) => {
    const state = await c.state(conversation);
    setAreas(state.areas);
    setRegions(state.regions);
    if (state.workspace) setWorkspace(state.workspace);
    if (state.meta) setMeta(state.meta);
  }, []);

  const createArea = useCallback(
    (body: { name: string; description?: string; status?: string }) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        const result = await c.createArea(conversation, body);
        await refreshState(c, conversation);
        return result.area;
      });
    },
    [client, guard, refreshState],
  );

  const updateArea = useCallback(
    (areaId: string, body: { name?: string; description?: string; status?: string }) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        const result = await c.updateArea(conversation, areaId, body);
        await refreshState(c, conversation);
        return result.area;
      });
    },
    [client, guard, refreshState],
  );

  const removeArea = useCallback(
    (areaId: string) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        await c.removeArea(conversation, areaId);
        await refreshState(c, conversation);
      });
    },
    [client, guard, refreshState],
  );

  const removeRegion = useCallback(
    (regionId: string) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        await c.removeRegion(conversation, regionId);
        await refreshState(c, conversation);
      });
    },
    [client, guard, refreshState],
  );

  const attachRegion = useCallback(
    (regionId: string, areaId: string) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        await c.attachRegion(conversation, regionId, areaId);
        await refreshState(c, conversation);
      });
    },
    [client, guard, refreshState],
  );

  const setWorkspacePatch = useCallback(
    (patch: Partial<LadWorkspaceSettings>) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.resolve();
      return guard(async () => {
        const result = await c.setWorkspace(conversation, patch);
        setWorkspace(result.workspace);
      });
    },
    [client, guard],
  );

  const setOwnership = useCallback(
    (ownership: 'user' | 'agent') => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.resolve();
      return guard(async () => {
        await c.setOwnership(conversation, ownership);
        const state = await c.state(conversation);
        if (state.meta) setMeta(state.meta);
      });
    },
    [client, guard],
  );

  const setViewportSize = useCallback(
    (body: { width: number; height: number; zoom?: number }) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.resolve();
      return guard(async () => {
        await c.setViewport(conversation, body);
        const state = await c.state(conversation);
        if (state.meta) setMeta(state.meta);
      });
    },
    [client, guard],
  );

  const setVisible = useCallback(
    (visible: boolean) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.resolve();
      return guard(async () => {
        await c.setVisible(conversation, visible);
      });
    },
    [client, guard],
  );

  const act = useCallback(
    (body: { action: string; selector?: string; value?: string; x?: number; y?: number }) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        await c.act(conversation, body);
      });
    },
    [client, guard],
  );

  const captureRegionCrop = useCallback(
    (rect: { x: number; y: number; width: number; height: number }, maxEdge = 1280) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        const result = await c.captureCrop(conversation, rect, maxEdge);
        return { data: result.data, mime: result.mime, width: result.width, height: result.height };
      });
    },
    [client, guard],
  );

  const readPage = useCallback(
    (maxChars = 12000, selector?: string) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        const result = await c.read(conversation, maxChars, selector);
        return result.text;
      });
    },
    [client, guard],
  );

  const liveProjection = useCallback(
    (regionId: string) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        const result = await c.liveProjection(conversation, regionId);
        await refreshState(c, conversation);
        return result.region;
      });
    },
    [client, guard, refreshState],
  );

  const recordCheck = useCallback(
    (areaId: string, body: { result?: string; reason?: string; newStatus?: string }) => {
      const c = client();
      const conversation = conversationIdRef.current;
      if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
      return guard(async () => {
        const result = await c.recordCheck(conversation, areaId, body);
        await refreshState(c, conversation);
        return result.area;
      });
    },
    [client, guard, refreshState],
  );

  const closeSession = useCallback(() => {
    const c = client();
    const conversation = conversationIdRef.current;
    if (!c || !conversation) return Promise.resolve();
    return guard(async () => {
      await c.closeSession(conversation);
      setMeta(null);
      setAreas([]);
      setRegions([]);
    });
  }, [client, guard]);

  const scrollSnapshot = useCallback(() => {
    const c = client();
    const conversation = conversationIdRef.current;
    if (!c || !conversation) return Promise.reject(new Error('live-browser not connected'));
    return c.scrollSnapshot(conversation);
  }, [client]);

  const value = useMemo<UseLiveBrowser>(
    () => ({
      runtime,
      retryRuntime,
      connected,
      connecting,
      meta,
      areas,
      regions,
      workspace,
      lastError,
      attachCanvas,
      hasFrame,
      navigate,
      ground,
      createArea,
      updateArea,
      removeArea,
      removeRegion,
      attachRegion,
      setWorkspacePatch,
      setOwnership,
      setViewportSize,
      setVisible,
      act,
      captureRegionCrop,
      readPage,
      liveProjection,
      recordCheck,
      closeSession,
      scrollSnapshot,
    }),
    [
      runtime,
      retryRuntime,
      connected,
      connecting,
      meta,
      areas,
      regions,
      workspace,
      lastError,
      attachCanvas,
      hasFrame,
      navigate,
      ground,
      createArea,
      updateArea,
      removeArea,
      removeRegion,
      attachRegion,
      setWorkspacePatch,
      setOwnership,
      setViewportSize,
      setVisible,
      act,
      captureRegionCrop,
      readPage,
      liveProjection,
      recordCheck,
      closeSession,
      scrollSnapshot,
    ],
  );

  return value;
}
