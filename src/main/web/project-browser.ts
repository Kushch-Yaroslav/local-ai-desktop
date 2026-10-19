import { installQaInstrumentation, qaSteps, runBrowserQa, screenshotHash, keyboardActions, keyboardStep } from './browser-qa';
import type { BrowserCapture, BrowserQaReport, BrowserQaStatus, BrowserVisualResult } from '../../shared/browser-qa';
import { ProjectFileWatcher } from './project-file-watcher';
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { ConfirmAction, ProjectToolDefinition } from '../tools/project-tools';
import { projectPath } from '../tools/project-path';
import { launchWebBrowser } from './web-tools';
import type { BrowserInput } from '../../shared/live-browser';
import type { ProjectBrowserObserver } from './live-browser';
import type { NativeProjectPage } from './native-project-page';
import { QaLoopGuard, projectRevision } from './qa-loop-guard';
import { paths } from '../services/paths';

export const projectBrowserTool: ProjectToolDefinition = { type: 'function', function: {
  name: 'web_project',
  description: 'Verify a local web project using the application Playwright browser. In Electron it is the visible native WebContentsView shared with the user (headed); only the CLI fallback is headless. Do not infer headless rendering just from Playwright. Use this browser without installing npm packages or launching Chrome in run_terminal. First open a project-relative HTML path (default index.html), or an explicitly approved http://localhost:PORT / http://127.0.0.1:PORT URL. Then read DOM, click a CSS selector (including hash navigation), go back/forward, reload explicitly if needed (Live Browser automatically refreshes ordinary HTML/CSS/JS edits when visible), fill a field, scroll, or capture a screenshot file. Returns JS/console/network errors. Use action qa for bounded real interaction tests and optional actual pixel analysis. For Canvas keyboard use key/keydown/keyup/hold with real browser events, never fill(body) or hidden HTML inputs. QA may be repeated after meaningful edits without a fixed lifetime count; unchanged loops return QA_NO_PROGRESS with prior evidence. Screenshots alone are not vision. QA reports include per-action evidence; fix failures and retest. Supply checks with explicit expected text/value to establish handling, not just input delivery. Only the approved project/origin is reachable; no external network, file://, WebSocket, POST or arbitrary JS evaluation. With web disabled this tool is unavailable.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['open', 'read', 'click', 'fill', 'scroll', 'back', 'forward', 'reload', 'screenshot', 'qa', 'key', 'keydown', 'keyup', 'hold'] },
    path: { type: 'string', description: 'Project-relative static HTML path; never file://.' },
    url: { type: 'string', description: 'Loopback HTTP URL with explicit port. Requires approval for this origin.' },
    selector: { type: 'string', description: 'CSS selector for click or fill.' },
    key: {type:'string',description:'Real keyboard key/combination, e.g. w, Shift+w, q, e. Never use fill(body) for keyboard testing.'},
    duration_ms: {type:'integer',minimum:0,maximum:2000,description:'Hold duration; default 300 ms.'},
    repeat: {type:'integer',minimum:1,maximum:8},
    wait_ms: { type: 'integer', minimum: 0, maximum: 2000, description: 'Optional bounded settling delay before reading or capturing; default 100 ms.' },
    value: { type: 'string', maxLength: 4000, description: 'Text for fill; never a file upload.' },
    delta_y: { type: 'integer', minimum: -2000, maximum: 2000, description: 'Vertical wheel distance for scroll.' },
    clip: { type: 'object', properties: { x: {type:'number'}, y:{type:'number'}, width:{type:'number'}, height:{type:'number'} }, required:['x','y','width','height'], additionalProperties:false },
    checks: { type:'array', maxItems:8, items:{type:'object',properties:{ action:{type:'string',enum:['click','fill','key','keydown','keyup','hold','scroll']},selector:{type:'string'},value:{type:'string'},key:{type:'string'},duration_ms:{type:'integer',minimum:0,maximum:2000},repeat:{type:'integer',minimum:1,maximum:8},expect:{type:'object',properties:{selector:{type:'string'},text:{type:'string'},value:{type:'string'},changed:{type:'boolean',description:'Expected text state changes after the action; true proves handling, not just delivery.'}},required:['selector'],additionalProperties:false}},required:['action'],additionalProperties:false} },
    project: { type: 'integer', enum: [1, 2] },
  }, required: ['action'], additionalProperties: false },
} };
const staticOrigin = 'https://project-preview.invalid';
const previewCsp = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'";
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

export type ProjectQaOptions = { runId?: string; guard?: QaLoopGuard; runtimeIdentity?: unknown; analyze?: (capture: BrowserCapture, signal: AbortSignal, before?: BrowserCapture) => Promise<BrowserVisualResult>; status?: (status: BrowserQaStatus) => void; signal?: AbortSignal };
export class ProjectBrowserSession {
  private browser?: Browser;
  private native?: NativeProjectPage;
  private context?: BrowserContext;
  private page?: Page;
  private origin?: string;
  private lastAllowedUrl?: string;
  private blockedNavigation = false;
  private recoveringNavigation = false;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly errors: string[] = [];
  private readonly blocked: string[] = [];
  private networkBudget = { requests:0, bytes:0, started:Date.now() };
  private captures = 0;
  private readonly fallbackGuard = new QaLoopGuard();
  private get qaGuard() { return this.qaOptions.guard ?? this.fallbackGuard; }
  private ownership: 'agent' | 'user' | 'paused' = 'agent';
  private authorized = false;
  private denied?: string;
  private readonly heldKeys = new Set<string>();
  private queuedInputs = 0;
  get reusable() { return !this.closed && Boolean(this.page && !this.page.isClosed()); }
  beginRun(observer: ProjectBrowserObserver, qaOptions: ProjectQaOptions = {}) {
    this.qaOptions = qaOptions;
    if (!qaOptions.guard) this.fallbackGuard.rearm();
    this.ownership = 'agent'; this.authorized = false; this.denied = undefined; this.captures = 0; this.observer = observer;
    if (this.page) this.bindObserver();
  }
  async finishRun(refresh = true) {
    if (refresh) await this.exclusive(async () => { await this.watcher?.flush(); await this.refresh(true); });
    if (!this.reusable || !this.authorized) { await this.close(); return; }
    await this.releaseInput();
    this.ownership = 'user'; this.observer?.ownership?.('user');
  }
  async pauseRun() { this.ownership = 'paused'; await this.releaseInput(); this.observer?.ownership?.('paused'); }
  private bindObserver() {
    this.observer?.ready(this.page!, visible => { this.previewVisible = visible; this.scheduleRefresh(); }, { input: input => this.input(input), close: () => this.close() });
    this.observer?.ownership?.(this.ownership);
  }
  private async releaseInput() {
    await this.native?.releaseInput();
    for (const key of [...this.heldKeys].reverse()) await this.page?.keyboard.up(key).catch(() => undefined);
    this.heldKeys.clear(); await this.page?.mouse.up().catch(() => undefined);
  }
  async input(input: BrowserInput) {
    if (this.ownership !== 'user' || !this.reusable || !input || typeof input !== 'object') throw new Error('Interactive preview unavailable');
    if (this.queuedInputs >= 64) throw new Error('Preview input queue is full');
    this.queuedInputs++;
    return this.exclusive(async () => {
      if (this.ownership !== 'user' || !this.reusable) throw new Error('Browser control returned to agent');
      const page = this.page!;
      const bounded = (value: unknown, limit: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
      if (input.kind === 'pointer' && ['down', 'up', 'move'].includes(input.phase) && bounded(input.x, 1280) && bounded(input.y, 900) && input.x >= 0 && input.y >= 0) {
        await page.mouse.move(input.x, input.y);
        if (input.phase === 'down') await page.mouse.down();
        if (input.phase === 'up') await page.mouse.up();
      } else if (input.kind === 'wheel' && bounded(input.dx, 2000) && bounded(input.dy, 2000)) await page.mouse.wheel(input.dx, input.dy);
      else if (input.kind === 'text' && typeof input.text === 'string' && input.text.length <= 4000) await page.keyboard.insertText(input.text);
      else if (input.kind === 'key' && ['down', 'up'].includes(input.phase) && typeof input.key === 'string' && ((Array.from(input.key).length === 1 && !/\p{C}/u.test(input.key)) || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Shift', 'Home', 'End', 'PageUp', 'PageDown'].includes(input.key))) {
        if (Array.from(input.key).length === 1 && !/^[\x20-\x7E]$/.test(input.key)) {
          if (input.phase === 'down') await page.keyboard.insertText(input.key);
        } else if (input.phase === 'down') { this.heldKeys.add(input.key); await page.keyboard.down(input.key); }
        else { this.heldKeys.delete(input.key); await page.keyboard.up(input.key); }
      } else if (input.kind === 'release') await this.releaseInput();
      else if (input.kind === 'back') await page.goBack({ waitUntil: 'load' });
      else if (input.kind === 'forward') await page.goForward({ waitUntil: 'load' });
      else if (input.kind === 'reload') await page.reload({ waitUntil: 'load' });
      else throw new Error('Invalid interactive browser input');
    }).finally(() => { this.queuedInputs--; });
  }
  private operations: Promise<void> = Promise.resolve();
  private watcher?: ProjectFileWatcher;
  private previewVisible = false;
  private dirty = false;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private serverManaged = false;
  private autoReloadQueued = false;
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
  private stopWatching() { this.watcher?.close(); this.watcher = undefined; clearTimeout(this.reloadTimer); this.dirty = false; }
  private async ensureWatching() {
    if (!this.observer || this.watcher || this.serverManaged || this.closed || !this.page || this.page.isClosed()) return;
    this.watcher = new ProjectFileWatcher(this.root, () => { this.dirty = true; this.scheduleRefresh(); }, error => this.observer?.state('error', undefined, `Auto-reload unavailable: ${String(error).slice(0, 200)}`));
    await this.watcher.start();
  }
  private scheduleRefresh() {
    clearTimeout(this.reloadTimer);
    if (!this.dirty || !this.previewVisible || this.closed || this.serverManaged || this.autoReloadQueued) return;
    // File watcher already debounces 400 ms. Share the tool operation lock, not a second scheduler.
    this.reloadTimer = setTimeout(() => {
      this.autoReloadQueued = true;
      void this.exclusive(() => this.refresh()).catch(error => { if (!this.closed) this.observer?.state('error', undefined, `Auto-reload failed: ${String(error).slice(0, 200)}`); })
        .finally(() => { this.autoReloadQueued = false; this.scheduleRefresh(); });
    }, this.watcher?.settled ? 0 : 100);
    this.reloadTimer.unref();
  }
  private async refresh(finalHidden = false) {
    if (!this.dirty || (!this.previewVisible && !finalHidden) || this.closed || this.serverManaged || !this.page || this.page.isClosed() || !this.watcher?.settled) return;
    this.dirty = false;
    this.errors.length = 0; this.blocked.length = 0;
    this.observer?.state('loading');
    const response = await this.page.reload({ waitUntil: 'load' });
    if (response && !response.ok()) throw new Error(`Preview HTTP ${response.status()}`);
    // Let the real page settle before reporting the refreshed revision.
    await this.page.waitForTimeout(150);
    if (!this.closed) { this.observer?.action({ kind: 'auto-reload', at: Date.now() }); this.observer?.state('live', this.page.url()); }
  }
  private detectServerReload(path: string, body: Buffer, html: boolean) {
    if (this.origin === staticOrigin || this.serverManaged) return;
    if (/^\/(?:@vite\/client|@react-refresh|_next\/|__webpack_hmr)/.test(path) || (html && /(?:\/@vite\/client|\/_next\/|__NEXT_DATA__|webpack-dev-server|webpack-hot-middleware|parcelRequire.*hmr)/i.test(body.toString('utf8')))) {
      this.serverManaged = true; this.stopWatching();
    }
  }
  constructor(private readonly root: string, private readonly captureDirectory: string, private readonly launch: () => Promise<Browser> = launchWebBrowser, private observer?: ProjectBrowserObserver, private qaOptions: ProjectQaOptions = {}) {}
  private note(list: string[], text: string) { if (list.length < 40) list.push(text.slice(0, 500)); }
  async execute(args: Record<string, unknown>, signal: AbortSignal, confirm?: ConfirmAction, actionId: string = randomUUID()): Promise<unknown> {
    this.ownership = 'agent'; this.observer?.ownership?.('agent');
    const cancel = () => { void this.close(); };
    signal.addEventListener('abort', cancel, { once: true });
    const operationSignal = AbortSignal.any([signal, this.abort.signal]);
    try { return await this.exclusive(() => this.executePage(args, operationSignal, confirm, actionId)); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  private async executePage(args: Record<string, unknown>, signal: AbortSignal, confirm: ConfirmAction | undefined, actionId: string): Promise<unknown> {
    try {
      this.networkBudget = { requests:0, bytes:0, started:Date.now() };
      if (signal.aborted || this.closed) throw new Error('Project browser cancelled or closed');
      if (!keyboardActions.has(String(args.action))) await this.releaseInput();
      if (args.action === 'qa' && !this.page && !this.denied) {
        const opened = await this.executePage({action:'open', ...(args.path ? {path:args.path} : {}), ...(args.url ? {url:args.url} : {})}, signal, confirm, actionId);
        if (opened && typeof opened === 'object' && 'error' in opened) return opened;
      }
      if (this.denied) return { error: 'Browser authorization was denied for this run', code: 'PERMISSION_DENIED', reason: this.denied, layer: 'browser_approval', retrySameArguments: false };
      if (!this.authorized && (args.action === 'open' || this.page)) {
        const proposed = args.url !== undefined ? loopbackTarget(String(args.url)).origin : this.origin ?? staticOrigin;
        if (this.origin && proposed !== this.origin) throw new Error('Preview is scoped to its initially approved origin');
        const decision = await confirm?.({ title: 'Проверка локального проекта в браузере', root: this.root, category: 'system_command', actionId,
          detail: `Разрешить браузер проекта ${this.root} для этого запуска и последующего Interactive Preview? Origin: ${proposed}. Только GET, без внешней сети.` }, signal);
        if (!decision?.approved || signal.aborted) {
          this.denied = decision?.reason ?? 'ui_unavailable';
          return { error: 'Project browser authorization denied', code: 'PERMISSION_DENIED', reason: this.denied, layer: 'browser_approval', origin: proposed, projectRoot: this.root, retrySameArguments: false };
        }
        this.authorized = true;
      }
      const waitMs = args.wait_ms ?? 100;
      if (!Number.isInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > 2000) throw new Error('wait_ms must be 0..2000');
      if (['read', 'screenshot', 'qa'].includes(String(args.action)) && this.watcher) { await this.watcher.flush(); await this.refresh(); }
      if (args.action === 'open') {
        if (args.path !== undefined && args.url !== undefined) throw new Error('Choose path or url');
        const url = args.url !== undefined ? loopbackTarget(String(args.url)) : new URL('/' + String(args.path ?? 'index.html').replace(/^\//, ''), staticOrigin);
        if (url.origin !== staticOrigin && args.url === undefined) throw new Error('Invalid project path');
        if (this.origin && this.origin !== url.origin) throw new Error('Preview is scoped to its initial origin for this run');
        const newPage = !this.origin;
        if (!this.origin) {
          this.origin = url.origin;
          this.observer?.state('loading', url.href);
          await this.start();
        }
        this.errors.length = 0; this.blocked.length = 0;
        this.observer?.state('loading', url.href);
        const response = await this.page!.goto(url.href, { waitUntil: 'load' });
        if (response && !response.ok()) throw new Error(`Preview HTTP ${response.status()}`);
        if (newPage) this.qaGuard.reopened(await this.qaState());
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
            if (!await target.evaluate(element => element.matches('input:not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]),textarea') || (element as HTMLElement).isContentEditable === true)) return {error:'fill requires an editable input, textarea or contenteditable element. For Canvas use key, keydown, keyup or hold; never add hidden inputs to simulate keyboard.',code:'NOT_EDITABLE',retrySameArguments:false};
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
        else if (keyboardActions.has(String(args.action))) {
          const [step] = qaSteps([{action:args.action,key:args.key,duration_ms:args.duration_ms,repeat:args.repeat}]);
          await keyboardStep(this.page, step, this.heldKeys);
        } else if (args.action === 'qa') {
          let steps; try { steps=qaSteps(args.checks); } catch(error) { return {error:String(error),code:'INVALID_QA_ARGUMENTS',retrySameArguments:false}; }
          const revision = await projectRevision(this.root, [this.captureDirectory, paths.userData, paths.configDirectory, paths.cache, paths.logs, paths.attachments, join(paths.dataRoot,'sqlite'), join(paths.dataRoot,'protected-runtime.json'), join(paths.dataRoot,'llama-cpp-runtime-state.json')]);
          const key = this.qaGuard.key(revision, this.page.url(), steps, await this.qaState(), this.qaOptions.runtimeIdentity);
          const blocked = this.qaGuard.before(key);
          if (blocked) {
            const qa: BrowserQaReport = { scope:'interaction', id:randomUUID(), runId:this.qaOptions.runId, status:'Blocked', url:this.page.url(), capturedAt:new Date().toISOString(), checks:[], errors:[], captures:[], visual:{analyzed:false,status:'Not Verified',reason:'No new image analysis; previous evidence retained'}, elapsedMs:0, reason:blocked.error, revisionFingerprint:revision, loop:blocked.loop };
            await this.saveQa(qa); this.qaOptions.status?.({phase:'complete',report:qa});
            return { ...blocked, qa };
          }
          this.errors.length = 0; this.blocked.length = 0;
          await this.page.reload({ waitUntil: 'load' });
          const qaSignal = AbortSignal.any([signal, AbortSignal.timeout(90000), ...(this.qaOptions.signal ? [this.qaOptions.signal] : [])]);
          const qa = await runBrowserQa({ page: this.page, signal: qaSignal, steps, errors: () => [...this.errors, ...this.blocked], capture: () => this.capture({}, qaSignal), analyze: this.qaOptions.analyze ? (capture, before) => this.qaOptions.analyze!(capture, qaSignal, before) : undefined, status: this.qaOptions.status });
          qa.runId = this.qaOptions.runId; qa.revisionFingerprint = revision;
          const source = await this.read();
          if (source.source_path) { const bytes = await readPreviewAsset(this.root, new URL(this.page.url()).pathname); qa.sourceFingerprint = screenshotHash(bytes.body); }
          await this.saveQa(qa);
          this.qaGuard.record(key, qa, await this.qaState());
          return { ...source, qa, visual_analysis: qa.visual.analyzed };
        } else if (args.action === 'screenshot') {
          if (this.captures >= 8) throw new Error('Screenshot limit reached (8 explicit screenshots per run; QA captures are independent)');
          this.qaOptions.status?.({phase:'capturing'});
          await this.page.waitForTimeout(Number(waitMs));
          const capture = await this.capture(args, signal);
          this.captures++;
          if (this.qaOptions.analyze) this.qaOptions.status?.({phase:'analyzing'});
          const visual: BrowserVisualResult = this.qaOptions.analyze ? await this.qaOptions.analyze(capture, signal) : { analyzed: false, status: 'Not Verified', reason: 'Browser Vision Off' };
          const qa: BrowserQaReport = { scope:'capture', id:randomUUID(), runId:this.qaOptions.runId, status:visual.analyzed?'Partially Verified':'Not Verified', url:capture.url, capturedAt:capture.capturedAt, checks:[], errors:[...this.errors], captures:[capture], visual, elapsedMs: capture.captureMs!+(visual.latencyMs??0), reason:'Single captured image; no interaction verification in this action' };
          qa.evidencePath=join(this.captureDirectory,`${qa.id}.json`);await writeFile(qa.evidencePath,JSON.stringify(qa,null,2),{flag:'wx',mode:0o600});
          this.qaOptions.status?.({phase:'complete',report:qa});
          return { screenshot_path: capture.path, capture, visual, qa, visual_analysis: visual.analyzed, ...(await this.read()) };
        } else if (args.action !== 'read') throw new Error('Unknown project browser action');
      }
      if (signal.aborted || this.closed) throw new Error('Project browser cancelled');
      await this.page!.waitForTimeout(Number(waitMs));
      this.observer?.state('live', this.page!.url());
      return await this.read();
    } catch (error) {
      // Failed startup cannot leave a half-initialized reusable session.
      const code = String(error).includes('Screenshot limit reached') ? 'SCREENSHOT_LIMIT' : signal.aborted || this.closed ? 'BROWSER_CLOSED_OR_CANCELLED' : !this.page && this.origin ? 'BROWSER_UNAVAILABLE' : 'PROJECT_BROWSER_FAILED';
      if (this.origin && (!this.page || this.page.isClosed())) this.observer?.state('error', undefined, String(error).slice(0, 300));
      if (!this.page && this.origin) await this.close();
      return { error: (error instanceof Error ? error.message : String(error)).slice(0, 4000), code, retrySameArguments: false };
    } finally { await this.ensureWatching(); }
  }
  private async capture(args: Record<string, unknown>, signal: AbortSignal): Promise<BrowserCapture> {
    const captureStarted = performance.now();
    if (!this.page || signal.aborted || this.closed) throw new Error('Capture cancelled');
    const page = this.page, viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    let region = { x: 0, y: 0, ...viewport };
    if (args.selector !== undefined) {
      if (typeof args.selector !== 'string' || args.selector.length > 500) throw new Error('Invalid screenshot selector');
      const box = await page.locator(args.selector).first().boundingBox(); if (!box) throw new Error('Screenshot element is not visible'); region = box;
    } else if (args.clip !== undefined) region = args.clip as typeof region;
    if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > viewport.width || region.y + region.height > viewport.height) throw new Error('Screenshot region must fit the current viewport');
    let bytes = await page.screenshot({ type: 'png', clip: region, scale: 'css', timeout: 10000 });
    if (this.native && region.width * region.height > 1280*900) {
      const { nativeImage } = await import('electron');
      const scale = Math.min(1280/region.width, 900/region.height);
      bytes = nativeImage.createFromBuffer(bytes).resize({ width:Math.max(1,Math.floor(region.width*scale)), height:Math.max(1,Math.floor(region.height*scale)), quality:'good' }).toPNG();
    }
    if (signal.aborted || this.closed) throw new Error('Capture cancelled');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Screenshot exceeds 2 MiB budget');
    await mkdir(this.captureDirectory, { recursive: true, mode: 0o700 });
    const id = randomUUID(), path = join(this.captureDirectory, `${id}.png`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return { ...(this.qaOptions.runId ? {runId:this.qaOptions.runId} : {}), id, path, sha256: screenshotHash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), viewport, region, ...(typeof args.selector === 'string' ? { selector: args.selector } : {}), url: page.url(), capturedAt: new Date().toISOString(), captureMs: performance.now()-captureStarted, bytes: bytes.length };
  }
  private async saveQa(qa: BrowserQaReport) {
    await mkdir(this.captureDirectory, { recursive: true, mode: 0o700 });
    qa.evidencePath = join(this.captureDirectory, `${qa.id}.json`);
    await writeFile(qa.evidencePath, JSON.stringify(qa, null, 2), { flag:'wx', mode:0o600 });
  }
  private async qaState() {
    return this.page!.evaluate(() => ({ url:location.href, viewport:{width:innerWidth,height:innerHeight}, scroll:{x:scrollX,y:scrollY}, focus:document.activeElement?.id || document.activeElement?.tagName, text:document.body.innerText.slice(0,8000), fields:Array.from(document.querySelectorAll('input:not([type=file]),textarea,select')).slice(0,40).map(element => ({ id:element.id, value:(element as HTMLInputElement).value })), diagnostics:JSON.stringify((window as unknown as {__qaDiagnostics?:unknown}).__qaDiagnostics)?.slice(0,4000) }));
  }
  /** One security/asset implementation for native session delivery and CLI CDP routing. */
  private async resource(raw: string, method: string, signal: AbortSignal) {
    const url = new URL(raw);
    if (this.closed || signal.aborted) throw new Error('Project browser cancelled or closed');
    if (Date.now()-this.networkBudget.started > 30000) this.networkBudget = {requests:0,bytes:0,started:Date.now()};
    if (url.origin !== this.origin || url.username || url.password || method !== 'GET' || ++this.networkBudget.requests > 256 || this.networkBudget.bytes > 32 * maxBytes) throw new Error('Outside approved origin, request method or per-operation/30-second request budget');
    const safetyHeaders = {'x-content-type-options':'nosniff','x-dns-prefetch-control':'off'};
    if (this.origin === staticOrigin) {
      const asset = await readPreviewAsset(this.root,url.pathname); this.networkBudget.bytes += asset.body.length;
      return {status:200,body:asset.body,headers:{...safetyHeaders,'content-type':asset.contentType,'content-security-policy':previewCsp}};
    }
    const response = await fetchLoopback(url,AbortSignal.any([signal,this.abort.signal])); this.networkBudget.bytes += response.body.length;
    this.detectServerReload(url.pathname,response.body,Boolean(response.headers['content-type']?.includes('text/html')));
    return {...response,headers:{...response.headers,...safetyHeaders,'content-security-policy':[response.headers['content-security-policy'],previewCsp].filter(Boolean).join(', ')}};
  }
  private async start() {
    this.native = await this.observer?.createPage?.(this.origin!);
    this.browser = this.native?.browser ?? await this.launch();
    if (this.closed) { await this.browser.close(); throw new Error('Project browser cancelled during launch'); }
    this.context = this.native?.context ?? await this.browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await this.context.clearPermissions();
    await this.context.addInitScript(() => { Object.defineProperty(window, 'RTCPeerConnection', { value: undefined, configurable: false }); Object.defineProperty(navigator, 'serviceWorker', {value:undefined,configurable:false}); });
    await this.context.routeWebSocket('**/*', socket => socket.close());
    if (this.native) this.native.handleRequests(async (url, method, signal) => {
      try { return await this.resource(url, method, signal); }
      catch (error) { this.blockedNavigation = true; this.note(this.blocked, `${method} ${url}: ${String(error)}`); throw error; }
    });
    else await this.context.route('**/*', async route => {
      const req = route.request();
      try { await route.fulfill(await this.resource(req.url(), req.method(), this.abort.signal)); }
      catch (error) {
        try { if (req.isNavigationRequest() && req.frame() === this.page?.mainFrame()) this.blockedNavigation = true; } catch { /* A blocked popup can precede frame creation. */ }
        this.note(this.blocked, `${req.method()} ${req.url()}: ${String(error)}`);
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    if (this.closed) { await this.context.close(); throw new Error('Project browser cancelled during setup'); }
    this.page = this.native?.page ?? await this.context.newPage();
    if (this.closed) { await this.context.close(); throw new Error('Project browser cancelled during setup'); }
    await installQaInstrumentation(this.page);
    this.page.on('crash', () => { this.observer?.state('error', undefined, 'Browser renderer crashed'); void this.close(); });
    this.page.on('close', () => { this.stopWatching(); if (!this.closed) this.observer?.state('error', undefined, 'Browser page closed'); });
    this.bindObserver();
    this.browser.on('disconnected', () => { this.stopWatching(); if (!this.closed) this.observer?.state('error', undefined, 'Browser disconnected'); this.observer?.closed(); });
    this.page.setDefaultTimeout(5_000); this.page.setDefaultNavigationTimeout(10_000);
    this.context.on('page', page => { if (page !== this.page) void page.close(); });
    this.page.on('framenavigated', frame => {
      if (frame === this.page?.mainFrame() && frame.url() !== 'about:blank') {
        try { if (new URL(frame.url()).origin === this.origin) { this.lastAllowedUrl = frame.url(); this.blockedNavigation = false; this.observer?.state('live', frame.url()); return; } } catch { /* Unsupported navigation. */ }
        this.note(this.blocked, `Navigation outside approved origin: ${frame.url()}`);
        if (frame.url() === 'chrome-error://chromewebdata/' && this.blockedNavigation && this.lastAllowedUrl && !this.recoveringNavigation) {
          const target = this.lastAllowedUrl; this.blockedNavigation = false; this.recoveringNavigation = true;
          void this.exclusive(async () => {
            if (!this.closed && this.page && !this.page.isClosed()) await this.page.goto(target, { waitUntil: 'load' });
          }).catch(() => this.close()).finally(() => { this.recoveringNavigation = false; });
        } else void this.page?.close();
      }
    });
    this.page.on('pageerror', error => this.note(this.errors, error.message));
    this.page.on('console', message => { if (message.type() === 'error') { this.note(this.errors, message.text()); if (/Content Security Policy/i.test(message.text())) this.note(this.blocked, message.text()); } });
    this.page.on('download', download => { void download.cancel(); });
    this.page.on('dialog', dialog => { void dialog.dismiss(); });
    await this.ensureWatching();
  }
  private async read() {
    const page = this.page!;
    if (new URL(page.url()).origin !== this.origin) throw new Error('Page left approved preview origin');
    const dom = await page.evaluate(() => ({ title: document.title, url: location.href, content: document.body.innerText.slice(0, 12_000), links: Array.from(document.querySelectorAll('a[href]')).slice(0, 40).map(a => ({ text: a.textContent, href: (a as HTMLAnchorElement).href })) }));
    return { ...dom, ...(this.origin === staticOrigin ? { source_path: await projectPath(this.root, decodeURIComponent(new URL(page.url()).pathname).slice(1) || 'index.html') } : {}), javascript_errors: [...this.errors], blocked_requests: [...this.blocked], browser_check: `DOM and runtime diagnostics only; screenshots require separate visual analysis. Display: ${this.native ? 'native Electron WebContentsView (headed), same Page as Live Browser' : 'headless CLI Chromium'}` };
  }
  private closing?: Promise<void>;
  private browserClosing?: Promise<void>;
  private closeBrowser() {
    return this.browserClosing ??= Promise.resolve().then(async () => {
      if (this.native) await this.native.close();
      else { await this.context?.close().catch(() => undefined); await this.browser?.close().catch(() => undefined); }
    });
  }
  close(refresh = false): Promise<void> {
    if (!refresh) {
      this.closed = true; this.stopWatching(); this.abort.abort();
      // Stop can interrupt a pending final refresh instead of waiting behind it.
      if (this.closing) void this.closeBrowser();
    }
    return this.closing ??= Promise.resolve().then(() => this.dispose(refresh));
  }
  private async dispose(refresh: boolean) {
    if (refresh && !this.closed) {
      await this.watcher?.flush();
      await this.exclusive(async () => {
        await this.refresh(true);
      }).catch(error => { if (!this.closed) this.observer?.state('error', undefined, `Auto-reload failed: ${String(error).slice(0, 200)}`); });
    }
    this.closed = true; this.stopWatching(); this.abort.abort(); this.observer?.closed();
    await this.closeBrowser();
  }
}
