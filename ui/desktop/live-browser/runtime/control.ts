import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { BrowserManager } from './browser';
import type { RegionService } from './regions';
import type { ScreencastHub } from './screencast';
import { handleMcpRequest } from './mcp';
import { validateRect } from './security';
import { log, redactRuntimeText } from './util';
import type {
  LadCaptureResponse,
  LadCreateAreaRequest,
  LadGroundRequest,
  LadReadRequest,
  LadUpdateAreaRequest,
  LadWsMessage,
} from '../shared/api';
import type { LadRectBody } from '../shared/api';

export interface LadControlDeps {
  manager: BrowserManager;
  regions: RegionService;
  screencast: ScreencastHub;
  token: string;
  activeConversation: () => string | null;
  setActiveConversation: (id: string) => void;
  /** Region/area mutation events (emitted by RegionService). */
  events: EventEmitter;
}

const MAX_BODY = 2 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

/**
 * Loopback control plane for the Electron renderer + MCP endpoint for Goose.
 * All endpoints require the bearer token (except /health).
 *
 * Frame stream: Server-Sent Events at /control/events (auto-reconnects in the
 * renderer). This replaces the original IPC frame pipeline with the same
 * semantics: frames, meta, state, actions, errors.
 */
export class LadControlServer {
  private server: Server | null = null;
  private sseClients = new Map<string, Set<ServerResponse>>();

  constructor(private readonly deps: LadControlDeps) {
    const { manager } = deps;
    const { events } = deps;

    // Bridge runtime events → SSE clients. (Frames come via the screencast
    // hub subscription in /control/events.)
    manager.on('lad', (event) => {
      const message: LadWsMessage | null =
        event.type === 'action'
          ? {
              t: 'action',
              source: event.source,
              tool: event.tool,
              summary: event.summary,
              at: new Date().toISOString(),
            }
          : event.type === 'error'
            ? { t: 'error', code: event.code, message: event.message }
            : event.type === 'meta'
              ? (() => {
                  const meta = manager.meta(event.conversationId);
                  return meta ? ({ t: 'meta', meta } as LadWsMessage) : null;
                })()
              : null;
      if (!message) return;
      for (const client of this.sseClients.get(event.conversationId) ?? []) {
        this.writeSse(client, message);
      }
    });

    events.on('state', (event: { conversationId: string }) => {
      void this.pushState(event.conversationId);
    });
    events.on('region-selected', (event: { conversationId: string; regionId: string }) => {
      for (const client of this.sseClients.get(event.conversationId) ?? [])
        this.writeSse(client, { t: 'region-selected', regionId: event.regionId });
    });
  }

  private clientsFor(conversationId: string): Set<ServerResponse> {
    let set = this.sseClients.get(conversationId);
    if (!set) {
      set = new Set();
      this.sseClients.set(conversationId, set);
    }
    return set;
  }

  private writeSse(res: ServerResponse, message: LadWsMessage): void {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  private async pushState(conversationId: string): Promise<void> {
    if (!this.sseClients.get(conversationId)?.size) return;
    const state = await this.deps.regions.list(conversationId).catch(() => null);
    if (!state) return;
    const message: LadWsMessage = {
      t: 'state',
      areas: state.areas,
      regions: state.regions,
      workspace: state.workspace,
    };
    for (const client of this.sseClients.get(conversationId) ?? []) this.writeSse(client, message);
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (header === `Bearer ${this.deps.token}`) return true;
    if (req.url?.startsWith('/mcp')) {
      // MCP headers come from Goose; also accept x-lad-token.
      return req.headers['x-lad-token'] === this.deps.token;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    return url.searchParams.get('token') === this.deps.token;
  }

  async listen(port: number): Promise<{ port: number }> {
    this.server = createServer(async (req, res) => {
      // The renderer (Vite dev origin or file:// in production) is cross-origin
      // relative to this loopback server. CORS is required for the Authorization
      // header; OPTIONS preflight is answered here. The server is 127.0.0.1-only
      // and token-authenticated, so a wildcard origin is safe.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-lad-token');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      if ((req.method ?? '') === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      try {
        await this.route(req, res);
      } catch (error) {
        log('control request error:', error instanceof Error ? error.stack : error);
        if (!res.headersSent)
          json(res, 500, {
            ok: false,
            error: redactRuntimeText(error instanceof Error ? error.message : String(error)),
          });
        else res.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once('error', onError);
      this.server!.listen(port, '127.0.0.1', () => {
        this.server!.removeListener('error', onError);
        resolve();
      });
    });
    const address = this.server!.address();
    const bound = typeof address === 'object' && address ? address.port : port;
    log(`control server on http://127.0.0.1:${bound}`);
    return { port: bound };
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/health') {
      json(res, 200, {
        ok: true,
        service: 'local-ai-live-browser',
        version: '0.4.0',
        sessions: this.deps.manager.sessionIds,
        active: this.deps.activeConversation(),
      });
      return;
    }

    if (path === '/mcp') {
      if (method !== 'POST') {
        // Stateful MCP clients may open the SSE stream; in stateless mode we
        // answer 405 as the transport expects.
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
        return;
      }
      if (!this.authorized(req)) {
        json(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const raw = await readBody(req);
      (req as IncomingMessage & { body?: unknown }).body = raw ? JSON.parse(raw) : undefined;
      await handleMcpRequest(
        {
          manager: this.deps.manager,
          regions: this.deps.regions,
          activeConversation: this.deps.activeConversation,
        },
        req as IncomingMessage & { body?: unknown },
        res
      );
      return;
    }

    if (!path.startsWith('/control/')) {
      json(res, 404, { ok: false, error: 'not-found' });
      return;
    }
    if (!this.authorized(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    const conversationParam = url.searchParams.get('conversation') ?? undefined;

    switch (path) {
      case '/control/adopt': {
        const body = JSON.parse(await readBody(req)) as { from: string; to: string };
        await this.deps.regions.adopt(body.from, body.to);
        this.deps.manager.adopt(body.from, body.to);
        json(res, 200, { ok: true });
        return;
      }
      case '/control/events': {
        if (method !== 'GET') {
          json(res, 405, { ok: false, error: 'use-get' });
          return;
        }
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        // Reattach the surviving native Page before announcing a connected preview.
        await this.deps.manager.get(conversationId);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        res.write(`: connected ${conversationId}\n\n`);
        const clients = this.clientsFor(conversationId);
        clients.add(res);
        // Screencast frames: the hub starts/stops production with clients.
        const unsubscribeFrames = this.deps.screencast.subscribe(conversationId, (frame) => {
          this.writeSse(res, {
            t: 'frame',
            data: frame.data,
            width: frame.width,
            height: frame.height,
            ts: frame.ts,
          });
        });
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(`: ping\n`);
        }, 15_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(res);
          if (!clients.size && this.sseClients.get(conversationId) === clients)
            this.sseClients.delete(conversationId);
          unsubscribeFrames();
        });
        // Immediate initial payload: last frame + state.
        const last = this.deps.screencast.lastFrame(conversationId);
        if (last)
          this.writeSse(res, {
            t: 'frame',
            data: last.data,
            width: last.width,
            height: last.height,
            ts: last.ts,
          });
        const meta = this.deps.manager.meta(conversationId);
        if (meta) this.writeSse(res, { t: 'meta', meta });
        await this.pushState(conversationId);
        return;
      }

      case '/control/evidence': {
        const conversationId = conversationParam || '';
        const evidence = await this.deps.regions.evidence(
          conversationId,
          url.searchParams.get('id') ?? ''
        );
        json(res, 200, { ok: true, evidence });
        return;
      }
      case '/control/state': {
        const conversationId = conversationParam || this.deps.activeConversation();
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        const state = await this.deps.regions.list(conversationId);
        json(res, 200, {
          ok: true,
          meta: this.deps.manager.meta(conversationId),
          areas: state.areas,
          regions: state.regions,
          workspace: state.workspace,
        });
        return;
      }

      case '/control/active': {
        const body = JSON.parse((await readBody(req)) || '{}') as { conversationId?: string };
        if (!body.conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversationId' });
          return;
        }
        this.deps.setActiveConversation(body.conversationId);
        json(res, 200, { ok: true, active: body.conversationId });
        return;
      }

      case '/control/ground': {
        const body = JSON.parse((await readBody(req)) || '{}') as LadGroundRequest;
        const conversationId =
          body.conversationId || conversationParam || this.deps.activeConversation() || '';
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        const rect = validateRect(body.rect ?? ({} as LadRectBody));
        if (!rect.ok) {
          json(res, 400, { ok: false, error: rect.reason });
          return;
        }
        const { region, area } = await this.deps.regions.createRegion(conversationId, rect.rect, {
          areaId: body.areaId,
          note: body.note,
        });
        json(res, 200, { ok: true, region, area });
        return;
      }

      case '/control/area': {
        if (method !== 'POST') {
          json(res, 405, { ok: false, error: 'use-post' });
          return;
        }
        const body = JSON.parse((await readBody(req)) || '{}') as LadCreateAreaRequest;
        const conversationId =
          body.conversationId || conversationParam || this.deps.activeConversation() || '';
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        if (!body.name?.trim()) {
          json(res, 400, { ok: false, error: 'missing-name' });
          return;
        }
        const area = await this.deps.regions.createArea(conversationId, {
          name: body.name,
          description: body.description,
          status: body.status,
        });
        json(res, 200, { ok: true, area });
        return;
      }

      case '/control/area/update': {
        const body = JSON.parse((await readBody(req)) || '{}') as LadUpdateAreaRequest;
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        const area = await this.deps.regions.updateArea(conversationId, body.areaId, {
          name: body.name,
          description: body.description,
          status: body.status,
          statusSource: body.statusSource,
          origin: body.origin,
        });
        json(res, 200, { ok: true, area });
        return;
      }

      case '/control/area/remove': {
        const body = JSON.parse((await readBody(req)) || '{}') as { areaId?: string };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        await this.deps.regions.removeArea(conversationId, body.areaId ?? '');
        json(res, 200, { ok: true });
        return;
      }

      case '/control/area/remove-all': {
        if (method !== 'POST') {
          json(res, 405, { ok: false, error: 'use-post' });
          return;
        }
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        const removed = await this.deps.regions.removeAllAreas(conversationId);
        json(res, 200, { ok: true, ...removed });
        return;
      }

      case '/control/region/remove': {
        const body = JSON.parse((await readBody(req)) || '{}') as { regionId?: string };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        await this.deps.regions.removeRegion(conversationId, body.regionId ?? '');
        json(res, 200, { ok: true });
        return;
      }

      case '/control/region/attach': {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          regionId?: string;
          areaId?: string;
        };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        const { region, area } = await this.deps.regions.attachRegionToArea(
          conversationId,
          body.regionId ?? '',
          body.areaId ?? ''
        );
        json(res, 200, { ok: true, region, area });
        return;
      }

      case '/control/workspace': {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          workspace?: Record<string, unknown>;
        };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        const workspace = await this.deps.regions.setWorkspace(
          conversationId,
          body.workspace ?? {}
        );
        void this.deps.regions.setViewportForWorkspace(conversationId, workspace);
        json(res, 200, { ok: true, workspace });
        return;
      }

      case '/control/display': {
        if (method !== 'POST') {
          json(res, 405, { ok: false, error: 'use-post' });
          return;
        }
        const body = JSON.parse((await readBody(req)) || '{}') as {
          visible?: boolean;
          selectedAreaId?: string | null;
          hoveredAreaId?: string | null;
          staleLabel?: string;
          areaPrefix?: string;
        };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        if (body.staleLabel && body.staleLabel.length > 120) {
          json(res, 400, { ok: false, error: 'invalid-stale-label' });
          return;
        }
        if (body.areaPrefix && body.areaPrefix.length > 40) {
          json(res, 400, { ok: false, error: 'invalid-area-prefix' });
          return;
        }
        await this.deps.regions.display(conversationId, body);
        json(res, 200, { ok: true });
        return;
      }

      case '/control/ownership': {
        const body = JSON.parse((await readBody(req)) || '{}') as { ownership?: 'user' | 'agent' };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        await this.deps.manager.setOwnership(conversationId, body.ownership ?? 'user');
        json(res, 200, { ok: true });
        return;
      }

      case '/control/viewport': {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          width?: number;
          height?: number;
          zoom?: number;
        };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        if (!body.width || !body.height) {
          json(res, 400, { ok: false, error: 'missing-size' });
          return;
        }
        const result = await this.deps.manager.setViewport(
          conversationId,
          { width: body.width, height: body.height },
          body.zoom ?? 1,
          'user'
        );
        if (!result.ok) json(res, 500, { ok: false, error: result.error });
        else json(res, 200, { ok: true });
        return;
      }

      case '/control/visibility': {
        const body = JSON.parse((await readBody(req)) || '{}') as { visible?: boolean };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        this.deps.manager.setScreencastVisible(conversationId, Boolean(body.visible));
        await this.deps.screencast.setVisible(conversationId, Boolean(body.visible));
        json(res, 200, { ok: true });
        return;
      }

      case '/control/navigate': {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          action?: 'open' | 'back' | 'forward' | 'reload';
          url?: string;
        };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        if (!conversationId) {
          json(res, 400, { ok: false, error: 'missing-conversation' });
          return;
        }
        const manager = this.deps.manager;
        let result: { ok: boolean; summary: string; error?: string };
        switch (body.action) {
          case 'open':
            result = await manager.navigate(conversationId, body.url ?? '', 'user');
            break;
          case 'back':
            result = await manager.back(conversationId, 'user');
            break;
          case 'forward':
            result = await manager.forward(conversationId, 'user');
            break;
          default:
            result = await manager.reload(conversationId, 'user');
        }
        if (!result.ok) json(res, 500, { ok: false, error: result.error });
        else json(res, 200, { ok: true, summary: result.summary });
        return;
      }

      case '/control/act': {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          action?: string;
          selector?: string;
          value?: string;
          areaName?: string;
          x?: number;
          y?: number;
        };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        const page = conversationId ? this.deps.manager.pageOf(conversationId) : null;
        if (!page) {
          if (body.action === 'selection' && body.value === 'off') {
            json(res, 200, { ok: true });
            return;
          }
          json(res, 400, { ok: false, error: 'no-page' });
          return;
        }
        try {
          if (body.action === 'recheck') {
            const record = await this.deps.regions.recheck(conversationId, body.value ?? '');
            json(res, 200, { ok: true, record });
          } else if (body.action === 'workflow') {
            const [areaId, workflow] = (body.value ?? '').split(':');
            await this.deps.regions.workflow(conversationId, areaId, workflow);
            json(res, 200, { ok: true });
          } else if (body.action === 'navigate-region') {
            const region = await this.deps.regions.getRegion(conversationId, body.value ?? '');
            if (!region) throw new Error('Region unavailable');
            const result = await this.deps.manager.navigate(conversationId, region.url, 'user');
            if (!result.ok) throw new Error(result.error);
            json(res, 200, { ok: true });
          } else if (body.action === 'detect') {
            const result = await this.deps.regions.detect(conversationId, {
              areaNamePrefix: body.areaName?.slice(0, 120),
            });
            json(res, 200, { ok: true, ...result });
          } else if (body.action === 'reveal') {
            await this.deps.regions.reveal(conversationId, body.value ?? '');
            json(res, 200, { ok: true });
          } else if (body.action === 'selection') {
            await this.deps.regions.setSelection(conversationId, body.value ?? 'off', {
              areaName: body.areaName?.slice(0, 200),
            });
            json(res, 200, { ok: true });
          } else if (body.action === 'click' && body.selector) {
            await page.click(body.selector, { timeout: 10_000 });
            json(res, 200, { ok: true, summary: `clicked ${body.selector}` });
          } else if (body.action === 'fill' && body.selector) {
            await page.fill(body.selector, body.value ?? '', { timeout: 10_000 });
            json(res, 200, { ok: true, summary: `filled ${body.selector}` });
          } else if (
            body.action === 'scroll' &&
            typeof body.x === 'number' &&
            typeof body.y === 'number'
          ) {
            await page.evaluate(([sx, sy]) => window.scrollTo(sx, sy), [body.x!, body.y!]);
            json(res, 200, { ok: true, summary: `scrolled to ${body.x},${body.y}` });
          } else {
            json(res, 400, { ok: false, error: 'unknown-action' });
          }
        } catch (error) {
          json(res, 500, {
            ok: false,
            error: redactRuntimeText(error instanceof Error ? error.message : String(error)),
          });
        }
        return;
      }

      case '/control/capture': {
        const body =
          method === 'POST'
            ? (JSON.parse((await readBody(req)) || '{}') as {
                rect?: LadRectBody;
                maxEdge?: number;
              })
            : {
                rect: {
                  x: Number(url.searchParams.get('x') ?? 0),
                  y: Number(url.searchParams.get('y') ?? 0),
                  width: Number(url.searchParams.get('width') ?? 0),
                  height: Number(url.searchParams.get('height') ?? 0),
                },
                maxEdge: Number(url.searchParams.get('maxEdge') ?? 1280) || undefined,
              };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        const rect = validateRect(body.rect ?? ({} as LadRectBody));
        if (!rect.ok) {
          json(res, 400, { ok: false, error: rect.reason });
          return;
        }
        const result = await this.deps.manager.captureCrop(conversationId, rect.rect, {
          maxEdge: body.maxEdge ?? 1280,
          quality: 80,
        });
        if ('error' in result) json(res, 500, { ok: false, error: result.error });
        else
          json(res, 200, {
            ok: true,
            mime: result.mime,
            data: result.data,
            width: result.width,
            height: result.height,
          } satisfies LadCaptureResponse);
        return;
      }

      case '/control/read': {
        const body =
          method === 'POST'
            ? (JSON.parse((await readBody(req)) || '{}') as LadReadRequest)
            : {
                maxChars: Number(url.searchParams.get('maxChars') ?? 12000) || undefined,
                selector: url.searchParams.get('selector') ?? undefined,
              };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        const page = conversationId ? this.deps.manager.pageOf(conversationId) : null;
        if (!page) {
          json(res, 400, { ok: false, error: 'no-page' });
          return;
        }
        const max = Math.min(body.maxChars ?? 12_000, 40_000);
        try {
          const result = await page.evaluate(
            (args: { selector: string | null; maxChars: number }) => {
              const root = args.selector
                ? (() => {
                    const el = document.querySelector(args.selector as string);
                    if (!el) throw new Error(`selector-not-found: ${args.selector}`);
                    return el;
                  })()
                : document.body;
              return {
                text: (
                  (root as HTMLElement).innerText ??
                  (root as Element).textContent ??
                  ''
                ).slice(0, args.maxChars * 2),
                url: window.location.href,
                title: document.title,
              };
            },
            { selector: body.selector ?? null, maxChars: max }
          );
          const truncated = (result.text ?? '').length >= max;
          json(res, 200, {
            ok: true,
            url: result.url,
            title: result.title,
            text: (result.text ?? '').slice(0, max),
            truncated,
          });
        } catch (error) {
          json(res, 500, {
            ok: false,
            error: redactRuntimeText(error instanceof Error ? error.message : String(error)),
          });
        }
        return;
      }

      case '/control/scroll': {
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        const page = conversationId ? this.deps.manager.pageOf(conversationId) : null;
        if (!page) {
          json(res, 400, { ok: false, error: 'no-page' });
          return;
        }
        try {
          const snapshot = await page.evaluate(() => ({
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            dpr: window.devicePixelRatio,
            url: window.location.href,
          }));
          json(res, 200, { ok: true, ...snapshot });
        } catch (error) {
          json(res, 500, {
            ok: false,
            error: redactRuntimeText(error instanceof Error ? error.message : String(error)),
          });
        }
        return;
      }

      case '/control/projection': {
        const body = JSON.parse((await readBody(req)) || '{}') as { regionId?: string };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        const region = await this.deps.regions.liveProjection(conversationId, body.regionId ?? '');
        if (!region) json(res, 404, { ok: false, error: 'not-found' });
        else json(res, 200, { ok: true, region });
        return;
      }

      case '/control/check': {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          areaId?: string;
          result?: string;
          reason?: string;
          newStatus?: string;
        };
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        const area = await this.deps.regions.recordCheck(conversationId, body.areaId ?? '', {
          status: body.result ?? 'verified',
          reason: body.reason,
          source: 'runtime',
          newStatus: body.newStatus,
        });
        if (!area) json(res, 404, { ok: false, error: 'not-found' });
        else json(res, 200, { ok: true, area });
        return;
      }

      case '/control/session/close': {
        const conversationId = conversationParam || this.deps.activeConversation() || '';
        await this.deps.manager.closeSession(conversationId);
        json(res, 200, { ok: true });
        return;
      }

      default:
        json(res, 404, { ok: false, error: 'not-found' });
    }
  }

  close(): void {
    for (const clients of this.sseClients.values()) {
      for (const client of clients) client.end();
    }
    this.sseClients.clear();
    this.server?.close();
    this.server = null;
  }
}
