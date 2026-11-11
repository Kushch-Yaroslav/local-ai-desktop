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
import { log, redactRuntimeText } from './util';

export type LadOwnership = 'user' | 'agent';

export interface LadSession {
  conversationId: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession | null;
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
  native?: boolean;
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
  async verificationViewport(
    id: string,
    viewport: { width: number; height: number }
  ): Promise<() => Promise<void>> {
    const session = await this.get(id);
    if (!session.native) {
      const previous = session.page.viewportSize();
      await session.page.setViewportSize(viewport);
      return async () => {
        if (previous) await session.page.setViewportSize(previous);
      };
    }
    const url = `${process.env.LAD_LB_NATIVE_ENDPOINT}/verification-viewport?conversation=${encodeURIComponent(id)}`;
    const headers = { Authorization: `Bearer ${process.env.LAD_LB_TOKEN}` };
    const response = await fetch(`${url}&width=${viewport.width}&height=${viewport.height}`, {
      headers,
    });
    if (!response.ok) throw new Error('Cannot restore original verification viewport');
    const previous = await response.json();
    return async () => {
      const result = await fetch(`${url}&restore=${encodeURIComponent(JSON.stringify(previous))}`, {
        headers,
      });
      if (!result.ok) throw new Error('Cannot restore preview settings');
    };
  }
  async sourceRevision(
    conversationId: string
  ): Promise<import('../shared/types').LadSourceRevision> {
    const endpoint = process.env.LAD_LB_NATIVE_ENDPOINT;
    if (!endpoint) throw new Error('Source verification requires the native Goose project bridge');
    const response = await fetch(
      `${endpoint}/source-revision?conversation=${encodeURIComponent(conversationId)}`,
      {
        headers: { Authorization: `Bearer ${process.env.LAD_LB_TOKEN}` },
        signal: AbortSignal.timeout(17000),
      }
    );
    const value = (await response.json()) as import('../shared/types').LadSourceRevision & {
      error?: string;
    };
    if (!response.ok || value.error || !value.root || !/^[a-f0-9]{64}$/.test(value.fingerprint))
      throw new Error(value.error || 'Project revision unavailable');
    return value;
  }

  private browser: Browser | null = null;
  private sessions = new Map<string, LadSession>();
  private visibility = new Map<string, boolean>();
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
    const creation = this.createSession(conversationId, opts).catch((error) => {
      throw new Error(redactRuntimeText(error instanceof Error ? error.message : String(error)));
    });
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
    if (existing && !existing.page.isClosed() && (existing.native || this.browser?.isConnected())) {
      return existing;
    }
    if (existing) await this.closeSession(conversationId, { silent: true });

    const nativeEndpoint = process.env.LAD_LB_NATIVE_ENDPOINT;
    let browser: Browser;
    if (nativeEndpoint) {
      const response = await fetch(
        `${nativeEndpoint}/session?conversation=${encodeURIComponent(conversationId)}`,
        { method: 'POST', headers: { Authorization: `Bearer ${process.env.LAD_LB_TOKEN}` } }
      );
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? 'Native browser unavailable');
      try {
        browser = await chromium.connectOverCDP(body.url, { noDefaults: true, timeout: 15000 });
      } catch {
        throw new Error('Native browser connection failed; reconnect the preview');
      }
    } else browser = await this.ensureBrowser();
    const viewport = opts.viewport ?? { width: 1280, height: 800 };
    const dpr = opts.dpr ?? 1;
    const context = nativeEndpoint
      ? browser.contexts()[0]
      : await browser.newContext({
          viewport,
          deviceScaleFactor: dpr,
          colorScheme: 'light',
          userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) LocalAIDesktopLiveBrowser/0.4 Chrome/157 Safari/537.36',
        });

    // Security: abort non-http(s) resource loads (file:, data:, ...).
    if (!nativeEndpoint)
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

    const page = nativeEndpoint ? context.pages()[0] : await context.newPage();
    // Native automation already owns the scoped Page CDP session. Do not attach a second browser-wide target.
    const cdp = nativeEndpoint ? null : await context.newCDPSession(page);

    const session: LadSession = {
      conversationId,
      context,
      page,
      cdp,
      ownership: 'user',
      visible: this.visibility.get(conversationId) ?? !nativeEndpoint,
      zoom: 1,
      dpr,
      viewport,
      ready: false,
      agentBusy: false,
      url: 'about:blank',
      title: '',
      createdAt: Date.now(),
      native: Boolean(nativeEndpoint),
    };
    if (session.native) {
      session.url = page.url();
      session.title = await page.title().catch(() => '');
      const actual = await page
        .evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio,
          ready: document.readyState === 'complete',
        }))
        .catch(() => ({ width: viewport.width, height: viewport.height, dpr, ready: false }));
      session.viewport = { width: actual.width, height: actual.height };
      session.dpr = actual.dpr;
      session.ready = actual.ready;
    }
    this.sessions.set(conversationId, session);

    const refreshTitle = () => {
      page
        .title()
        .then((t) => {
          if (session.title !== t) {
            session.title = t;
            this.emitMeta(session.conversationId);
          }
        })
        .catch(() => undefined);
    };
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        session.url = frame.url();
        refreshTitle();
        this.emitMeta(session.conversationId);
      }
    });
    page.on('load', () => {
      session.ready = true;
      refreshTitle();
      this.emitMeta(session.conversationId);
    });
    // Poll title a few times after navigation (SPAs set it late).
    const titleTimer = setInterval(() => {
      if (!page.isClosed()) {
        refreshTitle();
        if (session.native)
          void page
            .evaluate(() => ({
              width: window.innerWidth,
              height: window.innerHeight,
              dpr: window.devicePixelRatio,
            }))
            .then(async (size) => {
              const response = await fetch(
                `${nativeEndpoint}/metrics?conversation=${encodeURIComponent(session.conversationId)}`,
                { headers: { Authorization: `Bearer ${process.env.LAD_LB_TOKEN}` } }
              );
              const { zoom } = (await response.json()) as { zoom: number };
              if (
                size.width !== session.viewport.width ||
                size.height !== session.viewport.height ||
                size.dpr !== session.dpr ||
                zoom !== session.zoom
              ) {
                session.viewport = { width: size.width, height: size.height };
                session.dpr = size.dpr;
                session.zoom = zoom;
                this.emitMeta(session.conversationId);
              }
            })
            .catch(() => undefined);
      }
    }, 2000).unref?.();
    page.on('crash', () => {
      log(`page crashed: ${session.conversationId}`);
      this.emitLadEvent({
        type: 'error',
        conversationId: session.conversationId,
        code: 'page-crashed',
        message: 'page crashed',
      });
      void this.rebuildSession(session.conversationId);
    });

    // If Chromium died while the page existed, rebuild transparently.
    const disconnected = () => {
      clearInterval(titleTimer);
      if (this.sessions.get(session.conversationId) === session) {
        this.sessions.delete(session.conversationId);
        this.emitLadEvent({
          type: 'error',
          conversationId: session.conversationId,
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
        message: `session rebuild failed: ${redactRuntimeText(error instanceof Error ? error.message : String(error))}`,
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
      native: session.native,
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
      if (source === 'agent') await this.setOwnership(conversationId, 'agent', 'agent');
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
        error: redactRuntimeText(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private fail(conversationId: string, error: unknown): void {
    const session = this.sessions.get(conversationId);
    if (session)
      session.lastError = redactRuntimeText(error instanceof Error ? error.message : String(error));
    this.emitLadEvent({
      type: 'error',
      conversationId,
      code: 'runtime-error',
      message: redactRuntimeText(error instanceof Error ? error.message : String(error)),
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
      if (source === 'agent') await this.setOwnership(conversationId, 'agent', 'agent');
      session.lastError = undefined;
      const result = await fn(session);
      this.emitAction(conversationId, source, tool, summary);
      this.emitMeta(conversationId);
      const extra = typeof result === 'string' && result ? ` — ${result}` : '';
      return { ok: true, summary: summary + extra };
    } catch (error) {
      const message = redactRuntimeText(error instanceof Error ? error.message : String(error));
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

  state(conversationId: string): {
    url: string;
    title: string;
    ready: boolean;
    ownership: LadOwnership;
    visible: boolean;
  } | null {
    const session = this.sessions.get(conversationId);
    if (!session) return null;
    return {
      url: session.url,
      title: session.title,
      ready: session.ready,
      ownership: session.ownership,
      visible: session.visible,
    };
  }

  async setOwnership(
    conversationId: string,
    ownership: LadOwnership,
    source: 'user' | 'agent' = 'user'
  ): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    if (session.ownership !== ownership) {
      session.ownership = ownership;
      this.emitAction(conversationId, source, 'browser_ownership', `ownership → ${ownership}`);
    }
    if (session.native)
      await fetch(
        `${process.env.LAD_LB_NATIVE_ENDPOINT}/ownership?conversation=${encodeURIComponent(conversationId)}&value=${ownership}`,
        { headers: { Authorization: `Bearer ${process.env.LAD_LB_TOKEN}` } }
      ).catch(() => undefined);
    if (ownership === 'user') session.agentBusy = false;
    this.emitMeta(conversationId);
  }

  /**
   * Set viewport + page zoom. Mirrors the original workspace model:
   * - viewport = layout size in CSS px
   * - zoom = page zoom factor; rendered device px = css * dpr * zoom
   * Electron native mode uses real webContents zoom; the standalone
   * screencast fallback retains its legacy device-metric approximation.
   */
  async setViewport(
    conversationId: string,
    viewport: { width: number; height: number },
    zoom = 1,
    source: 'user' | 'agent' = 'user'
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const session = await this.get(conversationId);
      const width = Math.max(320, Math.min(4096, Math.round(viewport.width)));
      const height = Math.max(240, Math.min(4096, Math.round(viewport.height)));
      const z = Math.max(0.25, Math.min(4, zoom));
      if (session.native) {
        const response = await fetch(
          `${process.env.LAD_LB_NATIVE_ENDPOINT}/viewport?conversation=${encodeURIComponent(conversationId)}&width=${width}&height=${height}&zoom=${z}`,
          { headers: { Authorization: `Bearer ${process.env.LAD_LB_TOKEN}` } }
        );
        if (!response.ok) throw new Error('Native viewport update failed');
      } else await session.page.setViewportSize({ width, height });
      if (!session.native)
        await session.cdp!.send('Emulation.setDeviceMetricsOverride', {
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
      return {
        ok: false,
        error: redactRuntimeText(error instanceof Error ? error.message : String(error)),
      };
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
    if (session.native) {
      const response = await fetch(
        `${process.env.LAD_LB_NATIVE_ENDPOINT}/capture?conversation=${encodeURIComponent(conversationId)}&rect=${encodeURIComponent(JSON.stringify(rect))}`,
        { headers: { Authorization: `Bearer ${process.env.LAD_LB_TOKEN}` } }
      );
      return (await response.json()) as {
        mime: 'image/png';
        data: string;
        width: number;
        height: number;
      };
    }
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
      const scroll = await session.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      const result = await session.cdp!.send('Page.captureScreenshot', {
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
      return { error: redactRuntimeText(error instanceof Error ? error.message : String(error)) };
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
      if (session.native) {
        const response = await fetch(
          `${process.env.LAD_LB_NATIVE_ENDPOINT}/capture?conversation=${encodeURIComponent(conversationId)}`,
          { headers: { Authorization: `Bearer ${process.env.LAD_LB_TOKEN}` } }
        );
        return (await response.json()) as {
          mime: string;
          data: string;
          width: number;
          height: number;
        };
      }
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
      return { error: redactRuntimeText(error instanceof Error ? error.message : String(error)) };
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
      return { error: redactRuntimeText(error instanceof Error ? error.message : String(error)) };
    }
  }

  pageOf(conversationId: string): Page | null {
    return this.sessions.get(conversationId)?.page ?? null;
  }

  sessionOf(conversationId: string): LadSession | null {
    return this.sessions.get(conversationId) ?? null;
  }

  setScreencastVisible(conversationId: string, visible: boolean): void {
    this.visibility.set(conversationId, visible);
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
      if (session.native)
        await fetch(
          `${process.env.LAD_LB_NATIVE_ENDPOINT}/close?conversation=${encodeURIComponent(conversationId)}`,
          { headers: { Authorization: `Bearer ${process.env.LAD_LB_TOKEN}` } }
        );
      else await session.context.close();
    } catch {
      /* already closed */
    }
    if (!opts.silent) {
      this.emitLadEvent({ type: 'session', conversationId, detail: 'closed' });
      this.emitMeta(conversationId);
    }
  }

  adopt(from: string, to: string): void {
    if (this.sessions.has(to)) throw new Error('Destination browser already exists');
    const session = this.sessions.get(from);
    if (!session) return;
    this.sessions.delete(from);
    if (this.visibility.has(from)) {
      this.visibility.set(to, this.visibility.get(from)!);
      this.visibility.delete(from);
    }
    session.conversationId = to;
    this.sessions.set(to, session);
    this.emitMeta(to);
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
