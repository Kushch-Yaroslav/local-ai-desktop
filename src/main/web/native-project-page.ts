import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, session, type WebContents, type Rectangle } from 'electron';
import { chromium, type Browser, type BrowserContext, type Page, type ConnectOverCDPTransport } from 'playwright-core';

/** In-process, one-target CDP transport. No TCP listener or application targets. */
class ViewTransport implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private attached = false;
  private closed = false;
  private readonly children = new Set<string>();
  constructor(private readonly contents: WebContents, private readonly target: Record<string, unknown>, private readonly disconnect: () => void) {
    contents.debugger.on('message', this.message);
    contents.debugger.once('detach', this.detached);
  }
  private message = (_event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => {
    if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string') this.children.add(params.sessionId);
    if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') this.children.delete(params.sessionId);
    this.onmessage?.({ method, params, sessionId: sessionId || 'native-page' });
  };
  private detached = () => this.close();
  send(message: object) {
    const command = message as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
    void this.command(command).then(result => this.onmessage?.({ id: command.id, sessionId: command.sessionId, result }), error => this.onmessage?.({ id: command.id, sessionId: command.sessionId, error: { message: String(error), code: -32000 } }));
  }
  private async command({ method, params = {}, sessionId }: { method: string; params?: Record<string, unknown>; sessionId?: string }): Promise<unknown> {
    if (this.closed) throw new Error('Native browser transport closed');
    if (!sessionId) {
      if (method === 'Browser.getVersion') return this.contents.debugger.sendCommand(method);
      if (method === 'Target.getTargetInfo') return { targetInfo: this.target };
      if (method === 'Target.setAutoAttach') {
        if (!this.attached && params.autoAttach) {
          this.attached = true;
          this.onmessage?.({ method: 'Target.attachedToTarget', params: { sessionId: 'native-page', targetInfo: this.target, waitingForDebugger: false } });
        }
        return {};
      }
      // Permissions/downloads are always denied independently by the Electron session.
      if (method === 'Browser.resetPermissions' || method === 'Browser.setDownloadBehavior' && params.behavior === 'deny') return {};
      throw new Error(`Browser-wide CDP operation unavailable: ${method}`);
    }
    if (sessionId !== 'native-page' && !this.children.has(sessionId)) throw new Error('CDP session outside native view');
    if (method.startsWith('Browser.') || method.startsWith('Target.') && !['Target.setAutoAttach', 'Target.detachFromTarget'].includes(method)) throw new Error(`CDP target escape blocked: ${method}`);
    return this.contents.debugger.sendCommand(method, params, sessionId === 'native-page' ? undefined : sessionId);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.disconnect();
    this.contents.debugger.removeListener('message', this.message);
    this.contents.debugger.removeListener('detach', this.detached);
    if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) this.contents.debugger.detach();
    this.onclose?.();
  }
}

export interface NativeProjectPage {
  page: Page; context: BrowserContext; browser: Browser; contents: WebContents;
  layout(bounds: Rectangle | undefined): void;
  ownership(value: string): void;
  releaseInput(): Promise<void>;
  close(): Promise<void>;
}

export async function createNativeProjectPage(owner: WebContents, origin: string, unavailable?: (reason: string) => void): Promise<NativeProjectPage> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) throw new Error('Native preview requires its owning application window');
  const isolated = session.fromPartition(`native-project-${randomUUID()}`, { cache: false });
  await isolated.setProxy({mode:'direct'});
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  const allowed = (raw: string) => { try { const url = new URL(raw); return url.origin === origin && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
  // This guard survives a lost Playwright/CDP connection. Routing never grants a network escape.
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.method !== 'GET' || !allowed(details.url) }));
  const view = new WebContentsView({ webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false, navigateOnDragDrop: false, spellcheck: false, backgroundThrottling: false } });
  const contents = view.webContents;
  let ownerState = 'agent', destroyed = false, visible = false;
  const pressed = new Map<string, { key:string; code:string }>();
  const buttons = new Map<string, { x:number; y:number; button:string }>();
  let release = Promise.resolve();
  const releaseInput = () => {
    const keys = [...pressed.values()]; pressed.clear();
    const pointer = [...buttons.values()]; buttons.clear();
    release = release.then(async () => {
      if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
      for (const key of keys) await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyUp', ...key }).catch(() => undefined);
      // Release outside the page so a held press is cancelled, not clicked by handover.
      for (const button of pointer) await contents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',...button,x:-1,y:-1,clickCount:0}).catch(() => undefined);
    });
    return release;
  };
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  contents.on('will-frame-navigate', event => { if (!event.isMainFrame || !allowed(event.url)) event.preventDefault(); });
  contents.on('before-input-event', (event, input) => {
    if (ownerState !== 'user') { event.preventDefault(); return; }
    if (input.type === 'keyDown') pressed.set(input.code, {key:input.key,code:input.code});
    else if (input.type === 'keyUp') pressed.delete(input.code);
  });
  contents.on('before-mouse-event', (_event, input) => {
    if (ownerState !== 'user' || !input.button) return;
    if (input.type === 'mouseDown') buttons.set(input.button, {x:input.x,y:input.y,button:input.button});
    else if (input.type === 'mouseUp') buttons.delete(input.button);
  });
  contents.setIgnoreMenuShortcuts(true);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  view.setVisible(false); window.contentView.addChildView(view);
  // Native hit-test shield: blocks physical pointer input without cancelling
  // Playwright's CDP mouse events or freezing the underlying compositor.
  const shieldSession = session.fromPartition(`native-shield-${randomUUID()}`, { cache: false });
  const shieldUrl = 'data:text/html,' + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><html style="background:transparent;height:100%;cursor:wait"><body style="margin:0;height:100%;background:transparent"></body></html>');
  shieldSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  shieldSession.setPermissionCheckHandler(() => false);
  shieldSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== shieldUrl }));
  const shield = new WebContentsView({ webPreferences: { session: shieldSession, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, navigateOnDragDrop: false } });
  shield.setBackgroundColor('#00000000'); shield.setVisible(false);
  shield.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  shield.webContents.on('will-navigate', event => event.preventDefault());
  window.contentView.addChildView(shield);
  let transport: ViewTransport | undefined;
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  const closeContents = (target: WebContents) => new Promise<void>(resolve => {
    if (target.isDestroyed()) { resolve(); return; }
    target.once('destroyed', () => resolve());
    target.close({ waitForBeforeUnload:false });
  });
  const close = (): Promise<void> => {
    if (closing) return closing;
    destroyed = true;
    // Publish the shared promise before CDP/page-close callbacks can reenter.
    closing = Promise.resolve().then(async () => {
      if (!window.isDestroyed()) { window.contentView.removeChildView(shield); window.contentView.removeChildView(view); }
      transport?.close();
      await Promise.all([closeContents(shield.webContents),closeContents(contents),browser?.close().catch(() => undefined)]);
      await isolated.closeAllConnections().catch(() => undefined);
      await isolated.clearStorageData().catch(() => undefined);
      await shieldSession.clearStorageData().catch(() => undefined);
    });
    return closing;
  };
  try {
    await shield.webContents.loadURL(shieldUrl);
    await contents.loadURL('about:blank');
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    const { targetInfo } = await contents.debugger.sendCommand('Target.getTargetInfo');
    transport = new ViewTransport(contents, { ...targetInfo, type: 'page', browserContextId: 'native-project', attached: true }, () => {
      isolated.webRequest.onBeforeRequest((_details, callback) => callback({cancel:true}));
      if (!destroyed) { unavailable?.('Native browser connection closed'); void close(); }
    });
    browser = await chromium.connectOverCDP(transport, { timeout: 15000, noDefaults: true });
    const context = browser.contexts()[0], page = context.pages()[0];
    if (!page || context.pages().length !== 1) throw new Error('Native preview must expose exactly one Page');
    return { browser, context, page, contents, close, releaseInput,
      ownership(value) { if (destroyed) return; if (value !== 'user') void releaseInput(); ownerState = value; contents.setBackgroundThrottling(!visible && value !== 'agent'); shield.setVisible(visible && value !== 'user'); if (value !== 'user' && !contents.isDestroyed() && contents.isFocused()) owner.focus(); },
      layout(bounds) {
        if (destroyed || window.isDestroyed()) return;
        if (!bounds) { void releaseInput(); contents.setBackgroundThrottling(ownerState !== 'agent'); visible = false; view.setVisible(false); shield.setVisible(false); return; }
        contents.setBackgroundThrottling(false);
        const zoom = owner.getZoomFactor();
        bounds = {x:bounds.x*zoom,y:bounds.y*zoom,width:bounds.width*zoom,height:bounds.height*zoom};
        const size = window.getContentBounds();
        const x = Math.max(0, Math.round(bounds.x)), y = Math.max(0, Math.round(bounds.y));
        const width = Math.max(0, Math.min(Math.round(bounds.width), size.width - x));
        const height = Math.max(0, Math.min(Math.round(bounds.height), size.height - y));
        if (width < 32 || height < 32) { visible = false; view.setVisible(false); shield.setVisible(false); return; }
        visible = true;
        view.setBounds({ x, y, width, height }); shield.setBounds({ x, y, width, height });
        view.setVisible(true); shield.setVisible(ownerState !== 'user');
      },
    };
  } catch (error) { await close(); throw error; }
}
