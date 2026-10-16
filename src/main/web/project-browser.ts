import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { ConfirmAction, ProjectToolDefinition } from '../tools/project-tools';
import { projectPath } from '../tools/project-path';
import { launchWebBrowser } from './web-tools';
import type { ProjectBrowserObserver } from './live-browser';

export const projectBrowserTool: ProjectToolDefinition = { type: 'function', function: {
  name: 'web_project',
  description: 'Verify a local web project using the application Playwright browser, without installing npm packages or launching Chrome in run_terminal. First open a project-relative HTML path (default index.html), or an explicitly approved http://localhost:PORT / http://127.0.0.1:PORT URL. Then read DOM, click a CSS selector (including hash navigation), go back/forward, reload after edits, fill a field, scroll, or capture a screenshot file. Returns JS/console/network errors. Screenshots are files, not model vision. Only the approved project/origin is reachable; no external network, file://, WebSocket, POST or arbitrary JS evaluation. With web disabled this tool is unavailable.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['open', 'read', 'click', 'fill', 'scroll', 'back', 'forward', 'reload', 'screenshot'] },
    path: { type: 'string', description: 'Project-relative static HTML path; never file://.' },
    url: { type: 'string', description: 'Loopback HTTP URL with explicit port. Requires approval for this origin.' },
    selector: { type: 'string', description: 'CSS selector for click or fill.' },
    wait_ms: { type: 'integer', minimum: 0, maximum: 2000, description: 'Optional bounded settling delay before reading or capturing; default 100 ms.' },
    value: { type: 'string', maxLength: 4000, description: 'Text for fill; never a file upload.' },
    delta_y: { type: 'integer', minimum: -2000, maximum: 2000, description: 'Vertical wheel distance for scroll.' },
    project: { type: 'integer', enum: [1, 2] },
  }, required: ['action'], additionalProperties: false },
} };
const staticOrigin = 'https://project-preview.invalid';
const mime: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const maxBytes = 4 * 1024 * 1024;
export function loopbackTarget(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.port || url.username || url.password) throw new Error('Only HTTP localhost/127.0.0.1 with an explicit non-default port is supported');
  return url;
}
/** No cookies/auth/proxy inheritance, no DNS or redirects. Every redirect is
 * returned to Chromium and must pass the same exact-origin route again. */
async function fetchLoopback(url: URL, signal: AbortSignal) {
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolveResult, reject) => {
    const req = request({ hostname: '127.0.0.1', port: url.port, path: url.pathname + url.search, method: 'GET', signal, headers: { host: url.host, 'accept-encoding': 'identity' } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) req.destroy(new Error('Preview response exceeds 4 MiB')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const headers: Record<string, string> = {};
        for (const key of ['content-type', 'location', 'content-security-policy']) {
          const value = response.headers[key]; if (typeof value === 'string') headers[key] = value;
        }
        resolveResult({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Preview request timed out')), 10_000);
    req.once('close', () => clearTimeout(deadline)); req.on('error', reject); req.end();
  });
}
export async function readPreviewAsset(root: string, pathname: string): Promise<{ body: Buffer; contentType: string }> {
  const decoded = decodeURIComponent(pathname);
  const parts = decoded.replace(/^\//, '').split('/');
  if (parts.some(part => part.startsWith('.') || part.includes('\\') || part.includes('\0'))) throw new Error('Hidden paths and traversal are blocked');
  const input = parts.join('/') || 'index.html';
  const contentType = mime[extname(input).toLowerCase()];
  if (!contentType) throw new Error('Only static web asset extensions are allowed');
  const base = await realpath(root); const target = await projectPath(base, input);
  for (let current = resolve(base, input); current !== base; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Preview symlinks are blocked');
  }
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // Validate the opened inode too, preventing directory swaps from escaping
    // the authorized root on the supported Linux production platform.
    const actual = await realpath(process.platform === 'linux' ? `/proc/self/fd/${file.fd}` : target);
    const rel = relative(base, actual);
    if (rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep) || rel.split(sep).some(part => part.startsWith('.')) || !mime[extname(actual).toLowerCase()]) throw new Error('Opened asset escaped preview scope');
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('Preview asset must be a regular file of at most 4 MiB');
    const body = Buffer.alloc(Math.min(maxBytes + 1, info.size + 1));
    const { bytesRead } = await file.read(body, 0, body.length, 0);
    if (bytesRead > maxBytes) throw new Error('Preview asset exceeds limit');
    return { body: body.subarray(0, bytesRead), contentType };
  } finally { await file.close(); }
}

export class ProjectBrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private origin?: string;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly errors: string[] = [];
  private readonly blocked: string[] = [];
  private captures = 0;
  constructor(private readonly root: string, private readonly captureDirectory: string, private readonly launch: () => Promise<Browser> = launchWebBrowser, private readonly observer?: ProjectBrowserObserver) {}
  private note(list: string[], text: string) { if (list.length < 40) list.push(text.slice(0, 500)); }
  async execute(args: Record<string, unknown>, signal: AbortSignal, confirm?: ConfirmAction, actionId: string = randomUUID()): Promise<unknown> {
    const cancel = () => { void this.close(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted || this.closed) throw new Error('Project browser cancelled or closed');
      const waitMs = args.wait_ms ?? 100;
      if (!Number.isInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > 2000) throw new Error('wait_ms must be 0..2000');
      if (args.action === 'open') {
        if (args.path !== undefined && args.url !== undefined) throw new Error('Choose path or url');
        const url = args.url !== undefined ? loopbackTarget(String(args.url)) : new URL('/' + String(args.path ?? 'index.html').replace(/^\//, ''), staticOrigin);
        if (url.origin !== staticOrigin && args.url === undefined) throw new Error('Invalid project path');
        if (this.origin && this.origin !== url.origin) throw new Error('Preview is scoped to its initial origin for this run');
        if (!this.origin) {
          const decision = await confirm?.({ title: 'Проверка локального проекта в браузере', root: this.root, category: 'system_command', actionId,
            detail: `До конца этого запуска разрешить read-only браузеру ${args.url ? url.origin : `статические web-файлы проекта ${this.root}`}? Скрипты страницы выполняются; другие адреса и запись через HTTP заблокированы.` }, signal);
          if (!decision?.approved || signal.aborted) return { error: 'Project browser permission denied or unavailable', code: 'PERMISSION_DENIED', retrySameArguments: false };
          this.origin = url.origin;
          this.observer?.state('loading', url.href);
          await this.start();
        }
        this.errors.length = 0; this.blocked.length = 0;
        this.observer?.state('loading', url.href);
        const response = await this.page!.goto(url.href, { waitUntil: 'load' });
        if (response && !response.ok()) throw new Error(`Preview HTTP ${response.status()}`);
        this.observer?.action({ kind: 'navigate', at: Date.now() });
      } else {
        if (!this.page) throw new Error('Use web_project action=open first');
        if (args.action === 'click' || args.action === 'fill') {
          if (typeof args.selector !== 'string' || !args.selector.trim() || args.selector.length > 500) throw new Error('A bounded CSS selector is required');
          const target = this.page.locator(args.selector).first();
          await target.scrollIntoViewIfNeeded();
          const box = await target.boundingBox();
          if (args.action === 'click') await target.click();
          else {
            if (typeof args.value !== 'string' || args.value.length > 4000) throw new Error('fill requires value of at most 4000 characters');
            await target.fill(args.value);
          }
          this.observer?.action({ kind: String(args.action), ...(box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : {}), at: Date.now() });
        } else if (args.action === 'scroll') {
          if (!Number.isInteger(args.delta_y) || Math.abs(Number(args.delta_y)) > 2000) throw new Error('delta_y must be -2000..2000');
          await this.page.mouse.wheel(0, Number(args.delta_y));
          this.observer?.action({ kind: 'scroll', at: Date.now() });
        } else if (['back', 'forward', 'reload'].includes(String(args.action))) {
          this.observer?.state('loading');
          if (args.action === 'back') await this.page.goBack({ waitUntil: 'load' });
          else if (args.action === 'forward') await this.page.goForward({ waitUntil: 'load' });
          else { this.errors.length = 0; this.blocked.length = 0; await this.page.reload({ waitUntil: 'load' }); }
          this.observer?.action({ kind: String(args.action), at: Date.now() });
        }
        else if (args.action === 'screenshot') {
          if (this.captures >= 8) throw new Error('Screenshot limit reached (8 per run)');
          this.captures += 1;
          await this.page.waitForTimeout(Number(waitMs));
          const bytes = await this.page.screenshot({ type: 'png', timeout: 10_000 });
          if (signal.aborted || this.closed) throw new Error('Project browser cancelled');
          await mkdir(this.captureDirectory, { recursive: true, mode: 0o700 });
          const path = join(this.captureDirectory, `${randomUUID()}.png`);
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
          return { screenshot_path: path, bytes: bytes.length, visual_analysis: false, ...(await this.read()) };
        } else if (args.action !== 'read') throw new Error('Unknown project browser action');
      }
      if (signal.aborted || this.closed) throw new Error('Project browser cancelled');
      await this.page!.waitForTimeout(Number(waitMs));
      this.observer?.state('live', this.page!.url());
      return await this.read();
    } catch (error) {
      // Failed startup cannot leave a half-initialized reusable session.
      const code = signal.aborted || this.closed ? 'BROWSER_CLOSED_OR_CANCELLED' : !this.page && this.origin ? 'BROWSER_UNAVAILABLE' : 'PROJECT_BROWSER_FAILED';
      if (this.origin) this.observer?.state('error', undefined, String(error).slice(0, 300));
      if (!this.page && this.origin) await this.close();
      return { error: (error instanceof Error ? error.message : String(error)).slice(0, 4000), code, retrySameArguments: false };
    } finally { signal.removeEventListener('abort', cancel); }
  }
  private async start() {
    this.browser = await this.launch();
    if (this.closed) { await this.browser.close(); throw new Error('Project browser cancelled during launch'); }
    this.context = await this.browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await this.context.clearPermissions();
    await this.context.addInitScript(() => { Object.defineProperty(window, 'RTCPeerConnection', { value: undefined, configurable: false }); });
    await this.context.routeWebSocket('**/*', socket => socket.close());
    let requests = 0; let totalBytes = 0;
    await this.context.route('**/*', async route => {
      const req = route.request();
      try {
        const url = new URL(req.url());
        if (url.origin !== this.origin || url.username || url.password || req.method() !== 'GET' || ++requests > 256 || totalBytes > 32 * maxBytes) throw new Error('Outside approved origin, request method or budget');
        if (this.origin === staticOrigin) {
          const asset = await readPreviewAsset(this.root, url.pathname); totalBytes += asset.body.length;
          await route.fulfill({ ...asset, headers: { 'x-content-type-options': 'nosniff' } });
        } else {
          const response = await fetchLoopback(url, this.abort.signal); totalBytes += response.body.length;
          await route.fulfill(response);
        }
      } catch (error) {
        this.note(this.blocked, `${req.method()} ${req.url()}: ${String(error)}`);
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    if (this.closed) { await this.context.close(); throw new Error('Project browser cancelled during setup'); }
    this.page = await this.context.newPage();
    if (this.closed) { await this.context.close(); throw new Error('Project browser cancelled during setup'); }
    this.page.on('close', () => { if (!this.closed) this.observer?.state('error', undefined, 'Browser page closed'); });
    this.observer?.ready(this.page);
    this.browser.on('disconnected', () => { if (!this.closed) this.observer?.state('error', undefined, 'Browser disconnected'); this.observer?.closed(); });
    this.page.setDefaultTimeout(5_000); this.page.setDefaultNavigationTimeout(10_000);
    this.context.on('page', page => { if (page !== this.page) void page.close(); });
    this.page.on('framenavigated', frame => {
      if (frame === this.page?.mainFrame() && frame.url() !== 'about:blank') {
        try { if (new URL(frame.url()).origin === this.origin) { this.observer?.state('live', frame.url()); return; } } catch { /* Unsupported navigation. */ }
        this.note(this.blocked, `Navigation outside approved origin: ${frame.url()}`);
        void this.page?.close();
      }
    });
    this.page.on('pageerror', error => this.note(this.errors, error.message));
    this.page.on('console', message => { if (message.type() === 'error') this.note(this.errors, message.text()); });
    this.page.on('dialog', dialog => { void dialog.dismiss(); });
  }
  private async read() {
    const page = this.page!;
    if (new URL(page.url()).origin !== this.origin) throw new Error('Page left approved preview origin');
    const dom = await page.evaluate(() => ({ title: document.title, url: location.href, content: document.body.innerText.slice(0, 12_000), links: Array.from(document.querySelectorAll('a[href]')).slice(0, 40).map(a => ({ text: a.textContent, href: (a as HTMLAnchorElement).href })) }));
    return { ...dom, ...(this.origin === staticOrigin ? { source_path: await projectPath(this.root, decodeURIComponent(new URL(page.url()).pathname).slice(1) || 'index.html') } : {}), javascript_errors: [...this.errors], blocked_requests: [...this.blocked], browser_check: 'DOM and runtime diagnostics only; screenshots require separate visual analysis' };
  }
  async close() {
    this.closed = true; this.abort.abort(); this.observer?.closed();
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}
