import type { BrowserManager, LadSession } from './browser';
import { log } from './util';

export interface LadScreencastFrame {
  data: string;
  width: number;
  height: number;
  ts: number;
}

type LadFrameListener = (frame: LadScreencastFrame) => void;

interface ScreencastState {
  conversationId: string;
  mode: 'screencast' | 'polling' | 'suspended' | 'idle';
  subscribers: Set<LadFrameListener>;
  lastFrame: LadScreencastFrame | null;
  frameHandler?: (params: unknown) => void;
  pollTimer?: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setInterval>;
  startedAt: number;
  frames: number;
  lastFrameAt: number;
}

const MAX_FRAME_EDGE = 3840;
const JPEG_QUALITY = 72;
const POLL_INTERVAL_MS = 400;
/** If CDP screencast produces no frames within this window, fall back to polling. */
const SCREENCAST_GRACE_MS = 3000;

/**
 * Live frame pipeline: Playwright Page → CDP Page.startScreencast →
 * subscribers (the control WebSocket). If the CDP screencast is unavailable
 * (headless quirks), a bounded polling fallback keeps the UI alive.
 *
 * Suspending (panel hidden) stops frame production but never touches the
 * page, so the agent keeps working while the panel is hidden.
 */
export class ScreencastHub {
  private states = new Map<string, ScreencastState>();

  constructor(private readonly manager: BrowserManager) {
    manager.on('lad', (event) => {
      if (event.type === 'meta') {
        // Viewport/zoom changes may need new screencast max dimensions.
        const state = this.states.get(event.conversationId);
        if (state && state.mode === 'screencast')
          void this.restartForViewport(event.conversationId);
      }
    });
  }

  stateOf(conversationId: string): 'active' | 'suspended' | 'idle' {
    const state = this.states.get(conversationId);
    if (!state) return 'idle';
    if (state.mode === 'suspended' || state.mode === 'idle') return 'suspended';
    return 'active';
  }

  lastFrame(conversationId: string): LadScreencastFrame | null {
    return this.states.get(conversationId)?.lastFrame ?? null;
  }

  subscribe(conversationId: string, listener: LadFrameListener): () => void {
    let state = this.states.get(conversationId);
    if (!state) {
      state = {
        conversationId,
        mode: 'idle',
        subscribers: new Set(),
        lastFrame: null,
        startedAt: Date.now(),
        frames: 0,
        lastFrameAt: 0,
      };
      this.states.set(conversationId, state);
    }
    state.subscribers.add(listener);
    if (state.mode === 'idle')
      void this.ensureRunning(conversationId).catch((error) =>
        log('preview connection failed:', String(error))
      );
    return () => {
      state.subscribers.delete(listener);
      if (state.subscribers.size === 0) {
        // Keep producing briefly? No: no subscribers and not suspended → stop to save CPU.
        this.stop(conversationId);
        state.lastFrame = null;
        this.states.delete(conversationId);
      }
    };
  }

  /** Renderer told us the panel visibility for this chat. */
  async setVisible(conversationId: string, visible: boolean): Promise<void> {
    const state = this.states.get(conversationId);
    if (visible) {
      if (state && (state.mode === 'suspended' || state.mode === 'idle')) {
        void this.ensureRunning(conversationId);
      }
      return;
    }
    if (state) state.mode = 'suspended';
    this.stop(conversationId);
  }

  private async ensureRunning(conversationId: string): Promise<void> {
    const state = this.states.get(conversationId);
    if (!state || state.mode === 'screencast' || state.mode === 'polling') return;
    const session = await this.manager.get(conversationId);
    if (this.states.get(conversationId) !== state || state.subscribers.size === 0) return;
    if (session.native) {
      state.mode = 'suspended';
      return;
    }
    this.runScreencast(conversationId, session).catch((error) => {
      log(
        'screencast start failed, starting polling fallback:',
        error instanceof Error ? error.message : error
      );
      this.startPolling(conversationId);
    });
  }

  private async runScreencast(conversationId: string, session: LadSession): Promise<void> {
    const state = this.states.get(conversationId);
    if (!state) return;
    if (state.mode === 'screencast') this.stop(conversationId);
    state.mode = 'screencast';
    state.startedAt = Date.now();
    state.frames = 0;
    state.lastFrameAt = Date.now();

    const maxW = Math.min(
      MAX_FRAME_EDGE,
      Math.round(session.viewport.width * session.dpr * session.zoom)
    );
    const maxH = Math.min(
      MAX_FRAME_EDGE,
      Math.round(session.viewport.height * session.dpr * session.zoom)
    );

    const frameHandler = (params: unknown) => {
      const p = params as {
        sessionId: number;
        data: string;
        metadata: {
          deviceWidth: number;
          deviceHeight: number;
          pageScaleFactor: number;
          cssWidth?: number;
          cssHeight?: number;
        };
      };
      const frame: LadScreencastFrame = {
        data: p.data,
        width: p.metadata.deviceWidth,
        height: p.metadata.deviceHeight,
        ts: Date.now(),
      };
      const st = this.states.get(conversationId);
      if (!st) return;
      st.frames += 1;
      st.lastFrame = frame;
      st.lastFrameAt = frame.ts;
      for (const listener of st.subscribers) {
        try {
          listener(frame);
        } catch {
          /* listener errors must not break the pump */
        }
      }
      // Ack so CDP keeps sending.
      void session
        .cdp!.send('Page.screencastFrameAck', { sessionId: p.sessionId })
        .catch(() => undefined);
    };

    session.cdp!.on('Page.screencastFrame', frameHandler);
    state.frameHandler = frameHandler;
    await session.cdp!.send('Page.enable');
    await session.cdp!.send('Page.startScreencast', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      maxWidth: maxW,
      maxHeight: maxH,
      everyNthFrame: 2,
    });

    // Watchdog: fall back to polling when the CDP screencast produces no
    // frames within the grace window OR stops advancing (stall). A one-shot
    // grace timer that bails when `frames > 0` would leave the UI frozen on
    // the last frame if CDP delivered one frame and then went quiet.
    const watchdog = setInterval(() => {
      const st = this.states.get(conversationId);
      if (!st || st.mode !== 'screencast') {
        clearInterval(watchdog);
        return;
      }
      const stalled = Date.now() - st.lastFrameAt > SCREENCAST_GRACE_MS;
      if (st.frames === 0 || stalled) {
        clearInterval(watchdog);
        log(`CDP screencast stalled (frames=${st.frames}); switching to polling fallback`);
        this.stop(conversationId);
        this.startPolling(conversationId);
      }
    }, SCREENCAST_GRACE_MS);
    state.watchdog = watchdog;
    watchdog.unref?.();
  }

  private restartForViewport(conversationId: string): void {
    if (!this.manager.pageOf(conversationId)) return;
    // Re-run with new dimensions; stop first inside runScreencast.
    void this.ensureRunning(conversationId);
  }

  private startPolling(conversationId: string): void {
    const state = this.states.get(conversationId);
    if (!state) return;
    state.mode = 'polling';
    state.startedAt = Date.now();
    state.frames = 0;
    const tick = async () => {
      const st = this.states.get(conversationId);
      if (!st || st.mode !== 'polling' || st.subscribers.size === 0) {
        if (st) st.mode = 'idle';
        return;
      }
      const result = await this.manager.captureFrame(conversationId, { quality: JPEG_QUALITY });
      const s = this.states.get(conversationId);
      if (!s || s.mode !== 'polling' || s.subscribers.size === 0) return;
      if ('error' in result) {
        s.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      const frame: LadScreencastFrame = {
        data: result.data,
        width: result.width,
        height: result.height,
        ts: Date.now(),
      };
      s.frames += 1;
      s.lastFrame = frame;
      for (const listener of s.subscribers) {
        try {
          listener(frame);
        } catch {
          /* ignore */
        }
      }
      if (s.mode === 'polling') s.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    state.pollTimer = setTimeout(tick, 30);
  }

  stop(conversationId: string): void {
    const state = this.states.get(conversationId);
    if (!state) return;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = undefined;
    }
    if (state.watchdog) {
      clearInterval(state.watchdog);
      state.watchdog = undefined;
    }
    if (state.frameHandler) {
      const session = this.manager.sessionOf(conversationId);
      if (session) {
        session.cdp!.off('Page.screencastFrame', state.frameHandler);
        void session.cdp!.send('Page.stopScreencast').catch(() => undefined);
      }
      state.frameHandler = undefined;
    }
    state.mode = state.subscribers.size === 0 ? 'idle' : 'suspended';
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.states.keys()]) this.stop(id);
    this.states.clear();
  }
}
