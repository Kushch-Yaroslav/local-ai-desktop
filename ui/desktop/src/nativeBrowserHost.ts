/** Local AI Desktop: isolated native surface and one-target authenticated CDP bridge. */
import {
  app,
  ipcMain,
  BrowserWindow,
  WebContentsView,
  View,
  session,
  screen,
  type WebContents,
  type Rectangle,
} from 'electron';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

type Settings = {
  viewport?: 'auto' | { width: number; height: number };
  zoom?: number;
  previewScale?: 'fit' | number;
  pan?: { x: number; y: number };
  mode?: 'interact' | 'pan' | 'select';
};
const bounded = (value: number | undefined, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value!)) : fallback;
function validSettings(value: Settings): Settings {
  const viewport =
    value.viewport && value.viewport !== 'auto'
      ? {
          width: Math.round(bounded(value.viewport.width, 240, 4096, 1440)),
          height: Math.round(bounded(value.viewport.height, 240, 4096, 900)),
        }
      : ('auto' as const);
  return {
    viewport,
    zoom: bounded(value.zoom, 0.25, 4, 1),
    previewScale:
      typeof value.previewScale === 'number' ? bounded(value.previewScale, 0.25, 2, 1) : 'fit',
    pan: { x: bounded(value.pan?.x, 0, 8192, 0), y: bounded(value.pan?.y, 0, 8192, 0) },
    mode: ['interact', 'pan', 'select'].includes(value.mode ?? '') ? value.mode : 'interact',
  };
}
interface Entry {
  owner: WebContents;
  container: View;
  view: WebContentsView;
  bounds?: Rectangle;
  settings: Settings;
  target: Record<string, unknown>;
  socket?: WebSocket;
  children: Set<string>;
  attached: boolean;
  scale: number;
  physicalViewport: { width: number; height: number };
  metricsKey?: string;
  metrics?: Promise<void>;
  closing: boolean;
  controlled?: boolean;
  userKeys: Map<string, { key: string; code: string }>;
  userButtons: Set<'left' | 'middle' | 'right'>;
  pointer: { x: number; y: number };
}
type Shield = { view: WebContentsView; entry?: Entry };
export class NativeBrowserHost {
  private server?: Server;
  private sockets = new WebSocketServer({ noServer: true });
  private owners = new Map<string, WebContents>();
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Entry>>();
  private preferences = new Map<string, { bounds?: Rectangle; settings: Settings }>();
  private shields = new Map<number, Shield>();
  private shieldPending = new Map<number, Promise<Shield>>();
  private token = '';
  private generation = 0;
  private pageFile = path.join(app.getPath('userData'), 'live-browser', 'native-pages.json');
  private urls: Record<string, string> = {};
  private partitions: Record<string, string> = {};
  private partitionFile = path.join(
    app.getPath('userData'),
    'live-browser',
    'native-partitions.json'
  );
  private revisions = new Map<string, { owner: WebContents; done: (value: unknown) => void }>();
  private async sourceRevision(id: string): Promise<unknown> {
    const owner = this.owners.get(id);
    if (!owner || owner.isDestroyed() || id.startsWith('hub-'))
      throw new Error('Choose a project in a saved chat before verification');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.revisions.delete(requestId);
        reject(new Error('Project revision request timed out'));
      }, 15000);
      this.revisions.set(requestId, {
        owner,
        done: (value) => {
          clearTimeout(timeout);
          this.revisions.delete(requestId);
          resolve(value);
        },
      });
      owner.send('live-browser:source-revision', { requestId, conversationId: id });
    });
  }
  constructor() {
    ipcMain.on(
      'live-browser:source-revision-result',
      (event, requestId: string, value: unknown) => {
        const pending = this.revisions.get(requestId);
        if (pending?.owner === event.sender) pending.done(value);
      }
    );
    try {
      this.urls = JSON.parse(fs.readFileSync(this.pageFile, 'utf8'));
      try {
        this.partitions = JSON.parse(fs.readFileSync(this.partitionFile, 'utf8'));
      } catch {
        /* First run. */
      }
    } catch {
      /* No saved pages yet. */
    }
  }
  private remember(id: string, url: string) {
    if (!/^https?:\/\//.test(url) || url.length > 8192) return;
    this.urls[id] = url;
    try {
      fs.mkdirSync(path.dirname(this.pageFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.pageFile + '.tmp', JSON.stringify(this.urls), { mode: 0o600 });
      fs.renameSync(this.pageFile + '.tmp', this.pageFile);
      fs.writeFileSync(this.partitionFile + '.tmp', JSON.stringify(this.partitions), {
        mode: 0o600,
      });
      fs.renameSync(this.partitionFile + '.tmp', this.partitionFile);
    } catch {
      /* Keep the live session even if preferences cannot be saved. */
    }
  }

  private async releaseInput(entry: Entry) {
    const keys = [...entry.userKeys.values()],
      buttons = [...entry.userButtons];
    entry.userKeys.clear();
    entry.userButtons.clear();
    if (entry.view.webContents.isDestroyed()) return;
    try {
      for (const key of keys)
        await entry.view.webContents.debugger
          .sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
          .catch(() => undefined);
      for (const button of buttons)
        await entry.view.webContents.debugger
          .sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button,
            buttons: 0,
            clickCount: 1,
            ...entry.pointer,
          })
          .catch(() => undefined);
    } catch {
      /* Renderer closed while releasing input. */
    }
  }
  private panBy(entry: Entry, dx: number, dy: number) {
    if (
      entry.controlled ||
      entry.settings.mode !== 'pan' ||
      !entry.bounds ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dy)
    )
      return;
    const factor = entry.scale * entry.view.webContents.getZoomFactor();
    entry.settings.pan = {
      x: Math.max(0, (entry.settings.pan?.x ?? 0) + Math.max(-2048, Math.min(2048, dx)) / factor),
      y: Math.max(0, (entry.settings.pan?.y ?? 0) + Math.max(-2048, Math.min(2048, dy)) / factor),
    };
    this.layout(entry);
    for (const [conversationId, value] of this.entries)
      if (value === entry && !entry.owner.isDestroyed())
        entry.owner.send('live-browser:pan', { conversationId, pan: entry.settings.pan });
  }
  private async ensureShield(owner: WebContents): Promise<Shield> {
    const existing = this.shields.get(owner.id);
    if (existing) return existing;
    const pending = this.shieldPending.get(owner.id);
    if (pending) return pending;
    const generation = this.generation;
    const creation = (async () => {
      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          session: session.fromPartition('lad-shield-' + owner.id),
        },
      });
      try {
        const shield: Shield = { view };
        view.setVisible(false);
        view.setBackgroundColor('#00000000');
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        view.webContents.debugger.on('message', (_event, method, params) => {
          if (
            method !== 'Runtime.bindingCalled' ||
            params.name !== '__ladPreviewPan' ||
            !shield.entry
          )
            return;
          try {
            const delta = JSON.parse(params.payload);
            this.panBy(shield.entry, Number(delta.dx), Number(delta.dy));
          } catch {
            /* Invalid pan delta. */
          }
        });
        const html = `<html style="background:transparent;height:100%"><body style="margin:0;height:100%;touch-action:none;user-select:none"><script>
        let previous;const pan=(dx,dy)=>window.__ladPreviewPan(JSON.stringify({dx,dy}));
        document.addEventListener('wheel',e=>{e.preventDefault();if(window.__ladPanEnabled)pan(e.deltaX,e.deltaY)},{passive:false});
        document.body.onpointerdown=e=>{e.preventDefault();if(!window.__ladPanEnabled)return;previous={x:e.clientX,y:e.clientY};document.body.setPointerCapture(e.pointerId)};
        document.body.onpointermove=e=>{if(!previous)return;pan(previous.x-e.clientX,previous.y-e.clientY);previous={x:e.clientX,y:e.clientY}};
        document.body.onpointerup=()=>{previous=undefined};document.body.onpointercancel=()=>{previous=undefined};
        document.onkeydown=e=>{if(!window.__ladPanEnabled)return;const keys={ArrowLeft:[-48,0],ArrowRight:[48,0],ArrowUp:[0,-48],ArrowDown:[0,48]};if(keys[e.key]){e.preventDefault();pan(...keys[e.key])}};
      </script></body></html>`;
        await view.webContents.loadURL('data:text/html,' + encodeURIComponent(html));
        view.webContents.debugger.attach('1.3');
        await view.webContents.debugger.sendCommand('Runtime.enable');
        await view.webContents.debugger.sendCommand('Runtime.addBinding', {
          name: '__ladPreviewPan',
        });

        view.webContents.on('will-navigate', (event) => event.preventDefault());
        const win = owner.isDestroyed() ? null : BrowserWindow.fromWebContents(owner);
        if (!win || owner.isDestroyed() || generation !== this.generation) {
          view.webContents.close({ waitForBeforeUnload: false });
          throw new Error('Browser owner closed');
        }
        win.contentView.addChildView(view);
        this.shields.set(owner.id, shield);
        return shield;
      } catch (error) {
        if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
        throw error;
      }
    })();
    this.shieldPending.set(owner.id, creation);
    try {
      return await creation;
    } finally {
      this.shieldPending.delete(owner.id);
    }
  }
  async test(owner: WebContents, id: string, method: string, params: Record<string, unknown>) {
    if (this.owners.get(id) !== owner) throw new Error('Wrong native browser owner');
    if (method === 'LAD.stats')
      return {
        pages: this.entries.size,
        pending: this.pending.size,
        shields: this.shields.size,
        revisionRequests: this.revisions.size,
        mainMemory: process.memoryUsage(),
      };
    const entry = await this.get(id);
    return method.startsWith('Input.')
      ? this.command(entry, { method, params, sessionId: 'native-page' })
      : entry.view.webContents.debugger.sendCommand(method, params);
  }
  async start(token: string): Promise<string> {
    this.token = token;
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address !== 'string') return `http://127.0.0.1:${address.port}`;
    }
    this.server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const id = url.searchParams.get('conversation') ?? '';
      try {
        if (url.pathname === '/session' && req.method === 'POST') {
          const entry = await this.get(id);
          await entry.metrics;
          res.setHeader('content-type', 'application/json');
          const address = this.server!.address() as { port: number };
          res.end(
            JSON.stringify({
              url: `ws://127.0.0.1:${address.port}/cdp?conversation=${encodeURIComponent(id)}&token=${this.token}`,
            })
          );
          return;
        }
        if (url.pathname === '/ownership') {
          const entry = await this.get(id);
          const controlled = url.searchParams.get('value') === 'agent';
          if (controlled && !entry.controlled) {
            await this.releaseInput(entry);
            await entry.view.webContents
              .executeJavaScript('window.__ladSelectionStop?.()')
              .catch(() => undefined);
          }
          entry.controlled = controlled;
          if (entry.controlled) await this.ensureShield(entry.owner);
          this.layout(entry);
          res.end('{}');
          return;
        }
        if (url.pathname === '/verification-viewport') {
          const entry = await this.get(id);
          const previous = globalThis.structuredClone(entry.settings);
          const restore = url.searchParams.get('restore');
          entry.settings = restore
            ? validSettings(JSON.parse(restore))
            : {
                ...entry.settings,
                zoom: 1,
                viewport: {
                  width: Number(url.searchParams.get('width')),
                  height: Number(url.searchParams.get('height')),
                },
              };
          entry.settings = validSettings(entry.settings);
          this.layout(entry);
          await entry.metrics;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(previous));
          return;
        }
        if (url.pathname === '/source-revision') {
          const result = await this.sourceRevision(id);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (url.pathname === '/metrics') {
          const entry = await this.get(id);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ zoom: entry.view.webContents.getZoomFactor() }));
          return;
        }
        if (url.pathname === '/capture') {
          const entry = await this.get(id);
          const z = entry.view.webContents.getZoomFactor() * entry.scale;
          const rect = JSON.parse(url.searchParams.get('rect') || 'null') as Rectangle | null;
          const image = await entry.view.webContents.capturePage(
            rect
              ? {
                  x: Math.round(rect.x * z),
                  y: Math.round(rect.y * z),
                  width: Math.max(1, Math.round(rect.width * z)),
                  height: Math.max(1, Math.round(rect.height * z)),
                }
              : undefined,
            { stayHidden: true, stayAwake: true }
          );
          const initial = image.getSize();
          if (image.isEmpty() || initial.width < 1 || initial.height < 1)
            throw new Error('Native capture unavailable; use DOM evidence or reopen the preview');
          const maxEdge = bounded(Number(url.searchParams.get('maxEdge')) || 1600, 128, 1600, 1600);
          const output =
            Math.max(initial.width, initial.height) > maxEdge
              ? image.resize({
                  width: Math.round(
                    (initial.width * maxEdge) / Math.max(initial.width, initial.height)
                  ),
                  height: Math.round(
                    (initial.height * maxEdge) / Math.max(initial.width, initial.height)
                  ),
                })
              : image;
          const size = output.getSize();
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              mime: 'image/jpeg',
              data: output.toJPEG(80).toString('base64'),
              ...size,
            })
          );
          return;
        }
        if (url.pathname === '/viewport') {
          const entry = await this.get(id);
          entry.settings = {
            ...entry.settings,
            viewport: {
              width: Number(url.searchParams.get('width')),
              height: Number(url.searchParams.get('height')),
            },
            zoom: Number(url.searchParams.get('zoom')) || 1,
          };
          entry.settings = validSettings(entry.settings);
          entry.owner.send('live-browser:workspace', {
            conversationId: id,
            viewport: entry.settings.viewport,
            zoom: entry.settings.zoom,
          });
          this.layout(entry);
          await entry.metrics;
          res.end('{}');
          return;
        }
        if (url.pathname === '/zoom') {
          const entry = await this.get(id);
          entry.settings.zoom = bounded(Number(url.searchParams.get('value')), 0.5, 2, 1);
          this.layout(entry);
          res.end('{}');
          return;
        }
        if (url.pathname === '/close') {
          await this.close(id);
          res.end('{}');
          return;
        }
        res.writeHead(404).end();
      } catch (error) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: String(error) }));
      }
    });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const entry = this.entries.get(url.searchParams.get('conversation') ?? '');
      if (
        url.pathname !== '/cdp' ||
        url.searchParams.get('token') !== this.token ||
        !entry ||
        entry.socket
      ) {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (ws) => {
        entry.socket = ws;
        ws.on('error', () => ws.close());
        ws.on('message', (raw) => {
          let command: {
            id: number;
            method: string;
            params?: Record<string, unknown>;
            sessionId?: string;
          };
          try {
            command = JSON.parse(String(raw));
          } catch {
            return;
          }
          void this.command(entry, command).then(
            (result) =>
              ws.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result })),
            (error) =>
              ws.send(
                JSON.stringify({
                  id: command.id,
                  sessionId: command.sessionId,
                  error: { code: -32000, message: String(error) },
                })
              )
          );
        });
        ws.on('close', () => {
          entry.socket = undefined;
          entry.attached = false;
          entry.children.clear();
          entry.metricsKey = undefined;
          // Runtime.enable on an already enabled debugger does not replay existing
          // execution contexts. Reset the debugger connection so a replacement
          // Playwright client can initialize against the surviving native Page.
          if (!entry.closing && !entry.view.webContents.isDestroyed()) {
            try {
              entry.view.webContents.debugger.detach();
              entry.view.webContents.debugger.attach('1.3');
              this.layout(entry);
            } catch {
              /* A crashed renderer will recreate its view. */
            }
          }
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  register(owner: WebContents, id: string) {
    if (!id || id.length > 256) throw new Error('Invalid browser conversation');
    const previous = this.owners.get(id);
    if (previous && previous !== owner && !previous.isDestroyed())
      throw new Error('Browser belongs to another window');
    if (![...this.owners.values()].includes(owner))
      owner.once('destroyed', () => {
        const shield = this.shields.get(owner.id);
        if (shield && !shield.view.webContents.isDestroyed())
          shield.view.webContents.close({ waitForBeforeUnload: false });
        this.shields.delete(owner.id);
        for (const [key, value] of this.owners)
          if (value === owner) {
            void this.close(key);
            this.owners.delete(key);
            this.preferences.delete(key);
          }
      });
    this.owners.set(id, owner);
  }
  adopt(owner: WebContents, from: string, to: string) {
    if (this.owners.get(from) !== owner) throw new Error('Browser owner mismatch');
    this.register(owner, to);
    const entry = this.entries.get(from);
    if (this.entries.has(to)) throw new Error('Destination browser already exists');
    const previousUrl = entry?.view.webContents.getURL() ?? this.urls[from];
    if (entry) {
      this.entries.delete(from);
      this.entries.set(to, entry);
    }
    if (this.partitions[from]) this.partitions[to] = this.partitions[from];
    delete this.partitions[from];
    delete this.urls[from];
    if (previousUrl) this.remember(to, previousUrl);
    const prefs = this.preferences.get(from);
    if (prefs) this.preferences.set(to, prefs);
    this.preferences.delete(from);
  }
  snapshot(owner: WebContents, id: string) {
    this.register(owner, id);
    return this.entries.get(id)?.settings ?? null;
  }
  configure(owner: WebContents, id: string, bounds: Rectangle | null, settings: Settings) {
    this.register(owner, id);
    if (
      bounds &&
      !['x', 'y', 'width', 'height'].every(
        (key) =>
          Number.isFinite(bounds[key as keyof Rectangle]) &&
          Math.abs(bounds[key as keyof Rectangle]) <= 16384
      )
    )
      throw new Error('Invalid browser bounds');
    const existing = this.entries.get(id);
    const value = {
      bounds: bounds ?? undefined,
      settings: !bounds && existing ? existing.settings : validSettings(settings),
    };
    this.preferences.set(id, value);
    const entry = this.entries.get(id);
    if (entry) {
      Object.assign(entry, value);
      this.layout(entry);
    }
  }
  private async get(id: string): Promise<Entry> {
    const existing = this.entries.get(id);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    const pending = this.pending.get(id);
    if (pending) return pending;
    const create = this.create(id);
    this.pending.set(id, create);
    try {
      return await create;
    } finally {
      this.pending.delete(id);
    }
  }
  private async create(id: string): Promise<Entry> {
    const generation = this.generation;
    const owner = this.owners.get(id);
    if (!owner || owner.isDestroyed())
      throw new Error('Browser conversation is not registered in its window');
    const win = owner.isDestroyed() ? null : BrowserWindow.fromWebContents(owner);
    if (!win) throw new Error('Browser window unavailable');
    const partition = this.partitions[id] ?? `persist:lad-native-${randomUUID()}`;
    this.partitions[id] = partition;
    const isolated = session.fromPartition(partition, { cache: false });
    isolated.setPermissionRequestHandler((_c, _p, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        allowed = ['http:', 'https:', 'ws:', 'wss:', 'blob:', 'data:', 'about:'].includes(
          url.protocol
        );
      } catch {
        /* Reject invalid schemes. */
      }
      callback({ cancel: !allowed });
    });
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    const container = new View();
    container.addChildView(view);
    win.contentView.addChildView(container);
    view.setVisible(false);
    await view.webContents.loadURL('about:blank');
    if (owner.isDestroyed() || generation !== this.generation) {
      if (!win.isDestroyed()) win.contentView.removeChildView(container);
      view.webContents.close({ waitForBeforeUnload: false });
      throw new Error('Browser owner closed during initialization');
    }
    view.webContents.debugger.attach('1.3');
    const { targetInfo } = await view.webContents.debugger.sendCommand('Target.getTargetInfo');
    const entry: Entry = {
      owner,
      container,
      view,
      target: { ...targetInfo, type: 'page', browserContextId: 'lad-native', attached: true },
      settings: {},
      children: new Set(),
      attached: false,
      scale: 1,
      physicalViewport: { width: 1280, height: 800 },
      closing: false,
      userKeys: new Map(),
      userButtons: new Set(),
      pointer: { x: 0, y: 0 },
      ...this.preferences.get(id),
    };
    this.entries.set(id, entry);
    const remember = () => {
      for (const [key, value] of this.entries)
        if (value === entry) this.remember(key, view.webContents.getURL());
    };
    view.webContents.on('did-navigate', remember);
    view.webContents.on('did-navigate-in-page', remember);
    let gesture: { point: { x: number; y: number }; pan: { x: number; y: number } } | undefined;
    view.webContents.on('before-input-event', (_event, input) => {
      if (entry.controlled) return;
      if (input.type === 'keyDown')
        entry.userKeys.set(input.code, { key: input.key, code: input.code });
      else if (input.type === 'keyUp') entry.userKeys.delete(input.code);
    });
    view.webContents.on('before-mouse-event', (event, input) => {
      if (entry.controlled) return;
      entry.pointer = { x: input.x, y: input.y };
      if (input.button) {
        if (input.type === 'mouseDown') entry.userButtons.add(input.button);
        else if (input.type === 'mouseUp') entry.userButtons.delete(input.button);
      }
      if (input.type === 'mouseWheel' && entry.settings.mode === 'pan') {
        event.preventDefault();
        return;
      }
      const start =
        input.type === 'mouseDown' && (input.button === 'middle' || entry.settings.mode === 'pan');
      if (start) {
        event.preventDefault();
        gesture = {
          point: screen.getCursorScreenPoint(),
          pan: entry.settings.pan ?? { x: 0, y: 0 },
        };
        return;
      }
      if (!gesture) return;
      event.preventDefault();
      if (input.type === 'mouseUp') {
        gesture = undefined;
        return;
      }
      if (input.type === 'mouseMove') {
        const point = screen.getCursorScreenPoint(),
          factor = entry.scale * view.webContents.getZoomFactor();
        const pan = {
          x: Math.max(0, gesture.pan.x - (point.x - gesture.point.x) / factor),
          y: Math.max(0, gesture.pan.y - (point.y - gesture.point.y) / factor),
        };
        entry.settings.pan = pan;
        this.layout(entry);
        for (const [conversationId, value] of this.entries)
          if (value === entry && !owner.isDestroyed())
            owner.send('live-browser:pan', { conversationId, pan: entry.settings.pan });
      }
    });
    view.webContents.on('blur', () => {
      if (!entry.controlled) void this.releaseInput(entry);
      gesture = undefined;
    });
    view.webContents.debugger.on('message', (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget') entry.children.add(params.sessionId);
      if (method === 'Target.detachedFromTarget') entry.children.delete(params.sessionId);
      if (entry.socket?.readyState === WebSocket.OPEN)
        entry.socket.send(
          JSON.stringify({ method, params, sessionId: sessionId || 'native-page' })
        );
    });
    view.webContents.once('render-process-gone', () => {
      entry.socket?.close();
      for (const [key, value] of this.entries) if (value === entry) void this.close(key);
    });
    this.layout(entry);
    await entry.metrics;
    if (this.urls[id]) void view.webContents.loadURL(this.urls[id]).catch(() => undefined);
    return entry;
  }
  private async command(
    entry: Entry,
    command: { method: string; params?: Record<string, unknown>; sessionId?: string }
  ): Promise<unknown> {
    const { method, sessionId } = command;
    let params = command.params ?? {};
    if (!sessionId) {
      if (method === 'Browser.getVersion')
        return entry.view.webContents.debugger.sendCommand(method);
      if (method === 'Target.getTargetInfo') return { targetInfo: entry.target };
      if (method === 'Target.setAutoAttach') {
        if (params.autoAttach && !entry.attached) {
          entry.attached = true;
          entry.socket?.send(
            JSON.stringify({
              method: 'Target.attachedToTarget',
              params: {
                sessionId: 'native-page',
                targetInfo: entry.target,
                waitingForDebugger: false,
              },
            })
          );
        }
        return {};
      }
      if (
        method === 'Browser.resetPermissions' ||
        (method === 'Browser.setDownloadBehavior' && params.behavior === 'deny')
      )
        return {};
      throw new Error('Browser-wide CDP operation denied');
    }
    if (sessionId !== 'native-page' && !entry.children.has(sessionId))
      throw new Error('CDP target outside browser session');
    if (
      method.startsWith('Browser.') ||
      (method.startsWith('Target.') &&
        !['Target.setAutoAttach', 'Target.detachFromTarget'].includes(method))
    )
      throw new Error('CDP target escape denied');
    if (
      method === 'Input.dispatchMouseEvent' &&
      typeof params.x === 'number' &&
      typeof params.y === 'number'
    )
      params = { ...params, x: params.x * entry.scale, y: params.y * entry.scale };
    return entry.view.webContents.debugger.sendCommand(
      method,
      params,
      sessionId === 'native-page' ? undefined : sessionId
    );
  }
  private layout(entry: Entry) {
    const { bounds, view, owner, settings } = entry;
    const win = owner.isDestroyed() ? null : BrowserWindow.fromWebContents(owner);
    if (!win || view.webContents.isDestroyed()) return;
    const visible = Boolean(bounds && bounds.width > 0 && bounds.height > 0);
    const factor = owner.getZoomFactor();
    const panel = bounds
      ? { width: Math.round(bounds.width * factor), height: Math.round(bounds.height * factor) }
      : entry.physicalViewport;
    const zoom = settings.zoom ?? view.webContents.getZoomFactor();
    if (Math.abs(view.webContents.getZoomFactor() - zoom) > 0.001)
      view.webContents.setZoomFactor(zoom);
    const requested =
      settings.viewport === 'auto' || !settings.viewport
        ? visible
          ? { width: Math.min(4096, panel.width), height: Math.min(4096, panel.height) }
          : entry.physicalViewport
        : settings.viewport;
    const scale = visible
      ? settings.previewScale === 'fit' || !settings.previewScale
        ? Math.min(panel.width / requested.width, panel.height / requested.height)
        : settings.previewScale
      : entry.scale;
    entry.scale = scale;
    entry.physicalViewport = requested;
    const pan = { x: settings.pan?.x ?? 0, y: settings.pan?.y ?? 0 };
    if (visible) {
      pan.x = Math.min(pan.x, Math.max(0, (requested.width - panel.width / scale) / zoom));
      pan.y = Math.min(pan.y, Math.max(0, (requested.height - panel.height / scale) / zoom));
    }
    entry.settings.pan = pan;
    if (visible && bounds)
      entry.container.setBounds({
        x: Math.round(bounds.x * factor),
        y: Math.round(bounds.y * factor),
        ...panel,
      });
    view.setBounds({
      x: Math.round(-pan.x * zoom * scale),
      y: Math.round(-pan.y * zoom * scale),
      width: Math.round(requested.width * scale),
      height: Math.round(requested.height * scale),
    });
    const deviceScaleFactor = screen.getDisplayMatching(win.getBounds()).scaleFactor;
    const key = JSON.stringify([requested.width, requested.height, deviceScaleFactor, scale, zoom]);
    if (entry.metricsKey !== key) {
      entry.metricsKey = key;
      entry.metrics = view.webContents.debugger
        .sendCommand('Emulation.setDeviceMetricsOverride', {
          width: requested.width,
          height: requested.height,
          deviceScaleFactor,
          mobile: false,
          scale,
        })
        .then(() => undefined)
        .catch(() => {
          entry.metricsKey = undefined;
        });
    }
    view.setVisible(visible);
    if (!visible) {
      if (!entry.controlled) void this.releaseInput(entry);
      const shield = this.shields.get(owner.id);
      if (shield?.entry === entry) shield.view.setVisible(false);
      return;
    }
    const useShield = Boolean(entry.controlled || settings.mode === 'pan');
    const shield = this.shields.get(owner.id);
    if (useShield && !shield) {
      void this.ensureShield(owner)
        .then(() => {
          if (!entry.closing) this.layout(entry);
        })
        .catch(() => undefined);
      return;
    }
    if (shield) {
      if (useShield) win.contentView.addChildView(shield.view);
      shield.entry = entry;
      shield.view.setBounds(entry.container.getBounds());
      shield.view.setVisible(useShield);
      void shield.view.webContents
        .executeJavaScript(
          `window.__ladPanEnabled=${!entry.controlled && settings.mode === 'pan'};document.body.style.cursor='${entry.controlled ? 'wait' : 'grab'}'`
        )
        .catch(() => undefined);
      if (entry.controlled && view.webContents.isFocused()) owner.focus();
    }
  }

  async close(id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.closing) return;
    entry.closing = true;
    const shield = this.shields.get(entry.owner.id);
    if (shield?.entry === entry) {
      shield.view.setVisible(false);
      shield.entry = undefined;
    }
    this.entries.delete(id);
    entry.socket?.close();
    const win = entry.owner.isDestroyed() ? null : BrowserWindow.fromWebContents(entry.owner);
    if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.container);
    if (!entry.view.webContents.isDestroyed())
      entry.view.webContents.close({ waitForBeforeUnload: false });
  }
  stop() {
    this.generation++;
    for (const id of this.entries.keys()) void this.close(id);
    for (const shield of this.shields.values())
      if (!shield.view.webContents.isDestroyed())
        shield.view.webContents.close({ waitForBeforeUnload: false });
    this.shields.clear();
    this.server?.close();
    this.server = undefined;
  }
}
