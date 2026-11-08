import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright-core';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { isAllowedPageUrl, isBlockedResourceUrl } from './security';
import { log } from './util';

export type LadOwnership = 'user' | 'agent';

export interface LadSession {
  conversationId: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  ownership: LadOwnership;
  visible: boolean;
  /** Page zoom factor (1 = 100%). Rendered size = CSS px * dpr * zoom. */
  zoom: number;
  /** Base device pixel ratio (display). */
  dpr: number;
  viewport: { width: number; height: number };
  ready: boolean;
  agentBusy: boolean;
  lastError?: string;
  url: string;
  title: string;
  createdAt: number;
}

export type LadRuntimeEvent =
  | { type: 'session'; conversationId: string; detail: 'created' | 'restored' | 'closed' }
  | {
      type: 'action';
      conversationId: string;
      source: 'user' | 'agent';
      tool: string;
      summary: string;
    }
  | {
      type: 'error';
      conversationId: string;
      code: 'browser-restarted' | 'page-crashed' | 'navigation-blocked' | 'runtime-error';
      message: string;
    }
  | { type: 'meta'; conversationId: string }
  | { type: 'state'; conversationId: string };

/**
 * Find a usable system Chromium/Chrome binary. The Playwright registry cache
 * is often absent in this environment; the system browser is the supported
 * runtime (same Chromium family).
 */
function findSystemChrome(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-stable',
          ];
  try {
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Owns ONE Chromium and one Playwright Page per conversation.
 *
 * - The agent (via MCP tools) and the screencast UI observe the SAME page.
 * - Hiding the panel suspends the screencast only; the Page keeps running.
 * - If Chromium crashes/exits, sessions are rebuilt (regions survive: they are
 *   stored separately).
 */
export class BrowserManager extends EventEmitter {
  private browser: Browser | null = null;
  private sessions = new Map<string, LadSession>();
  private closing = false;
  private creating = new Map<string, Promise<LadSession>>();
  private launchPromise: Promise<Browser> | null = null;
  private readonly chromePath: string | null;
  private readonly headless: boolean;
  private readonly extraArgs: string[];

  constructor(options: { chromePath?: string; headless?: boolean; extraArgs?: string[] } = {}) {
    super();
    this.chromePath = options.chromePath ?? findSystemChrome();
    this.headless = options.headless ?? true;
    this.extraArgs = options.extraArgs ?? [];
  }

  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = (async () => {
      log(
        'launching chromium',
        this.chromePath ?? '(bundled)',
        this.headless ? 'headless' : 'headed'
      );
      const browser = await chromium.launch({
        executablePath: this.chromePath ?? undefined,
        headless: this.headless,
        args: [
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--disable-features=CalculateNativeWinOcclusion',
          '--no-first-run',
          '--no-default-browser-check',
          ...this.extraArgs,
        ],
      });
      this.browser = browser;
      browser.on('disconnected', () => {
        log('browser disconnected; will relaunch on demand');
        this.browser = null;
        this.launchPromise = null;
      });
      return browser;
    })();
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  /** Create (or reuse) the session for a conversation. */
  async get(
    conversationId: string,
    opts: { viewport?: { width: number; height: number }; dpr?: number } = {}
  ): Promise<LadSession> {
    const pending = this.creating.get(conversationId);
    if (pending) return pending;
    const creation = this.createSession(conversationId, opts);
    this.creating.set(conversationId, creation);
    try {
      return await creation;
    } finally {
      this.creating.delete(conversationId);
    }
  }

  private async createSession(
    conversationId: string,
    opts: { viewport?: { width: number; height: number }; dpr?: number }
  ): Promise<LadSession> {
    const existing = this.sessions.get(conversationId);
    if (existing && !existing.page.isClosed() && this.browser?.isConnected()) {
      return existing;
    }
    if (existing) await this.closeSession(conversationId, { silent: true });

    const browser = await this.ensureBrowser();
    const viewport = opts.viewport ?? { width: 1280, height: 800 };
    const dpr = opts.dpr ?? 1;
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: dpr,
      colorScheme: 'light',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) LocalAIDesktopLiveBrowser/0.4 Chrome/157 Safari/537.36',
    });

    // Security: abort non-http(s) resource loads (file:, data:, ...).
    await context.route('**/*', (route) => {
      const req = route.request();
      if (req.resourceType() === 'document') {
        const check = isAllowedPageUrl(req.url());
        if (!check.ok) {
          this.emitLadEvent({
            type: 'error',
            conversationId,
            code: 'navigation-blocked',
            message: `blocked navigation to ${req.url().slice(0, 200)} (${check.reason})`,
          });
          return route.abort('blockedbyclient');
        }
      } else if (isBlockedResourceUrl(req.url())) {
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });

    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);

    const session: LadSession = {
      conversationId,
      context,
      page,
      cdp,
      ownership: 'user',
      visible: true,
      zoom: 1,
      dpr,
      viewport,
      ready: false,
      agentBusy: false,
      url: 'about:blank',
      title: '',
      createdAt: Date.now(),
    };
    this.sessions.set(conversationId, session);

    const refreshTitle = () => {
      page
        .title()
        .then((t) => {
          if (session.title !== t) {
            session.title = t;
            this.emitMeta(conversationId);
          }
        })
        .catch(() => undefined);
    };
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        session.url = frame.url();
        refreshTitle();
        this.emitMeta(conversationId);
      }
    });
    page.on('load', () => {
      session.ready = true;
      refreshTitle();
      this.emitMeta(conversationId);
    });
    // Poll title a few times after navigation (SPAs set it late).
    const titleTimer = setInterval(() => {
      if (!page.isClosed()) refreshTitle();
    }, 2000).unref?.();
    page.on('crash', () => {
      log(`page crashed: ${conversationId}`);
      this.emitLadEvent({
        type: 'error',
        conversationId,
        code: 'page-crashed',
        message: 'page crashed',
      });
      void this.rebuildSession(conversationId);
    });

    // If Chromium died while the page existed, rebuild transparently.
    const disconnected = () => {
      clearInterval(titleTimer);
      if (this.sessions.get(conversationId) === session) {
        this.sessions.delete(conversationId);
        this.emitLadEvent({
          type: 'error',
          conversationId,
          code: 'browser-restarted',
          message: 'browser process exited; session will be rebuilt on next use',
        });
      }
    };

    browser.on('disconnected', disconnected);
    page.once('close', () => {
      clearInterval(titleTimer);
      browser.off('disconnected', disconnected);
    });

    this.emitLadEvent({ type: 'session', conversationId, detail: 'created' });
    this.emitMeta(conversationId);
    return session;
  }

  private async rebuildSession(conversationId: string): Promise<void> {
    try {
      const saved = this.sessions.get(conversationId);
      const url = saved?.url && saved.url !== 'about:blank' ? saved.url : null;
      await this.closeSession(conversationId, { silent: true });
      if (url) {
        const session = await this.get(conversationId);
        await session.page.goto(url, { timeout: 60_000 }).catch(() => undefined);
      }
      this.emitLadEvent({ type: 'session', conversationId, detail: 'restored' });
    } catch (error) {
      this.emitLadEvent({
        type: 'error',
        conversationId,
        code: 'runtime-error',
        message: `session rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private emitMeta(conversationId: string): void {
    this.emitLadEvent({ type: 'meta', conversationId });
  }

  private emitLadEvent(event: LadRuntimeEvent): void {
    this.emit('lad', event);
  }

  meta(conversationId: string) {
    const session = this.sessions.get(conversationId);
    if (!session) return null;
    return {
      conversationId,
      url: session.url,
      title: session.title,
      ready: session.ready,
      ownership: session.ownership,
      visible: session.visible,
      zoom: session.zoom,
      dpr: session.dpr,
      viewport: session.viewport,
      agentBusy: session.agentBusy,
      lastError: session.lastError,
    };
  }

  async navigate(
    conversationId: string,
    url: string,
    source: 'user' | 'agent'
  ): Promise<{ ok: boolean; summary: string; error?: string }> {
    const check = isAllowedPageUrl(url);
    if (!check.ok) {
      return { ok: false, summary: '', error: check.reason };
    }
    try {
      const session = await this.get(conversationId);
      session.agentBusy = source === 'agent';
      session.lastError = undefined;
      await session.page.goto(check.url, { timeout: 60_000, waitUntil: 'domcontentloaded' });
      session.url = session.page.url();
      this.emitAction(conversationId, source, 'browser_open', `opened ${check.url}`);
      this.emitMeta(conversationId);
      return { ok: true, summary: `opened ${check.url}` };
    } catch (error) {
      this.fail(conversationId, error);
      return {
        ok: false,
        summary: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private fail(conversationId: string, error: unknown): void {
    const session = this.sessions.get(conversationId);
    if (session) session.lastError = error instanceof Error ? error.message : String(error);
    this.emitLadEvent({
      type: 'error',
      conversationId,
      code: 'runtime-error',
      message: error instanceof Error ? error.message : String(error),
    });
    this.emitMeta(conversationId);
  }

  private emitAction(
    conversationId: string,
    source: 'user' | 'agent',
    tool: string,
    summary: string
  ): void {
    this.emitLadEvent({ type: 'action', conversationId, source, tool, summary });
  }

  private async act(
    conversationId: string,
    source: 'user' | 'agent',
    tool: string,
    summary: string,
    fn: (session: LadSession) => Promise<unknown>
  ): Promise<{ ok: boolean; summary: string; error?: string }> {
    try {
      const session = await this.get(conversationId);
      session.agentBusy = source === 'agent';
      session.lastError = undefined;
      const result = await fn(session);
      this.emitAction(conversationId, source, tool, summary);
      this.emitMeta(conversationId);
      const extra = typeof result === 'string' && result ? ` — ${result}` : '';
      return { ok: true, summary: summary + extra };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const session = this.sessions.get(conversationId);
      if (session) session.lastError = message;
      this.emitMeta(conversationId);
      return { ok: false, summary: '', error: message };
    }
  }

  back(conversationId: string, source: 'user' | 'agent') {
    return this.act(conversationId, source, 'browser_back', 'navigated back', async (s) =>
      s.page.goBack({ timeout: 30_000 })
    );
  }
  forward(conversationId: string, source: 'user' | 'agent') {
    return this.act(conversationId, source, 'browser_forward', 'navigated forward', async (s) =>
      s.page.goForward({ timeout: 30_000 })
    );
  }
  reload(conversationId: string, source: 'user' | 'agent') {
    return this.act(conversationId, source, 'browser_reload', 'reloaded page', async (s) =>
      s.page.reload({ timeout: 30_000, waitUntil: 'domcontentloaded' })
    );
  }

  state(
    conversationId: string
  ): { url: string; title: string; ready: boolean; ownership: LadOwnership } | null {
    const session = this.sessions.get(conversationId);
    if (!session) return null;
    return {
      url: session.url,
      title: session.title,
      ready: session.ready,
      ownership: session.ownership,
    };
  }

  setOwnership(
    conversationId: string,
    ownership: LadOwnership,
    source: 'user' | 'agent' = 'user'
  ): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    if (session.ownership !== ownership) {
      session.ownership = ownership;
      this.emitAction(conversationId, source, 'browser_ownership', `ownership → ${ownership}`);
    }
    this.emitMeta(conversationId);
  }

  /**
   * Set viewport + page zoom. Mirrors the original workspace model:
   * - viewport = layout size in CSS px
   * - zoom = page zoom factor; rendered device px = css * dpr * zoom
   * Implemented via Emulation.setDeviceMetricsOverride exactly like the
   * original native-project-page.ts (width=cssW, dpr=dpr*zoom).
   */
  async setViewport(
    conversationId: string,
    viewport: { width: number; height: number },
    zoom = 1,
    source: 'user' | 'agent' = 'user'
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const session = await this.get(conversationId);
      const width = Math.max(320, Math.min(7680, Math.round(viewport.width)));
      const height = Math.max(240, Math.min(7680, Math.round(viewport.height)));
      const z = Math.max(0.25, Math.min(4, zoom));
      await session.page.setViewportSize({ width, height });
      await session.cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: session.dpr * z,
        mobile: false,
      });
      session.viewport = { width, height };
      session.zoom = z;
      this.emitAction(
        conversationId,
        source,
        'browser_viewport',
        `viewport ${width}x${height} zoom ${Math.round(z * 100)}%`
      );
      this.emitMeta(conversationId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Capture a crop in CSS pixels (viewport-relative). Returns base64 image.
   * Uses CDP Page.captureScreenshot with clip — the same compositor path the
   * original used (contents.capturePage), avoiding Playwright's full-page
   * pipeline. Coordinates are pre-zoom CSS px; CDP applies the zoom scale.
   */
  async captureCrop(
    conversationId: string,
    rect: { x: number; y: number; width: number; height: number },
    opts: { format?: 'jpeg' | 'png'; quality?: number; maxEdge?: number } = {}
  ): Promise<
    | { mime: 'image/jpeg' | 'image/png'; data: string; width: number; height: number }
    | { error: string }
  > {
    const session = this.sessions.get(conversationId);
    if (!session) return { error: 'no-session' };
    const format = opts.format ?? 'jpeg';
    const quality = opts.quality ?? 80;
    const maxEdge = opts.maxEdge ?? 1600;
    // Clip is in DIP (CSS px * zoom). CDP `scale` shrinks the output; the
    // output edge never exceeds maxEdge.
    const zoom = session.zoom;
    const fullW = rect.width * zoom * session.dpr;
    const fullH = rect.height * zoom * session.dpr;
    const scale = Math.min(1, maxEdge / Math.max(fullW, fullH));
    try {
      const scroll = await session.page.evaluate(() => ({ x: scrollX, y: scrollY }));
      const result = await session.cdp.send('Page.captureScreenshot', {
        format,
        quality,
        clip: {
          x: rect.x + scroll.x,
          y: rect.y + scroll.y,
          width: rect.width,
          height: rect.height,
          scale,
        },
        captureBeyondViewport: false,
      });
      const data = result.data as string;
      const width = Math.max(1, Math.round(fullW * scale));
      const height = Math.max(1, Math.round(fullH * scale));
      return { mime: format === 'png' ? 'image/png' : 'image/jpeg', data, width, height };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Full-viewport frame via Playwright (JPEG). */
  async captureFrame(
    conversationId: string,
    opts: { maxEdge?: number; quality?: number } = {}
  ): Promise<{ mime: string; data: string; width: number; height: number } | { error: string }> {
    const session = this.sessions.get(conversationId);
    if (!session) return { error: 'no-session' };
    try {
      const buffer = await session.page.screenshot({
        type: 'jpeg',
        quality: opts.quality ?? 75,
        fullPage: false,
      });
      return {
        mime: 'image/jpeg',
        data: buffer.toString('base64'),
        width: Math.round(session.viewport.width * session.dpr * session.zoom),
        height: Math.round(session.viewport.height * session.dpr * session.zoom),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Evaluate a bounded function in the page. */
  async evaluate<T>(
    conversationId: string,
    fn: (page: Page) => Promise<T> | T
  ): Promise<T | { error: string }> {
    const session = this.sessions.get(conversationId);
    if (!session) return { error: 'no-session' };
    try {
      return await fn(session.page);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  pageOf(conversationId: string): Page | null {
    return this.sessions.get(conversationId)?.page ?? null;
  }

  sessionOf(conversationId: string): LadSession | null {
    return this.sessions.get(conversationId) ?? null;
  }

  setScreencastVisible(conversationId: string, visible: boolean): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.visible = visible;
    this.emitMeta(conversationId);
  }

  async closeSession(conversationId: string, opts: { silent?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    this.sessions.delete(conversationId);
    try {
      await session.context.close();
    } catch {
      /* already closed */
    }
    if (!opts.silent) {
      this.emitLadEvent({ type: 'session', conversationId, detail: 'closed' });
      this.emitMeta(conversationId);
    }
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.closeSession(id, { silent: true });
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        /* already gone */
      }
      this.browser = null;
    }
    log('browser manager shut down');
  }
}
