import {t} from '../../shared/locale';
import {cssToPresentation} from '../../shared/browser-coordinates';
import {defaultBrowserWorkspace,type BrowserWorkspaceSettings,type BrowserWorkspaceState} from '../../shared/live-browser';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, View, screen, session, type WebContents, type Rectangle } from 'electron';
import { chromium, type Browser, type BrowserContext, type Page, type ConnectOverCDPTransport } from 'playwright-core';

/** In-process, one-target CDP transport. No TCP listener or application targets. */
class ViewTransport implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private attached = false;
  private closed = false;
  private readonly children = new Set<string>();
  constructor(private readonly contents: WebContents, private readonly target: Record<string, unknown>, private readonly disconnect: () => void, private readonly inputScale:()=>number=()=>1) {
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
    // CDP input scales with Emulation image scale, but already accounts for browser zoom.
    // Pan lives in the parent View, so it must NOT be subtracted from agent CSS coordinates.
    if(method==='Input.dispatchMouseEvent'&&typeof params.x==='number'&&typeof params.y==='number'){const p=cssToPresentation({x:params.x,y:params.y},this.inputScale());params={...params,...p};}
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
  handleRequests(handler: (url: string, method: string, signal: AbortSignal) => Promise<{ status: number; headers: Record<string,string>; body: Buffer }>): void;
  layout(bounds: Rectangle | undefined): void;
  workspace(settings:BrowserWorkspaceSettings):Promise<void>;
  revealCss?(rect:{x:number;y:number;width:number;height:number}):Promise<void>;
  onWorkspace?(callback:(state:BrowserWorkspaceState)=>void):void;
  workspaceState?():BrowserWorkspaceState|undefined;
  captureCss?(rect:{x:number;y:number;width:number;height:number},dpr:number):Promise<Buffer>;
  ownership(value: string): void;
  releaseInput(): Promise<void>;
  highlight?(rects: Array<{x:number;y:number;width:number;height:number;color:string;label:string;id?:string;selected?:boolean}>): void;
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
  let requestHandler: Parameters<NativeProjectPage['handleRequests']>[0] | undefined;
  const networkAbort = new AbortController();
  // Serving intercepted external scripts with CDP Fetch crashes this Electron
  // renderer. Keep delivery in its isolated session, and CDP for automation only.
  const protocols = new Set<string>();
  const handleRequest: Parameters<typeof isolated.protocol.handle>[1] = async request => {
    if (destroyed || !requestHandler || request.method !== 'GET' || !allowed(request.url)) return Response.error();
    try {
      const response = await requestHandler(request.url, request.method, AbortSignal.any([request.signal,networkAbort.signal]));
      if (destroyed) return Response.error();
      return new Response([204,205,304].includes(response.status) ? null : new Uint8Array(response.body), {status:response.status,headers:response.headers});
    } catch { return Response.error(); }
  };
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
  const container=new View();container.setBounds({x:0,y:0,width:800,height:600});container.addChildView(view);
  view.setVisible(false); window.contentView.addChildView(container);
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
    isolated.webRequest.onBeforeRequest((_details, callback) => callback({cancel:true}));
    networkAbort.abort(); requestHandler = undefined;
    // Publish the shared promise before CDP/page-close callbacks can reenter.
    closing = Promise.resolve().then(async () => {
      if (!window.isDestroyed()) { window.contentView.removeChildView(shield); container.removeChildView(view); window.contentView.removeChildView(container); }
      transport?.close();
      await Promise.all([closeContents(shield.webContents),closeContents(contents),browser?.close().catch(() => undefined)]);
      for (const scheme of protocols) isolated.protocol.unhandle(scheme); protocols.clear();
      await isolated.closeAllConnections().catch(() => undefined);
      await isolated.clearStorageData().catch(() => undefined);
      await shieldSession.clearStorageData().catch(() => undefined);
    });
    return closing;
  };
  try {
    for (const scheme of ['http','https']) { isolated.protocol.handle(scheme,handleRequest); protocols.add(scheme); }
    await shield.webContents.loadURL(shieldUrl);
    await contents.loadURL('about:blank');
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    const { targetInfo } = await contents.debugger.sendCommand('Target.getTargetInfo');
    let settings:BrowserWorkspaceSettings=structuredClone(defaultBrowserWorkspace),actual:BrowserWorkspaceState|undefined;
    let changed:((state:BrowserWorkspaceState)=>void)|undefined;
    let bounds:Rectangle|undefined,applied='',serial=Promise.resolve();
    transport = new ViewTransport(contents, { ...targetInfo, type: 'page', browserContextId: 'native-project', attached: true }, () => {
      isolated.webRequest.onBeforeRequest((_details, callback) => callback({cancel:true}));
      if (!destroyed) { unavailable?.('Native browser connection closed'); void close(); }
    },()=>actual?.displayScale??1);
    browser = await chromium.connectOverCDP(transport, { timeout: 15000, noDefaults: true });
    const context = browser.contexts()[0], page = context.pages()[0];
    if (!page || context.pages().length !== 1) throw new Error('Native preview must expose exactly one Page');
    let highlighted:Array<{x:number;y:number;width:number;height:number;color:string;label:string;id?:string;selected?:boolean}>=[],highlightKey='';
    const highlight=(rects:Array<{x:number;y:number;width:number;height:number;color:string;label:string;id?:string;selected?:boolean}>)=>{
      highlighted=rects;if(destroyed||contents.isDestroyed()||shield.webContents.isDestroyed())return;
      const zoom=contents.getZoomFactor()*(actual?.displayScale??1),pan=actual?.settings.pan??{x:0,y:0};
      const key=JSON.stringify([rects,zoom,pan]);if(key===highlightKey)return;highlightKey=key;
      const paint=(boxes:typeof rects)=>{document.body.replaceChildren();for(const b of boxes){const node=document.createElement('div');if(b.id)node.dataset.regionId=b.id;node.style.cssText=`position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;border:${b.selected?5:3}px solid ${b.color};box-shadow:0 0 0 2px #fff,0 0 0 3px #111;box-sizing:border-box;background:${b.color}22;color:white;font:12px sans-serif;`;const text=document.createElement('span');text.style.background='#111';text.textContent=b.label;node.append(text);document.body.append(node);}};
      void shield.webContents.executeJavaScript(`(${paint.toString()})(${JSON.stringify(rects.map(b=>({...b,...cssToPresentation(b,zoom,pan),width:b.width*zoom,height:b.height*zoom})))})`).catch(()=>undefined);

    };
    const apply=async()=>{
      if(destroyed||window.isDestroyed()||!bounds)return;
      const zoom=contents.getZoomFactor(),ownerZoom=owner.getZoomFactor(),size=window.getContentBounds();
      const x=Math.max(0,Math.round(bounds.x*ownerZoom)),y=Math.max(0,Math.round(bounds.y*ownerZoom));
      const panel={width:Math.max(0,Math.min(Math.round(bounds.width*ownerZoom),size.width-x)),height:Math.max(0,Math.min(Math.round(bounds.height*ownerZoom),size.height-y))};
      const drawable=panel.width>=32&&panel.height>=32;
      const viewport=settings.viewport==='auto'?{width:Math.max(1,Math.round(panel.width/zoom)),height:Math.max(1,Math.round(panel.height/zoom))}:settings.viewport;
      const scale=settings.scale==='fit'?Math.max(.001,Math.min(panel.width/(viewport.width*zoom),panel.height/(viewport.height*zoom))):settings.scale;
      const surface={width:Math.ceil(viewport.width*zoom*scale),height:Math.ceil(viewport.height*zoom*scale)};
      const pan={x:Math.min(settings.pan.x,Math.max(0,(surface.width-panel.width)/(zoom*scale))),y:Math.min(settings.pan.y,Math.max(0,(surface.height-panel.height)/(zoom*scale)))};
      const dpr=screen.getDisplayMatching(window.getBounds()).scaleFactor;
      const next:BrowserWorkspaceState={settings:{...settings,pan},viewport,panel,surface,displayScale:scale,browserZoom:zoom,deviceScaleFactor:dpr,...(!drawable?{error:t('Недостаточно места для браузера: сверните панель настроек.')}:{})};
      const key=JSON.stringify([viewport,scale,zoom,dpr,settings.viewport==='auto']);
      if(key!==applied){
        if(settings.viewport==='auto'&&settings.scale==='fit')await contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
        else await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:Math.round(viewport.width*zoom),height:Math.round(viewport.height*zoom),deviceScaleFactor:dpr,mobile:false,scale});
        applied=key;
      }
      if(destroyed||!bounds)return;
      container.setBounds({x,y,...panel});
      const offset=cssToPresentation({x:0,y:0},zoom*scale,pan);
      view.setBounds({x:Math.round(offset.x),y:Math.round(offset.y),...surface});
      shield.setBounds({x,y,...panel});
      settings=next.settings;actual=next;visible=drawable;contents.setBackgroundThrottling(!drawable&&ownerState!=='agent');view.setVisible(drawable);shield.setVisible(drawable&&ownerState!=='user');
      highlight(highlighted);changed?.(next);
    };
    let queued=false;
    const schedule=()=>{if(queued)return serial;queued=true;serial=serial.catch(()=>undefined).then(async()=>{queued=false;await apply();}).catch(error=>{if(actual)changed?.({...actual,error:String(error)});});return serial;};
    contents.on('zoom-changed',()=>{void schedule();});
    return { browser, context, page, contents, close, releaseInput, highlight,
      workspaceState:()=>actual,
      async revealCss(rect){if(!actual||settings.scale==='fit')return;const factor=actual.displayScale*actual.browserZoom;
        const pan={...actual.settings.pan},width=actual.panel.width/factor,height=actual.panel.height/factor;
        if(rect.x<pan.x||rect.x+rect.width>pan.x+width)pan.x=Math.max(0,rect.x+rect.width/2-width/2);
        if(rect.y<pan.y||rect.y+rect.height>pan.y+height)pan.y=Math.max(0,rect.y+rect.height/2-height/2);
        settings={...settings,pan};await schedule();
      },
      async captureCss(rect){
        // Copy the live compositor surface. CDP captureScreenshot temporarily changes
        // its capture viewport and visibly blanks this attached WebContentsView.
        const scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
        const scale=contents.getZoomFactor()*(actual?.displayScale??1),x=(rect.x-scroll.x)*scale,y=(rect.y-scroll.y)*scale;
        if(x<0||y<0)throw new Error('Crop moved outside the visible viewport');
        const image=await contents.capturePage({x:Math.floor(x),y:Math.floor(y),width:Math.max(1,Math.ceil(rect.width*scale)),height:Math.max(1,Math.ceil(rect.height*scale))});
        if(image.isEmpty())throw new Error('Native compositor crop unavailable');return image.toPNG();
      },
      onWorkspace(callback){changed=callback;if(actual)callback(actual);},
      async workspace(value){settings=structuredClone(value);await schedule();},
      handleRequests(handler) { if (destroyed) throw new Error('Native browser closed'); requestHandler = handler; },
      ownership(value) { if (destroyed) return; if (value !== 'user') void releaseInput(); ownerState = value; contents.setBackgroundThrottling(!visible && value !== 'agent'); shield.setVisible(visible && value !== 'user'); if (value !== 'user' && !contents.isDestroyed() && contents.isFocused()) owner.focus(); },
      layout(value) {
        bounds=value;
        if (destroyed || window.isDestroyed()) return;
        if (!value) { void releaseInput(); contents.setBackgroundThrottling(ownerState !== 'agent'); visible=false;view.setVisible(false);shield.setVisible(false);return; }
        void schedule();
      },
    };
  } catch (error) { await close(); throw error; }
}
