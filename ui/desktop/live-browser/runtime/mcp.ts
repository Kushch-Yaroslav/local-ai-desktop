import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { BrowserManager } from './browser';
import type { RegionService } from './regions';
import { buildAreaContextText, visionLimitNote } from '../shared/context';
import { isAllowedPageUrl } from './security';
import { boundText } from './security';
import { log, redactRuntimeText } from './util';

export interface LadMcpContext {
  manager: BrowserManager;
  regions: RegionService;
  /** The conversation the desktop currently shows (default target). */
  activeConversation: () => string | null;
}

const MAX_TOOL_TEXT = 60_000;

type McpText = { type: 'text'; text: string };
type McpImage = {
  type: 'image';
  data: string;
  mimeType: string;
  _meta?: { ladBrowserImage: boolean };
};
type McpContent = McpText | McpImage;

function textResult(text: string): { content: McpText[] } {
  text = redactRuntimeText(text);
  return {
    content: [
      {
        type: 'text',
        text: text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n[truncated]` : text,
      },
    ],
  };
}

function imageResult(mime: string, data: string, note?: string): { content: McpContent[] } {
  const content: McpContent[] = [
    { type: 'image', data, mimeType: mime, _meta: { ladBrowserImage: true } },
  ];
  if (note) content.push({ type: 'text', text: redactRuntimeText(note) });
  return { content };
}

function errorResult(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: `error: ${redactRuntimeText(message)}` }],
    isError: true,
  };
}

/**
 * Build the MCP server with the browser tools. Each HTTP request gets a
 * fresh server+transport (stateless mode), which is exactly what Goose's
 * streamable_http extension expects.
 */
export function createLiveBrowserMcpServer(ctx: LadMcpContext): McpServer {
  const server = new McpServer({ name: 'local-ai-live-browser', version: '0.4.0' });

  const target = async (args: { conversation_id?: string }): Promise<string> => {
    const id = args.conversation_id?.trim() || '';
    if (!id)
      throw new Error(
        'no conversation: pass conversation_id explicitly; UI focus does not determine the agent session'
      );
    await ctx.manager.get(id);
    return id;
  };

  server.registerTool(
    'browser_recheck_area',
    {
      title: 'Recheck original visual area',
      description:
        'Reload the original URL at its saved viewport, measure DOM text fitting, and link the result to the explicitly selected project source revision. Only original text-clipping/overflow candidates can become Verified. Other intents remain inconclusive. User completion is separate from verification.',
      inputSchema: { conversation_id: z.string().min(1), area_id: z.string().min(1) },
    },
    async ({ conversation_id, area_id }) => {
      try {
        return textResult(
          JSON.stringify(await ctx.regions.recheck(await target({ conversation_id }), area_id))
        );
      } catch (error) {
        return errorResult(String(error));
      }
    }
  );

  // ------------------------------------------------------------------ nav

  server.registerTool(
    'browser_open',
    {
      title: 'Open URL in Live Browser',
      description:
        'Open a URL in the shared Live Browser page (the one the user sees). http/https only. ' +
        'Use conversation_id to target a specific chat; always pass the conversation_id supplied in the chat context.',
      inputSchema: {
        url: z.string().describe('http(s) URL to open'),
        conversation_id: z.string().min(1).describe('Target conversation (chat) id'),
      },
    },
    async ({ url, conversation_id }) => {
      const conversationId = await target({ conversation_id });
      const result = await ctx.manager.navigate(conversationId, url, 'agent');
      return result.ok
        ? textResult(`ok: ${result.summary}`)
        : errorResult(result.error ?? 'navigation failed');
    }
  );

  const navTool = (
    name: string,
    description: string,
    fn: (id: string) => Promise<{ ok: boolean; summary: string; error?: string }>
  ) => {
    server.registerTool(
      name,
      {
        title: description,
        description,
        inputSchema: {
          conversation_id: z.string().min(1),
        },
      },
      async ({ conversation_id }) => {
        const conversationId = await target({ conversation_id });
        const result = await fn(conversationId);
        return result.ok
          ? textResult(`ok: ${result.summary}`)
          : errorResult(result.error ?? 'action failed');
      }
    );
  };

  navTool('browser_back', 'Go back in browser history (shared Live Browser page).', (id) =>
    ctx.manager.back(id, 'agent')
  );
  navTool('browser_forward', 'Go forward in browser history (shared Live Browser page).', (id) =>
    ctx.manager.forward(id, 'agent')
  );
  navTool('browser_reload', 'Reload the current page (shared Live Browser page).', (id) =>
    ctx.manager.reload(id, 'agent')
  );

  server.registerTool(
    'browser_state',
    {
      title: 'Browser state',
      description: 'Current URL, title, readiness and ownership of the shared Live Browser page.',
      inputSchema: { conversation_id: z.string().min(1) },
    },
    async ({ conversation_id }) => {
      const conversationId = await target({ conversation_id });
      const state = ctx.manager.state(conversationId);
      if (!state) return textResult('no live page yet — open a URL with browser_open first');
      return textResult(
        `url: ${state.url}\ntitle: ${state.title}\nready: ${state.ready}\nownership: ${state.ownership}\nvisible: ${state.visible}\nactive chat: ${ctx.activeConversation() ?? 'none'}`
      );
    }
  );

  // ------------------------------------------------------------------ read

  server.registerTool(
    'browser_read',
    {
      title: 'Read page text',
      description:
        'Bounded readable text of the current page (no full DOM dump). Use a selector to scope. ' +
        'Set html=true for a bounded HTML fragment of the scope.',
      inputSchema: {
        conversation_id: z.string().min(1),
        max_chars: z.number().int().min(200).max(60000).optional(),
        selector: z.string().max(512).optional().describe('Optional CSS selector scope'),
        html: z.boolean().optional(),
      },
    },
    async ({ conversation_id, max_chars, selector, html }) => {
      const conversationId = await target({ conversation_id });
      const max = Math.min(max_chars ?? 12_000, 40_000);
      const page = ctx.manager.pageOf(conversationId);
      if (!page) return errorResult('no live page');
      try {
        const result = await page.evaluate(
          (args: { selector: string | null; maxChars: number; withHtml: boolean }) => {
            const root = args.selector
              ? (() => {
                  const el = document.querySelector(args.selector as string);
                  if (!el) throw new Error(`selector-not-found: ${args.selector}`);
                  return el;
                })()
              : document.body;
            const text = (
              (root as HTMLElement).innerText ??
              (root as Element).textContent ??
              ''
            ).slice(0, args.maxChars * 2);
            const htmlOut = args.withHtml
              ? ((root as Element).outerHTML ?? '').slice(0, args.maxChars * 3)
              : undefined;
            return { text, htmlOut, url: window.location.href, title: document.title };
          },
          { selector: selector ?? null, maxChars: max, withHtml: Boolean(html) }
        );
        const { text, truncated } = boundText(result.text ?? '', max);
        const htmlOut = result.htmlOut ? boundText(result.htmlOut, max) : undefined;
        let out = `url: ${result.url}\ntitle: ${result.title}\n\n${text}`;
        if (htmlOut) out += `\n\n--- HTML (bounded) ---\n${htmlOut.text}`;
        out += truncated || htmlOut?.truncated ? `\n[content truncated to ${max} chars]` : '';
        return textResult(out);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'browser_inspect',
    {
      title: 'Inspect element',
      description:
        'Element information for a CSS selector: tag, id, classes, accessible name, role, ' +
        'bounding box, bounded computed styles and a bounded HTML fragment.',
      inputSchema: {
        conversation_id: z.string().min(1),
        selector: z.string().max(512),
        max_chars: z.number().int().min(200).max(20000).optional(),
      },
    },
    async ({ conversation_id, selector, max_chars }) => {
      const conversationId = await target({ conversation_id });
      const page = ctx.manager.pageOf(conversationId);
      if (!page) return errorResult('no live page');
      try {
        const max = Math.min(max_chars ?? 4000, 12_000);
        const info = await page.evaluate((sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const style = window.getComputedStyle(el);
          const styles: Record<string, string> = {};
          for (const key of [
            'display',
            'position',
            'overflow',
            'overflow-x',
            'overflow-y',
            'visibility',
            'opacity',
            'width',
            'height',
            'margin',
            'padding',
            'font-family',
            'font-size',
            'font-weight',
            'line-height',
            'color',
            'background-color',
            'border',
            'border-radius',
            'white-space',
            'text-overflow',
            'flex',
            'grid',
          ]) {
            styles[key] = style.getPropertyValue(key).slice(0, 120);
          }
          const acc = (
            window as unknown as { getComputedAccessibleNode?: (n: Element) => unknown }
          ).getComputedAccessibleNode?.(el) as { name?: string; role?: string } | undefined;
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: Array.from(el.classList).slice(0, 12),
            text: ((el as HTMLElement).innerText ?? el.textContent ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 400),
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              docX: rect.x + window.scrollX,
              docY: rect.y + window.scrollY,
            },
            styles,
            accessibleName: acc?.name ?? el.getAttribute('aria-label'),
            role: acc?.role ?? el.getAttribute('role'),
            html: (el.outerHTML ?? '').slice(0, 6000),
          };
        }, selector);
        if (!info) return errorResult(`selector-not-found: ${selector}`);
        const { text: htmlText, truncated } = boundText(info.html, max);
        return textResult(
          [
            `<${info.tag}${info.id ? ` id="${info.id}"` : ''}${info.classes.length ? ` class="${info.classes.join(' ')}"` : ''}>`,
            info.accessibleName ? `accessible name: ${info.accessibleName}` : null,
            info.role ? `role: ${info.role}` : null,
            `rect (viewport): x=${Math.round(info.rect.x)} y=${Math.round(info.rect.y)} w=${Math.round(info.rect.width)} h=${Math.round(info.rect.height)}`,
            `rect (document): x=${Math.round(info.rect.docX)} y=${Math.round(info.rect.docY)}`,
            `text: ${info.text || '(empty)'}`,
            `styles: ${Object.entries(info.styles)
              .filter(([, v]) => v && v !== 'none' && v !== 'normal')
              .map(([k, v]) => `${k}:${v}`)
              .join('; ')}`,
            '',
            'HTML (bounded):',
            htmlText,
            truncated ? '[html truncated]' : '',
          ]
            .filter((line) => line !== null)
            .join('\n')
        );
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ------------------------------------------------------------------ input

  server.registerTool(
    'browser_click',
    {
      title: 'Click',
      description: 'Click an element by CSS selector (preferred) or at viewport CSS coordinates.',
      inputSchema: {
        conversation_id: z.string().min(1),
        selector: z.string().max(512).optional(),
        x: z.number().min(0).max(100000).optional(),
        y: z.number().min(0).max(100000).optional(),
        double: z.boolean().optional(),
      },
    },
    async ({ conversation_id, selector, x, y, double }) => {
      const conversationId = await target({ conversation_id });
      const page = ctx.manager.pageOf(conversationId);
      if (!page) return errorResult('no live page');
      try {
        if (selector) {
          await page.click(selector, { timeout: 10_000, ...(double ? { clickCount: 2 } : {}) });
          return textResult(`ok: clicked ${selector}`);
        }
        if (typeof x === 'number' && typeof y === 'number') {
          await page.mouse.click(x, y, double ? { clickCount: 2 } : undefined);
          return textResult(`ok: clicked at (${x}, ${y})`);
        }
        return errorResult('provide selector or x/y coordinates');
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'browser_fill',
    {
      title: 'Fill input',
      description: 'Set the value of an input/textarea/contenteditable element by CSS selector.',
      inputSchema: {
        conversation_id: z.string().min(1),
        selector: z.string().max(512),
        value: z.string().max(20000),
      },
    },
    async ({ conversation_id, selector, value }) => {
      const conversationId = await target({ conversation_id });
      const page = ctx.manager.pageOf(conversationId);
      if (!page) return errorResult('no live page');
      try {
        await page.fill(selector, value, { timeout: 10_000 });
        return textResult(`ok: filled ${selector}`);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'browser_scroll',
    {
      title: 'Scroll',
      description: 'Scroll the page to absolute CSS coordinates or by a delta.',
      inputSchema: {
        conversation_id: z.string().min(1),
        x: z.number().min(0).max(1000000).optional().describe('Absolute viewport CSS x'),
        y: z.number().min(0).max(1000000).optional().describe('Absolute viewport CSS y'),
        dx: z.number().min(-100000).max(100000).optional().describe('Delta x (scrollBy)'),
        dy: z.number().min(-100000).max(100000).optional().describe('Delta y (scrollBy)'),
      },
    },
    async ({ conversation_id, x, y, dx, dy }) => {
      const conversationId = await target({ conversation_id });
      const page = ctx.manager.pageOf(conversationId);
      if (!page) return errorResult('no live page');
      try {
        if (typeof x === 'number' && typeof y === 'number') {
          await page.evaluate(([sx, sy]) => window.scrollTo(sx, sy), [x, y]);
          return textResult(`ok: scrolled to (${x}, ${y})`);
        }
        if (typeof dx === 'number' && typeof dy === 'number') {
          await page.evaluate(([ddx, ddy]) => window.scrollBy(ddx, ddy), [dx, dy]);
          return textResult(`ok: scrolled by (${dx}, ${dy})`);
        }
        return errorResult('provide x/y or dx/dy');
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'browser_set_viewport',
    {
      title: 'Set viewport/zoom',
      description:
        'Change the physical viewport (320..4096 px) and real page zoom (0.25..4). CSS viewport in native mode is physical size divided by zoom. Preview scale is independent.',
      inputSchema: {
        conversation_id: z.string().min(1),
        width: z.number().int().min(320).max(4096),
        height: z.number().int().min(240).max(4096),
        zoom: z.number().min(0.25).max(4).optional(),
      },
    },
    async ({ conversation_id, width, height, zoom }) => {
      const conversationId = await target({ conversation_id });
      const result = await ctx.manager.setViewport(
        conversationId,
        { width, height },
        zoom ?? 1,
        'agent'
      );
      return result.ok
        ? textResult(`ok: viewport ${width}x${height} zoom ${zoom ?? 1}`)
        : errorResult(result.error ?? 'failed');
    }
  );

  // -------------------------------------------------------------- capture

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot / crop',
      description:
        'Capture the current viewport, or a bounded crop (viewport CSS px). The image is included in the result; ' +
        'images are returned only when the user enabled Vision for this chat. With Vision Off use DOM text.',
      inputSchema: {
        conversation_id: z.string().min(1),
        x: z.number().min(0).max(100000).optional(),
        y: z.number().min(0).max(100000).optional(),
        width: z.number().min(1).max(100000).optional(),
        height: z.number().min(1).max(100000).optional(),
        max_edge: z.number().int().min(128).max(4096).optional(),
      },
    },
    async ({ conversation_id, x, y, width, height, max_edge }) => {
      const conversationId = await target({ conversation_id });
      const workspace = (await ctx.regions.list(conversationId)).workspace;
      if (workspace.vision !== 'on')
        return textResult(
          'Vision is Off for this chat. No image captured or returned. Use browser_read/browser_inspect and DOM evidence, or ask the user to enable Vision.'
        );
      const session = ctx.manager.meta(conversationId);
      if (!session) return errorResult('no live page');
      const useCrop =
        typeof x === 'number' &&
        typeof y === 'number' &&
        typeof width === 'number' &&
        typeof height === 'number';
      if (useCrop) {
        const result = await ctx.manager.captureCrop(
          conversationId,
          { x, y, width, height },
          { maxEdge: max_edge ?? 1280, quality: 80 }
        );
        if ('error' in result) return errorResult(result.error);
        return imageResult(
          result.mime,
          result.data,
          `crop ${result.width}x${result.height} (viewport CSS rect ${x},${y},${width}x${height}; DPR ${session.dpr} zoom ${session.zoom})`
        );
      }
      const result = await ctx.manager.captureFrame(conversationId, {
        maxEdge: max_edge ?? 1600,
        quality: 75,
      });
      if ('error' in result) return errorResult(result.error);
      return imageResult(result.mime, result.data, `viewport ${result.width}x${result.height}`);
    }
  );

  // ---------------------------------------------------------------- regions

  server.registerTool(
    'browser_list_areas',
    {
      title: 'List Live Browser areas',
      description:
        'All user-defined areas/regions for a conversation with their status, task and diagnostics.',
      inputSchema: { conversation_id: z.string().min(1) },
    },
    async ({ conversation_id }) => {
      const conversationId = conversation_id?.trim() || '';
      if (!conversationId) return textResult('no conversation specified');
      const state = await ctx.regions.list(conversationId);
      if (!state.areas.length) return textResult('no areas selected yet');
      return textResult(buildAreaContextText({ areas: state.areas, regions: state.regions }));
    }
  );

  server.registerTool(
    'browser_describe_area',
    {
      title: 'Describe area in detail',
      description:
        'Full bounded context for one area: task, URL, geometry, viewport/DPR/scroll, DOM anchors, styles, ' +
        'findings, surroundings, diagnostics, history — plus a bounded crop image when available.',
      inputSchema: {
        conversation_id: z.string().min(1),
        area_id: z.string(),
        with_image: z.boolean().optional(),
      },
    },
    async ({ conversation_id, area_id, with_image }) => {
      const conversationId = await target({ conversation_id });
      const state = await ctx.regions.list(conversationId);
      const area = state.areas.find((a) => a.id === area_id);
      if (!area) return errorResult(`unknown-area: ${area_id}`);
      const text = buildAreaContextText({ areas: [area], regions: state.regions });
      if (with_image === false || state.workspace.vision !== 'on')
        return textResult(text + '\nVision Off: no image returned.');
      const firstRegion = state.regions.find((r) => r.areaId === area.id);
      if (!firstRegion) return textResult(text);
      const capture = await ctx.regions.captureRegion(conversationId, firstRegion, {
        maxEdge: 1280,
      });
      const note = visionLimitNote(area, state.regions, 'unknown');
      if ('error' in capture) {
        return textResult(
          `${text}\n\n[image unavailable: ${capture.error}${capture.reason ? ` (${capture.reason})` : ''}]${note ? `\n${note}` : ''}`
        );
      }
      return imageResult(capture.mime, capture.data, `${text}${note ? `\n${note}` : ''}`);
    }
  );

  server.registerTool(
    'browser_ground_region',
    {
      title: 'Ground a new region',
      description:
        'Create a region from a viewport CSS rect (e.g. after inspecting coordinates). ' +
        'Use when the user points at a spot without using the selection tool.',
      inputSchema: {
        conversation_id: z.string().min(1),
        x: z.number().min(0).max(100000),
        y: z.number().min(0).max(100000),
        width: z.number().min(4).max(100000),
        height: z.number().min(4).max(100000),
        area_name: z.string().max(200).optional(),
      },
    },
    async ({ conversation_id, x, y, width, height, area_name }) => {
      const conversationId = await target({ conversation_id });
      const rect = { x, y, width, height };
      const { region, area } = await ctx.regions.createRegion(conversationId, rect, {
        areaId: undefined,
        note: `agent grounded via browser tools${area_name ? ` — ${area_name}` : ''}`,
      });
      if (area_name && area) {
        await ctx.regions.updateArea(conversationId, area.id, {
          name: area_name,
          statusSource: 'agent',
        });
      }
      return textResult(
        `ok: region ${region.id} in area "${area?.name}" (${region.anchors.length} anchors, ${region.diagnostics.join('; ')})`
      );
    }
  );

  server.registerTool(
    'browser_set_area_status',
    {
      title: 'Set area status',
      description:
        'Update an area status: Detected | Confirmed | In progress | Fixed | Verified | Unresolved. ' +
        'Use after investigating or fixing the selected area.',
      inputSchema: {
        conversation_id: z.string().min(1),
        area_id: z.string(),
        status: z.enum(['Detected', 'Confirmed', 'In progress', 'Fixed', 'Unresolved']),
        note: z.string().max(1000).optional(),
      },
    },
    async ({ conversation_id, area_id, status, note }) => {
      const conversationId = await target({ conversation_id });
      const area = await ctx.regions.updateArea(conversationId, area_id, {
        status,
        statusSource: 'agent',
      });
      if (note)
        await ctx.regions.recordCheck(conversationId, area_id, {
          status,
          reason: note,
          source: 'agent',
        });
      return textResult(`ok: area "${area.name}" → ${status}`);
    }
  );

  server.registerTool(
    'browser_check_area',
    {
      title: 'Record area check result',
      description:
        'Record an agent assessment after changes. This is a claim, not proof. Use browser_recheck_area for source-revision-linked verification; only that tool can certify Verified.',
      inputSchema: {
        conversation_id: z.string().min(1),
        area_id: z.string(),
        result: z.enum(['fixed', 'not-fixed', 'partially-fixed', 'cannot-verify']),
        reason: z.string().max(2000),
        new_status: z
          .enum(['Detected', 'Confirmed', 'In progress', 'Fixed', 'Unresolved'])
          .optional(),
      },
    },
    async ({ conversation_id, area_id, result, reason, new_status }) => {
      const conversationId = await target({ conversation_id });
      const area = await ctx.regions.recordCheck(conversationId, area_id, {
        status: result,
        reason,
        source: 'agent',
        newStatus: new_status,
      });
      if (!area) return errorResult(`unknown-area: ${area_id}`);
      return textResult(
        `ok: check ${result} recorded on "${area.name}"${new_status ? `; status → ${new_status}` : ''}`
      );
    }
  );

  // ------------------------------------------------------------------ misc

  server.registerTool(
    'browser_release_input',
    {
      title: 'Return control to user',
      description:
        'Hand browser control back to the user (ownership → user). Call when your browser work is done.',
      inputSchema: { conversation_id: z.string().min(1) },
    },
    async ({ conversation_id }) => {
      const conversationId = await target({ conversation_id });
      await ctx.manager.setOwnership(conversationId, 'user', 'agent');
      return textResult('ok: ownership returned to user');
    }
  );

  server.registerTool(
    'browser_take_control',
    {
      title: 'Take control',
      description:
        'Mark the browser as agent-controlled (ownership → agent) before acting on behalf of the user.',
      inputSchema: { conversation_id: z.string().min(1) },
    },
    async ({ conversation_id }) => {
      const conversationId = await target({ conversation_id });
      await ctx.manager.setOwnership(conversationId, 'agent', 'agent');
      return textResult('ok: ownership → agent');
    }
  );

  return server;
}

/**
 * Wire the MCP server to an HTTP endpoint (stateless Streamable HTTP).
 * `handleMcp(req, res)` should be called for POST /mcp requests with a
 * parsed JSON body.
 */
export async function handleMcpRequest(
  ctx: LadMcpContext,
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse
): Promise<void> {
  try {
    const server = createLiveBrowserMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    req.on('error', () => undefined);
    await server.connect(transport);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res, (req as { body?: unknown }).body);
  } catch (error) {
    log('mcp request failed:', error instanceof Error ? error.stack : error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
    }
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        id: randomUUID(),
      })
    );
  }
}

export { isAllowedPageUrl };
