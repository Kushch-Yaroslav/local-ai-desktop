import {literalViteOutputs} from '../../shared/vite-build-output';
import { sameBrowserUrl } from '../../shared/browser-url';
import {resolveBrowserAnchor} from '../../shared/browser-anchor';
import {inspectBrowserDom} from './dom-diagnostics';
import {diagnosticStyles} from '../../shared/browser-style';
import {allowedViteSocket,viteClientMessage} from '../../shared/preview-hmr';
import {visualRegionsOverlay} from './visual-regions-overlay';
import {projectVisualRegion,browserProjectionSource} from '../../shared/browser-coordinates';
import { visualPromptUrl } from '../../shared/visual-debugging';
import { inspectResponsive } from './responsive-qa';
import { selectionOverlay, groundRegion } from './visual-selection';
import type { VisualRect, VisualRegion } from '../../shared/visual-debugging';
import type { VisionQuestion } from '../../shared/model-features';
import { installQaInstrumentation, qaSteps, runBrowserQa, screenshotHash, keyboardActions, keyboardStep } from './browser-qa';
import type { BrowserCapture, BrowserQaReport, BrowserQaStatus, BrowserVisualResult } from '../../shared/browser-qa';
import { ProjectFileWatcher } from './project-file-watcher';
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep, join } from 'node:path';
import { log } from '../services/logger';
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
import type { QaCdp } from './browser-scenario-runner';
import { visualLayoutSchema } from './visual-layout-qa';
import { qaScenarios, assertionSchema, qaArgumentFailure } from './browser-scenarios';
import { paths } from '../services/paths';
import { layoutScenario, responsiveOptions, viewportSchema, qaViewport } from './responsive-qa';
import type {VerificationRouteScope} from './verification-route-scope';
import { qaHash, qaScenarioIdentity } from './qa-loop-guard';
import { carryBrowserRoute, sameBrowserRoute, type ManagedPreviewTask } from './managed-preview';

const qaStepSchema = {type:'object',properties:{action:{type:'string',enum:['click','fill','key','keydown','keyup','hold','scroll','focus','mousemove','drag','wait','pointer-lock']},selector:{type:'string'},value:{type:'string'},key:{type:'string'},duration_ms:{type:'integer',minimum:0,maximum:2000},repeat:{type:'integer',minimum:1,maximum:8},x:{type:'number'},y:{type:'number'},to_x:{type:'number'},to_y:{type:'number'},delta_y:{type:'number'},expect:{type:'object',properties:{selector:{type:'string'},text:{type:'string'},value:{type:'string'},changed:{type:'boolean'}},required:['selector'],additionalProperties:false}},required:['action'],additionalProperties:false};
export const projectBrowserTool: ProjectToolDefinition = { type: 'function', function: {
  name: 'web_project',
  description: 'For each additional route explicitly requested by the user, open its URL and inspect/read with supplementary_reason explaining that request, or use its separately registered verification_scope/QA scenario_refs. A route change alone does not scope inspection. Supplementary evidence never verifies the original Region on another route. After a build, preview_status probes the ORIGINAL approved preview HTML and up to four same-origin entry assets without navigation. It does not establish process ownership or verify the defect. Never open dist/index.html on a Vite dev server as a failed-preview fallback. Keep the original route and session; inspect project scripts before considering recovery through existing owned task handles and approvals. Verify a local web project using the application Playwright browser. In Electron it is the visible native WebContentsView shared with the user (headed); only the CLI fallback is headless. Do not infer headless rendering just from Playwright. Use this browser without installing npm packages or launching Chrome in run_terminal. Screenshots capture pixels independently of Vision; set analyze=true for an explicit model image assessment when Vision is allowed. First open a project-relative HTML path (default index.html), or an explicitly approved http://localhost:PORT / http://127.0.0.1:PORT URL. Then read DOM, click a CSS selector (including hash navigation), go back/forward, reload explicitly if needed (Live Browser automatically refreshes ordinary HTML/CSS/JS edits when visible), fill a field, scroll, or capture a screenshot file. Returns JS/console/network errors. Use action qa for bounded real interaction tests and optional actual pixel analysis. For relevant UI checkpoints, responsive:{reason,viewports:[mobile,desktop]} runs isolated DOM geometry checks; omit for backend work and color-only edits. Bound acceptance scenarios specify their own viewport (named profile or width/height) and assertion source=layout, operator=equals, expected=0 for DOM bounds only. Layout candidates need review; absence of DOM defects does not prove Canvas visuals. At most 5 viewports per checkpoint. Optional breakpoint:{minWidth,maxWidth,attempts} performs 2..5 bounded diagnostic probes, without modifying acceptance criteria. Optional responsive.vision=auto analyzes candidates or Canvas only; off retains DOM checks. Never claim physical mobile/iOS testing from desktop Chromium. Visual layout QA uses an explicit viewport and assertion {source:visual_layout,path:coverage|backing|seams,selector,operator:equals,expected:0}. Coverage is only for an explicitly fullscreen target. Seams/backing-scale findings are suspects, never automatic bugs. Optional visual_layout {dpr:1|2,resize:[viewport,viewport],baseline:{report_id,scenario_id},state_key,vision:auto|on|off} captures two frames per size in the isolated QA page. Baselines must match route, viewport, DPR, scroll and scenario conditions. Targeted Vision reviews regions, never certifies all aesthetics. Use at meaningful visual/Canvas/background/height-fix checkpoints, omit for backend work. For Canvas keyboard use key/keydown/keyup/hold with real browser events, never fill(body) or hidden HTML inputs. QA may be repeated after meaningful edits without a fixed lifetime count; unchanged loops return QA_NO_PROGRESS with prior evidence. For deterministic CSS use {action:"inspect",selector:"#sticker"}; it returns bounded computed styles and geometry without arbitrary JS. For formal radius proof use a scenario with assertion {source:"style",selector:"#sticker",path:"border-top-left-radius",operator:"equals",expected:"28px"} at the original viewport. Use text_fit for clipping; screenshots are not a substitute for style metrics. Explicit screenshots have a persisted budget of 8 per logical task, shared across Stop/Continue; region crops, QA captures and live frames are separate. Screenshots alone are not vision. Read vision_input: only response-received establishes a separate image-analysis response; failed/not-sent establishes no visual analysis. Even then the task model receives analysis text, not screenshot pixels. Never claim that you personally saw colors or visually verified pixels from a PNG path. State CSS-based conclusions as inferences from computed CSS. The task receives metadata/path and any explicit Vision analysis text, not PNG pixels. For colors use live inspect. Original region styles are historical; inspect returns CURRENT BROWSER OBSERVATION. A stale CSS Modules hash can be rebound only by unique saved identity; STALE_DOM_ANCHOR is not a current color measurement. QA reports include per-action evidence; fix failures and retest. Declare scenarios with an ID, goal, correct target route/mode, preconditions, required_state, steps, assertion and timeout. Register deliverable acceptance criteria before binding deliverable_id/criterion_id. No automatic WASD or drag is performed. Use hold (300..2000 ms) for frame-based movement. Observe a stable camera/state scalar inside window.__qaDiagnostics or a specific UI value; whole-body text and background pixel animation do not prove controls. For motion supply sample_ms [0,300,800] with a numeric trend assertion; one image cannot prove dynamics. Missing observers/preconditions produce inconclusive/blocked, not an invented failure. Only HTTP loopback previews and project-relative static assets are supported; no external network, file://, POST or arbitrary JS evaluation. Same-origin navigation stays in the approved project. Switching this same Browser to another port requires a ready Vite URL from an owned current-run terminal task, an exact loopback port match and normal approval; other origins keep existing approval/refusal behavior. Vite HMR is restricted to the currently approved origin/port. With web disabled this tool is unavailable.',
  parameters: { type: 'object', properties: { analyze: { type: 'boolean', description: 'For screenshot: explicitly request model image analysis; capture works without Vision.' },
    action: { type: 'string', enum: ['open', 'preview_status', 'inspect', 'read', 'click', 'fill', 'scroll', 'back', 'forward', 'reload', 'screenshot', 'qa', 'key', 'keydown', 'keyup', 'hold'] },
    supplementary_reason: { type: 'string', minLength: 8, maxLength: 240, description: 'Only for additional route diagnostics justified by a shared changed component or an explicit user request. Never counts as verification of a region on another route.' },
    verification_scope:{type:'object',properties:{deliverable_id:{type:'string'},criterion_id:{type:'string'}},required:['deliverable_id','criterion_id'],additionalProperties:false,description:'For inspect/read/screenshot on an additional user-requested route, reference its registered immutable criterion. Its URL and viewport must match. Registered supplementary route criteria are also recognized automatically after navigation. They never verify the original Region. Example: {action:"inspect",selector:"#new-section",verification_scope:{deliverable_id:"route-2",criterion_id:"font-2"}}.'},
    path: { type: 'string', description: 'Project-relative static HTML path; never file://.' },
    url: { type: 'string', description: 'HTTP loopback URL with explicit port. A different origin requires approval; same-project Vite switches also require preview_task_id from a ready current-run managed task.' },
    preview_task_id: { type: 'string', description: 'For switching this Browser to another port, the current-run run_terminal task_id whose registry reports that exact project Vite URL ready. Never use a PID or historical task handle.' },
    selector: { type: 'string', description: 'CSS selector for click, fill or bounded read-only inspect (computed CSS, text and geometry; no private input values).' },
    key: {type:'string',description:'Real keyboard key/combination, e.g. w, Shift+w, q, e. Never use fill(body) for keyboard testing.'},
    duration_ms: {type:'integer',minimum:0,maximum:2000,description:'Hold duration; default 300 ms.'},
    repeat: {type:'integer',minimum:1,maximum:8},
    wait_ms: { type: 'integer', minimum: 0, maximum: 2000, description: 'Optional bounded settling delay before reading or capturing; default 100 ms.' },
    value: { type: 'string', maxLength: 4000, description: 'Text for fill; never a file upload.' },
    delta_y: { type: 'integer', minimum: -2000, maximum: 2000, description: 'Vertical wheel distance for scroll.' },
    clip: { type: 'object', properties: { x: {type:'number'}, y:{type:'number'}, width:{type:'number'}, height:{type:'number'} }, required:['x','y','width','height'], additionalProperties:false },
    checks: {type:'array',maxItems:8,items:qaStepSchema},
    responsive:{type:'object',description:'Use only for relevant UI checkpoints. Omit for backend-only work. Defaults to mobile+desktop DOM inspection; use viewport in immutable scenarios to verify individual criteria. Breakpoint probes are unbound diagnostics, never acceptance evidence.',properties:{reason:{type:'string',maxLength:500},viewports:{type:'array',minItems:1,maxItems:5,items:viewportSchema},vision:{type:'string',enum:['auto','on','off']},breakpoint:{type:'object',properties:{minWidth:{type:'integer',minimum:280,maximum:1920},maxWidth:{type:'integer',minimum:280,maximum:1920},attempts:{type:'integer',minimum:2,maximum:5}},required:['minWidth','maxWidth'],additionalProperties:false}},required:['reason'],additionalProperties:false},
    scenario_refs:{type:'array',maxItems:6,items:{type:'object',properties:{deliverable_id:{type:'string'},criterion_id:{type:'string'}},required:['deliverable_id','criterion_id'],additionalProperties:false},description:'Execute immutable scenario specifications registered in deliverables criteria. The Rust runtime resolves references before calling the browser.'},
    scenarios: {type:'array',maxItems:6,items:{type:'object',properties:{visual_layout:visualLayoutSchema,viewport:viewportSchema,id:{type:'string',maxLength:80},goal:{type:'string',maxLength:1000},target:{type:'string',description:'Project path or same-origin route including hash. Always specify the mode where the claimed behaviour is defined.'},deliverable_id:{type:'string'},criterion_id:{type:'string'},preconditions:{type:'array',maxItems:6,items:assertionSchema},required_state:{type:'array',maxItems:6,items:assertionSchema},steps:{type:'array',maxItems:8,items:qaStepSchema},assertion:assertionSchema,timeout_ms:{type:'integer',minimum:500,maximum:15000}},required:['id','goal','target','preconditions','required_state','steps','assertion','timeout_ms'],additionalProperties:false}},
    deliverable_id:{type:'string',description:'For action=open, only an explicitly declared load criterion can be proven.'},criterion_id:{type:'string'},
    project: { type: 'integer', enum: [1, 2] },
  }, required: ['action'], additionalProperties: false },
} };
export const staticOrigin = 'https://project-preview.invalid';
const responsiveRequest=(args:Record<string,unknown>)=>args.action==='qa'&&(args.responsive!==undefined||Array.isArray(args.scenarios)&&args.scenarios.some(s=>s&&typeof s==='object'&&'viewport' in s));
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
async function isViteClient(target: URL, signal: AbortSignal): Promise<boolean> {
  const client = new URL('/@vite/client', target);
  const response = await fetchLoopback(client, signal);
  const body = response.body.toString('utf8');
  return response.status === 200
    && /javascript|ecmascript/i.test(response.headers['content-type'] ?? '')
    && /createHotContext|vite client/i.test(body);
}
/** Only exact original bytes from an inline dev source map bind a transform. */
export function matchesDevSourceMap(body:Buffer,source:Buffer):boolean {
  const match=body.toString('utf8').match(/sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)\s*$/);
  if(!match||match[1].length>4*1024*1024)return false;
  try{const map=JSON.parse(Buffer.from(match[1],'base64').toString('utf8'));return map.version===3&&Array.isArray(map.sourcesContent)&&map.sourcesContent.length<=32&&map.sourcesContent.some((value:unknown)=>value===source.toString('utf8'));}catch{return false;}
}
// allowSource is for internal source evidence only; static delivery never enables it.
export async function readPreviewAsset(root: string, pathname: string, allowConfiguration = false, allowSource = false): Promise<{ body: Buffer; contentType: string }> {
  const decoded = decodeURIComponent(pathname);
  const parts = decoded.replace(/^\//, '').split('/');
  if (parts.some(part => part.startsWith('.') || part.includes('\\') || part.includes('\0'))) throw new Error('Hidden paths and traversal are blocked');
  const input = parts.join('/') || 'index.html';
  const configuration=allowConfiguration&&/^vite\.config\.[cm]?[jt]s$/.test(input);
  const sourceAsset=allowSource&&['.jsx','.tsx','.ts'].includes(extname(input).toLowerCase());
  const contentType = configuration||sourceAsset?'text/plain':mime[extname(input).toLowerCase()];
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
    if (rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep) || rel.split(sep).some(part => part.startsWith('.')) || !mime[extname(actual).toLowerCase()]&&!configuration&&!sourceAsset) throw new Error('Opened asset escaped preview scope');
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('Preview asset must be a regular file of at most 4 MiB');
    const body = Buffer.alloc(Math.min(maxBytes + 1, info.size + 1));
    const { bytesRead } = await file.read(body, 0, body.length, 0);
    if (bytesRead > maxBytes) throw new Error('Preview asset exceeds limit');
    return { body: body.subarray(0, bytesRead), contentType };
  } finally { await file.close(); }
}

/** Read literal Vite output directories without evaluating project configuration. */
async function viteBuildDirectories(root:string):Promise<string[]>{
  const directories=new Set<string>();let dynamic=false;
  for(const file of ['vite.config.js','vite.config.mjs','vite.config.ts','vite.config.cjs','vite.config.mts','vite.config.cts']){
    try{const config=await readPreviewAsset(root,'/'+file,true),output=literalViteOutputs(config.body.toString('utf8'));
      dynamic ||= output.present;for(const dir of output.directories)directories.add(dir);
    }catch{/* Missing, unsupported or out-of-scope configuration is never executed. */}
  }
  return directories.size?[...directories]:dynamic?[]:['dist'];
}
async function devBuildPath(root:string,pathname:string):Promise<boolean>{
  const directories=new Set(['dist','build',...await viteBuildDirectories(root)]);
  const path=decodeURIComponent(pathname).replace(/^\//,'');
  return [...directories].some(dir=>path===dir+'/index.html'||path===dir+'/');
}

export type ProjectQaOptions = { routeScopes?:()=>VerificationRouteScope[]; takeScreenshot?:()=>boolean; regionContext?:Array<{id:string;groupId:string;url:string;selectors?:string[];anchors?:Array<Pick<VisualRegion['anchors'][number],'selector'|'tag'|'identity'>>;viewport?:{width:number;height:number};dpr?:number;scroll?:{x:number;y:number};rect?:VisualRect;surroundings?:VisualRegion['surroundings']}>; projectId?:string; securityMode?:'strict'|'autonomous'; runId?: string; guard?: QaLoopGuard; runtimeIdentity?: unknown; resolveManagedPreview?:(taskId:string,targetUrl:string,root:string)=>ManagedPreviewTask|undefined; analyze?: (capture: BrowserCapture, signal: AbortSignal, before?: BrowserCapture, scenario?: VisionQuestion) => Promise<BrowserVisualResult>; status?: (status: BrowserQaStatus) => void; signal?: AbortSignal };
export class ProjectBrowserSession {
  private browser?: Browser;
  private native?: NativeProjectPage;
  private context?: BrowserContext;
  private page?: Page;
  private origin?: string;
  private lastManagedSwitch?: {fromOrigin:string;toOrigin:string;taskId:string;runId:string;at:string;routePreserved:boolean};
  private lastAllowedUrl?: string;
  private blockedNavigation = false;
  private recoveringNavigation = false;
  private navigationRecoveryUsed=false;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly errors: string[] = [];
  private readonly blocked: string[] = [];
  private networkBudget = { requests:0, bytes:0, started:Date.now() };
  private captures = 0;
  private readonly servedRevisions = new Map<string,string>();
  private readonly fallbackGuard = new QaLoopGuard();
  private get qaGuard() { return this.qaOptions.guard ?? this.fallbackGuard; }
  private ownership: 'agent' | 'user' | 'paused' = 'agent';
  private authorized = false;
  private previewApproved=false;
  private userSession=false;
  private operationAbort?: AbortController;
  get userManaged(){return this.userSession;}
  get currentUrl(){return this.page&&!this.page.isClosed()?this.page.url():undefined;}
  preserveForUser(){this.userSession=true;}
  async policyChanged(){
    this.authorized=false;this.denied=undefined;this.operationAbort?.abort();
    await this.exclusive(async()=>{await this.clearSelection();await this.releaseInput();if(this.reusable){this.ownership='user';this.observer?.ownership?.('user');this.refreshVisualDisplaySoon();}});
  }
  private denied?: string;
  private readonly heldKeys = new Set<string>();
  private responsiveSession?: ProjectBrowserSession;
  private queuedInputs = 0;
  readonly sessionId=randomUUID();
  endReason='not-opened';
  get reusable() { return !this.closed && Boolean(this.page && !this.page.isClosed() && this.browser?.isConnected()); }
  get stateIdentity(){return {id:this.sessionId,usable:this.reusable,origin:this.origin,reason:this.endReason};}
  recoveryRequest(args:Record<string,unknown>):Record<string,unknown> {
    if(args.url!==undefined&&loopbackTarget(String(args.url)).origin!==this.origin)throw new Error('Recovery cannot change the approved preview origin');
    return this.origin&&this.origin!==staticOrigin&&args.url===undefined?{...args,path:undefined,url:new URL('/'+String(args.path??'index.html').replace(/^\//,''),this.origin).href}:args;
  }
  private runPreviewUrl?:string;
  beginRun(observer: ProjectBrowserObserver, qaOptions: ProjectQaOptions = {}) {
    void this.clearSelection();
    this.runPreviewUrl = this.page?.url();
    this.qaOptions = qaOptions;
    if (!qaOptions.guard) this.fallbackGuard.rearm();
    this.authorized = false; this.denied = undefined; this.observer = observer;
    if (this.page) this.bindObserver();
  }
  async finishRun(refresh = true) {
    if (refresh) await this.exclusive(async () => {
      // Supplementary verification must not strand the user's existing Page on another route.
      // No reload on Stop, and no navigation to a server whose original HTML cannot respond.
      const original=this.runPreviewUrl;
      if(this.userSession&&this.qaOptions.regionContext?.length&&original&&this.page&&!sameBrowserUrl(original,this.page.url())&&new URL(original).origin===this.origin){
        const response=this.origin===staticOrigin?undefined:await fetchLoopback(loopbackTarget(original),AbortSignal.timeout(3000));
        if(response&&(response.status<200||response.status>=300||!(response.headers['content-type']??'').includes('text/html')))throw new Error('Original preview unavailable; current Page retained');
        await this.page.goto(original,{waitUntil:'load',timeout:5000});
      }
      await this.watcher?.flush(); await this.refresh(true);
    }).catch(error=>{if(!this.closed)this.observer?.state('error',undefined,`Preview refresh failed; reopen the approved URL: ${String(error).slice(0,200)}`);});
    if (!this.reusable || !this.previewApproved) { await this.close(); return; }
    await this.releaseInput();
    this.ownership = 'user'; this.observer?.ownership?.('user');this.refreshVisualDisplaySoon();
  }
  async pauseRun() { await this.clearSelection(); this.ownership = this.userSession?'user':'paused'; await this.releaseInput(); this.observer?.ownership?.(this.ownership);this.refreshVisualDisplaySoon(); }
  private bindObserver() {
    this.observer?.ready(this.page!, visible => { this.previewVisible = visible; this.scheduleRefresh(); }, { input: input => this.input(input), suspend:()=>this.clearSelection(), policyChanged:()=>this.policyChanged(), close: reason => this.close(false,reason??'user_closed') });
    this.observer?.ownership?.(this.ownership);this.refreshVisualDisplaySoon();
  }
  private displayedRegions:VisualRegion[]=[];
  private displayEnabled=true;
  private displaySelected:string[]=[];
  private displayState:import('../../shared/visual-debugging').VisualDisplayState={visible:true,bindings:[]};
  private displayTimer?:ReturnType<typeof setInterval>;
  private displayWork?:Promise<void>;
  private displayRevision=0;
  private feedback(kind:'pending'|'saved'|'error',regionId?:string,detail?:string){this.displayState.feedback={kind,regionId,detail,at:Date.now()};this.observer?.visual?.(this.displayState.feedback);}
  get visualDisplayState(){return this.displayState;}
  async visualDisplay(regions:VisualRegion[]=this.displayedRegions,enabled=this.displayEnabled,selected=this.displaySelected){
    if(JSON.stringify([this.displayedRegions,this.displayEnabled,this.displaySelected])!==JSON.stringify([regions,enabled,selected]))this.displayRevision++;
    this.displayedRegions=[...regions];this.displayEnabled=enabled;this.displaySelected=selected.filter(id=>regions.some(r=>r.id===id));
    this.displayState.visible=enabled;
    await this.refreshVisualDisplay();
    if(!this.displayTimer&&regions.length){this.displayTimer=setInterval(()=>this.refreshVisualDisplaySoon(),200);this.displayTimer.unref();}
    if(!regions.length){clearInterval(this.displayTimer);this.displayTimer=undefined;}
    return this.displayState;
  }
  private refreshVisualDisplaySoon():void {
    void this.refreshVisualDisplay().catch(error=>{
      if(!this.reusable)return;
      // Navigation replaces the execution world while this best-effort paint
      // can still be queued. Never leave an old agent shield box on the new DOM.
      this.native?.highlight?.([]);
      this.displayState.bindings=this.displayState.bindings.map(binding=>({...binding,stale:true,reason:'dom-not-ready'}));
      if(/Execution context was destroyed|Cannot find context with specified id|Target page, context or browser has been closed/.test(String(error)))return;
      this.observer?.state('error',undefined,`Visual overlay refresh failed: ${String(error).slice(0,200)}`);
    });
  }
  private refreshVisualDisplay():Promise<void>{
    if(this.displayWork)return this.displayWork;
    if(!this.page||this.page.isClosed()||this.closed)return Promise.resolve();
    this.displayWork=(async()=>{for(let attempt=0;attempt<2;attempt++){
      const revision=this.displayRevision,page=this.page;if(!page||page.isClosed()||this.closed)return;
      const state=await visualRegionsOverlay(page,this.displayedRegions,this.displayEnabled,this.displaySelected,this.ownership==='user');
      this.displayState.bindings=state.bindings;if(this.ownership!=='user')this.native?.highlight?.(this.displayEnabled?state.boxes:[]);
      if(revision===this.displayRevision)break;
    }})().finally(()=>{this.displayWork=undefined;});return this.displayWork;
  }
  private selectionActive = false;
  get visualSelecting(){return this.selectionActive;}
  private selectionBound = false;
  private visualEpoch = 0;
  private selectionCallback?: (region: VisualRegion) => Promise<void>;
  private selectionRegions: VisualRegion[] = [];
  private selectionGroup = 'group-1';
  async visualSelection(enabled: boolean, regions: VisualRegion[], callback?: (region: VisualRegion) => Promise<void>, groupId='group-1') {
    return this.exclusive(async () => {
      if (!this.reusable || this.ownership !== 'user') throw new Error('Visual Selection requires user ownership');
      const page=this.page!;
      await this.clearSelection();if(enabled)this.preserveForUser();
      if (!this.selectionBound) {
        await page.exposeBinding('__ladRegionSelect', async (source, rect: VisualRect|null) => {
          if (source.page!==page || source.frame!==page.mainFrame() || !this.selectionActive || this.ownership!=='user') return;
          if(rect===null){await this.clearSelection();return;}
          await this.exclusive(async () => {
            if(!this.selectionActive || this.ownership!=='user')return;
            this.feedback('pending');
            try{const region=await this.visualCapture(rect,this.selectionGroup);
              if(!this.selectionCallback)throw new Error('Selection cancelled before saving');
              await this.selectionCallback(region);this.selectionRegions.push(region);
              this.feedback('saved',region.id);return {id:region.id};
            }catch(error){this.feedback('error',undefined,String(error));throw error;}
          });
        });
        this.selectionBound=true;
      }
      this.selectionActive=enabled;this.selectionCallback=callback;this.selectionRegions=[...regions];this.selectionGroup=groupId;
      await selectionOverlay(page,enabled,regions);
    });
  }
  private async clearSelection() {
    this.visualEpoch++;this.selectionRegions=[];this.selectionActive=false;this.selectionCallback=undefined;this.native?.highlight?.([]);
    if(this.page&&!this.page.isClosed())await this.page.evaluate(()=>document.getElementById('__lad-visual-highlight')?.remove()).catch(()=>undefined);
    if(this.page&&!this.page.isClosed())await selectionOverlay(this.page,false).catch(()=>undefined);
  }
  private async visualCapture(rect: VisualRect, groupId: string): Promise<VisualRegion> {
    const page=this.page!;
    if(!rect || !['x','y','width','height'].every(key=>Number.isFinite(rect[key as keyof VisualRect])) || rect.x<0 || rect.y<0 || rect.width<4 || rect.height<4 || rect.width>4096 || rect.height>4096)throw new Error('Invalid selection bounds');
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    rect={x:Math.min(rect.x,viewport.width),y:Math.min(rect.y,viewport.height),width:Math.min(rect.width,Math.max(0,viewport.width-rect.x)),height:Math.min(rect.height,Math.max(0,viewport.height-rect.y))};
    if(rect.width<4||rect.height<4)throw Error('Selection does not intersect the approved viewport');
    const evidence=await groundRegion(page,rect);
    if(new URL(evidence.url).origin!==this.origin || rect.x+rect.width>evidence.viewport.width+1 || rect.y+rect.height>evidence.viewport.height+1)throw new Error('Selection outside approved viewport');
    const id='region-'+randomUUID();
    const workspace=this.native?.workspaceState?.();
    const region:VisualRegion={...evidence,...(workspace?{presentation:{browserZoom:workspace.browserZoom,displayScale:workspace.displayScale,deviceScaleFactor:workspace.deviceScaleFactor}}:{}),sourceHints:Array.from(this.servedRevisions).slice(0,12).map(([path,sha256])=>({path,sha256})),id,conversationId:'',projectId:this.qaOptions.projectId??'',projectRoot:this.root,groupId,createdAt:new Date().toISOString()};
    await mkdir(this.captureDirectory,{recursive:true,mode:0o700});
    const path=join(this.captureDirectory,id+'.png');
    // All editable controls are masked; selector frames must never enter evidence.
    await page.evaluate(()=>{const host=document.getElementById('__lad-visual-selection');if(host)host.style.visibility='hidden';});
    try {
      const bytes=await this.privacyCapture(async()=>this.native?.captureCss?this.native.captureCss(evidence.rect,evidence.dpr):page.screenshot({type:'png',clip:evidence.rect,scale:'css',timeout:10000,mask:[page.locator('input,textarea,select,[contenteditable],[data-private],[data-sensitive]')]}));
      await writeFile(path,bytes,{mode:0o600});region.screenshotPath=path;region.crop={width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),space:this.native?'native-presentation':'css'};
    } catch { region.diagnostics.push('Crop unavailable; DOM evidence retained'); }
    finally{await page.evaluate(()=>{document.getElementById('__lad-capture-mask')?.remove();const host=document.getElementById('__lad-visual-selection');if(host)host.style.visibility='';}).catch(()=>undefined);}
    return region;
  }
  async visualGround(regions:VisualRegion[]):Promise<VisualRegion[]>{
    if(!this.reusable||!this.page)return regions;
    const safe=regions.filter(r=>r.projectRoot===this.root).map(r=>({id:r.id,url:r.url,rect:r.rect,viewport:r.viewport,dpr:r.dpr,snapshot:r.snapshot,anchors:r.anchors.map(a=>({tag:a.tag,selector:a.selector,confidence:a.confidence,rect:a.rect,identity:a.identity,text:a.text}))}));
    const inspect=(regions:VisualRegion[],project:typeof projectVisualRegion)=>regions.map(r=>{const result=project(r);return {id:r.id,live:{url:location.href,viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,scroll:{x:scrollX,y:scrollY},...result,observedAt:new Date().toISOString()}};});
    const results=await this.page.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})(${JSON.stringify(safe)},${browserProjectionSource()})`);
    return regions.map(r=>({...r,live:results.find(result=>result.id===r.id)?.live}));
  }
  async visualReveal(region: VisualRegion, siblings: VisualRegion[]=[region]) {
    const page=this.page;
    if(!this.reusable||!page||region.projectRoot!==this.root)throw new Error('Region outside current preview scope');
    const epoch=this.visualEpoch;
    const currentUrl=page.url(),needsNavigation=!sameBrowserUrl(currentUrl,region.url);
    const view={regionId:region.id,url:region.url,currentUrl,needsNavigation,stale:false,reason:undefined as string|undefined,screenshotOnly:!region.anchors.length,scrollDeferred:this.ownership!=='user'||Boolean(this.operationAbort),diagnostics:[] as string[]};
    if(needsNavigation){view.diagnostics.push('Region belongs to another route; explicit navigation is required');return view;}
    // While the agent owns the page, read geometry without scrolling or changing its DOM.
    const data={region,siblings,scroll:!view.scrollDeferred};
    // Pass only safe page geometry, never host paths or source file contents.
    const safe=(r:VisualRegion)=>({id:r.id,url:r.url,rect:r.rect,viewport:r.viewport,dpr:r.dpr,snapshot:r.snapshot,color:r.color,groupNumber:r.groupNumber,anchors:r.anchors.map(a=>({tag:a.tag,confidence:a.confidence,selector:a.selector,rect:a.rect,identity:a.identity,text:a.text}))});
    const inspect=({region,siblings,scroll}:typeof data,project:typeof projectVisualRegion)=>{
      const before=project(region);
      if(scroll&&!before.stale){const anchor=region.anchors.find(a=>a.confidence>=.8);if(anchor)document.querySelector(before.selector??anchor.selector)?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});else scrollTo(region.rect.x,Math.max(0,region.rect.y-innerHeight/3));}
      return {stale:before.stale,reason:before.reason,url:location.href,boxes:siblings.flatMap(r=>{const result=project(r);return result.rect?[{...result.rect,color:r.color??'#22d3ee',label:`${r.groupNumber??''} · #${r.id}`}]:[];})};
    };
    const result=await page.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})(${JSON.stringify({region:safe(region),siblings:siblings.map(safe),scroll:data.scroll})},${browserProjectionSource()})`);
    if(!sameBrowserUrl(result.url,region.url)){view.currentUrl=result.url;view.needsNavigation=true;view.diagnostics.push('The page changed while viewing; no original-route claim was made');return view;}
    if(epoch!==this.visualEpoch)return {...view,stale:true,diagnostics:['Selection changed while viewing; highlight cancelled']};
    view.stale=result.stale;view.reason=result.reason;
    if(result.stale)view.diagnostics.push('Anchor stale: '+result.reason+'. Original crop only; live coordinates were not drawn.');
    if(result.boxes[0])await this.native?.revealCss?.(result.boxes[0]);
    if(epoch!==this.visualEpoch)return {...view,stale:true,reason:'selection-changed',diagnostics:['Selection changed while focusing; highlight cancelled']};
    await this.visualDisplay(this.displayedRegions.length?this.displayedRegions:siblings,true,[region.id]);
    if(view.scrollDeferred)view.diagnostics.push('Agent owns navigation; document scrolling is deferred. Presentation pan and shield annotations remain available.');
    return view;
  }
  async visualNavigate(region: VisualRegion){
    await this.exclusive(async()=>{if(this.ownership!=='user'||!this.page||region.projectRoot!==this.root||new URL(region.url).origin!==this.origin)throw new Error('Region outside current preview scope');await this.clearSelection();if(!sameBrowserUrl(this.page.url(),region.url))await this.page.goto(region.url,{waitUntil:'load'});});
    return this.visualReveal(region);
  }
  get visualWorkspace(){return this.native?.workspaceState?.()?.settings;}
  async visualRecheck(regions:VisualRegion[]):Promise<BrowserQaReport>{
    return this.exclusive(async()=>{
      if(this.ownership!=='user'||!this.page||!this.reusable)throw new Error('Recheck requires user ownership');
      if(!regions.length||regions.length>6)throw new Error('Recheck supports one to six selections');
      const first=regions[0],page=this.page;
      if(regions.some(r=>r.projectRoot!==this.root||new URL(r.url).origin!==this.origin||!sameBrowserUrl(r.url,first.url)||r.viewport.width!==first.viewport.width||r.viewport.height!==first.viewport.height))throw new Error('Recheck requires one approved route and original viewport');
      for(const r of regions){const a=r.anchors[0];if(!a||a.confidence<.8||!a.findings?.some(f=>['text-clipping','horizontal-overflow','vertical-overflow'].includes(f.category)))throw new Error('Recheck supports DOM text fitting candidates only');}
      const saved=this.native?.workspaceState?.()?.settings;
      const originalWorkspace=saved?structuredClone(saved):undefined,originalViewport=page.viewportSize();
      const controller=new AbortController();this.operationAbort=controller;
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
      await this.clearSelection();
      this.ownership='paused';this.observer?.action({kind:'region-recheck',at:Date.now()});this.observer?.ownership?.('paused');
      try{
        const setViewport=async(viewport:{width:number;height:number})=>{
          signal.throwIfAborted();
          if(this.native&&originalWorkspace)await this.native.workspace({...originalWorkspace,viewport:{width:Math.round(viewport.width*(originalWorkspace.zoom??this.native.contents.getZoomFactor())),height:Math.round(viewport.height*(originalWorkspace.zoom??this.native.contents.getZoomFactor()))}});
          else await page.setViewportSize(viewport);
        };
        const navigate=async(target:string)=>{
          signal.throwIfAborted();
          if(target!==first.url||new URL(target).origin!==this.origin)throw new Error('Recheck target outside original scope');
          let response=await page.goto(target,{waitUntil:'load',timeout:10000});
          // Chromium can treat the same hash URL as same-document navigation. Fresh
          // assets and their source revisions are required for a new verification.
          if(!response)response=await page.reload({waitUntil:'load',timeout:10000});
          if(response&&[401,403].includes(response.status()))return {authRequired:true};
          if(response&&!response.ok())throw new Error('Recheck preview response '+response.status());
          await page.waitForFunction(()=>document.fonts.status==='loaded',{},{timeout:3000});
          signal.throwIfAborted();
          for(const r of await this.visualGround(regions.map(r=>({...r,anchors:r.anchors.map(a=>({...a,identity:a.identity??{text:a.text,context:''}}))}))))if(r.live?.stale)throw new Error('Recheck anchor unavailable: '+r.live.reason);
          return {};
        };
        await setViewport(first.viewport);
        this.observer?.state('loading',first.url);this.errors.length=0;this.blocked.length=0;this.servedRevisions.clear();
        if((await navigate(first.url)).authRequired)throw new Error('Recheck requires authentication');
        const revision=await projectRevision(this.root,[this.captureDirectory,paths.dataRoot]);
        const scenarios=regions.map((r,index)=>({id:'region-recheck-'+index,goal:'Original region text fits its rendered bounds',target:r.url,viewport:r.viewport,preconditions:[],required_state:[],steps:[],assertion:{source:'text_fit' as const,selector:r.anchors[0].selector,operator:'equals' as const,expected:0},timeout_ms:5000}));
        const qa=await runBrowserQa({page,signal,steps:[],scenarios,setViewport,navigate,errors:()=>[...this.errors,...this.blocked],sourceRevisions:()=>Object.fromEntries(this.servedRevisions),capture:cdp=>this.capture({},signal,cdp),metrics:()=>this.qaMetrics()});
        signal.throwIfAborted();
        qa.sourceRevisions=Object.fromEntries(this.servedRevisions);qa.revisionFingerprint=revision;
        if(await this.revisionsChanged(qa.sourceRevisions)||await projectRevision(this.root,[this.captureDirectory,paths.dataRoot])!==revision){qa.status='Not Verified';qa.functionalStatus='Not Verified';qa.reasonCode='EVIDENCE_STALE';qa.reason='Source changed during verification';for(const result of qa.scenarios??[])result.status='Not Verified';}
        await this.saveQa(qa);return qa;
      }finally{
        if(this.operationAbort===controller)this.operationAbort=undefined;
        try{
          if(this.reusable){if(this.native&&originalWorkspace)await this.native.workspace(originalWorkspace);else if(originalViewport)await page.setViewportSize(originalViewport);}
        }finally{
          this.ownership='user';this.observer?.ownership?.('user');
          if(!page.isClosed())this.observer?.state(page.url().startsWith('chrome-error:')?'error':'live',page.url());
          await this.refreshVisualDisplay();
        }
      }
    });
  }
  async visualDetect(): Promise<VisualRegion[]> {
    return this.exclusive(async()=>{
      if(this.ownership!=='user'||!this.page)throw new Error('Detection requires user ownership');
      await this.clearSelection();
      const inspection=await inspectResponsive(this.page);
      const regions:VisualRegion[]=[];
      for(const finding of inspection.findings.filter(f=>f.rect).slice(0,12)) {
        const b=finding.rect!,x=Math.max(0,b.x),y=Math.max(0,b.y);
        const rect={x,y,width:Math.min(b.x+b.width,inspection.viewport.width)-x,height:Math.min(b.y+b.height,inspection.viewport.height)-y};
        if(rect.width<4||rect.height<4)continue;
        const region=await this.visualCapture(rect,'auto-'+randomUUID().slice(0,8));const anchor=region.anchors[0];
        if(anchor?.classes?.length){region.groupId='auto-'+screenshotHash(Buffer.from(finding.kind+':'+anchor.tag+':'+anchor.classes.join('.'))).slice(0,8);region.diagnostics.push('Shared tag/class candidate group; common source component remains unconfirmed');}
        region.diagnostics.push(`Responsive QA candidate: ${finding.kind}: ${finding.detail}`);regions.push(region);
      }
      return regions;
    });
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
      if (input.kind === 'pointer' && ['down', 'up', 'move'].includes(input.phase) && bounded(input.x, 4096) && bounded(input.y, 4096) && input.x >= 0 && input.y >= 0) {
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
  private viteManaged = false;
  private sourceChangedAt=0;
  private loadedAt=0;
  private freshnessTimer?:ReturnType<typeof setTimeout>;
  private async freshness(){
    const applied=await this.page?.evaluate(()=>Number((window as unknown as {__ladHmrAt?:number}).__ladHmrAt??0)).catch(()=>0)??0;
    const value={status:!this.sourceChangedAt?'unknown' as const:Math.max(applied,this.loadedAt)>=this.sourceChangedAt?'updated' as const:'possibly-stale' as const,origin:this.origin,sourceChangedAt:this.sourceChangedAt,hmrAppliedAt:applied,loadedAt:this.loadedAt,observedAt:Date.now()};
    this.observer?.freshness?.(value);return value;
  }
  private autoReloadQueued = false;
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
  private stopWatching() { this.watcher?.close(); this.watcher = undefined; clearTimeout(this.reloadTimer);clearTimeout(this.freshnessTimer); this.dirty = false; }
  private async ensureWatching() {
    if (this.isolatedQa || !this.observer || this.watcher || this.closed || !this.page || this.page.isClosed()) return;
    const outputs=this.viteManaged?await viteBuildDirectories(this.root):[];
    if(this.watcher||this.closed)return;
    this.watcher = new ProjectFileWatcher(this.root, at => { this.sourceChangedAt=at;this.dirty = true;if(this.serverManaged){clearTimeout(this.freshnessTimer);this.freshnessTimer=setTimeout(()=>{void this.freshness();},1200);}else this.scheduleRefresh(); }, error => this.observer?.state('error', undefined, `Auto-reload unavailable: ${String(error).slice(0, 200)}`),outputs);
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
    if(new URL(this.page.url()).origin!==this.origin){this.observer?.state('error',undefined,'Preview navigation failed; reopen the approved project URL.');return;}
    this.navigationRecoveryUsed=false;
    const response = await this.page.reload({ waitUntil: 'load' });
    if (response && !response.ok()) throw new Error(`Preview HTTP ${response.status()}`);
    // Let the real page settle before reporting the refreshed revision.
    if(this.closed||this.page.isClosed())return;
    await this.page.waitForTimeout(150);
    if (!this.closed) { this.observer?.action({ kind: 'auto-reload', at: Date.now() }); this.observer?.state('live', this.page.url()); }
  }
  private async detectServerReload(path: string, body: Buffer, html: boolean) {
    if (this.origin === staticOrigin || this.serverManaged) return;
    if (/^\/(?:@vite\/client|@react-refresh|_next\/|__webpack_hmr)/.test(path) || (html && /(?:\/@vite\/client|\/_next\/|__NEXT_DATA__|webpack-dev-server|webpack-hot-middleware|parcelRequire.*hmr)/i.test(body.toString('utf8')))) {
      this.viteManaged=path==='/@vite/client'||html&&body.includes('/@vite/client');
      this.serverManaged = true;this.native?.hmr?.(true);
      if(this.viteManaged)await this.watcher?.ignoreOutputs(await viteBuildDirectories(this.root));
    }
  }
  constructor(private readonly root: string, private readonly captureDirectory: string, private readonly launch: () => Promise<Browser> = launchWebBrowser, private observer?: ProjectBrowserObserver, private qaOptions: ProjectQaOptions = {}, private readonly isolatedQa=false) {}
  private note(list: string[], text: string) { if (list.length < 40) list.push(text.replace(/([?&](?:token|access_token|secret|password|session|api_key)=)[^\s&#"'<>]+/gi,'$1[redacted]').slice(0, 500)); }
  async execute(args: Record<string, unknown>, signal: AbortSignal, confirm?: ConfirmAction, actionId: string = randomUUID()): Promise<unknown> {
    await this.clearSelection();
    const isolated=responsiveRequest(args)&&!this.isolatedQa&&Boolean(this.page);
    if(signal.aborted)return {error:'Browser operation cancelled',code:'BROWSER_OPERATION_CANCELLED',retrySameArguments:false,browser_session:this.stateIdentity};
    const controller=new AbortController();this.operationAbort=controller;
    const cancel = () => { controller.abort();if(!isolated&&!this.userSession)void this.close(false,'operation_cancelled');else {void this.releaseInput();void this.native?.contents.debugger.sendCommand('Page.stopLoading').catch(()=>undefined);} };
    signal.addEventListener('abort', cancel, { once: true });
    const operationSignal = AbortSignal.any([signal, this.abort.signal,controller.signal]);
    const operation=()=>{this.authorized=false;this.navigationRecoveryUsed=false;return this.executePage(args,operationSignal,confirm,actionId);};
    try { return await (isolated&&this.page?operation():this.exclusive(operation)); }
    finally { signal.removeEventListener('abort', cancel);if(this.operationAbort===controller)this.operationAbort=undefined; }
  }
  private async executePage(args: Record<string, unknown>, signal: AbortSignal, confirm: ConfirmAction | undefined, actionId: string): Promise<unknown> {
    try {
      let pendingManagedSwitch:{fromOrigin:string;toOrigin:string;taskId:string;runId:string;at:string;routePreserved:boolean}|undefined;
      this.networkBudget = { requests:0, bytes:0, started:Date.now() };
      if (signal.aborted || this.closed || this.page?.isClosed() || this.browser&&!this.browser.isConnected())return {error:'Project browser is unavailable; open it explicitly in an authorized new task, or recreate a lost connection.',code:signal.aborted&&!this.closed?'BROWSER_OPERATION_CANCELLED':'BROWSER_SESSION_UNAVAILABLE',retrySameArguments:!signal.aborted&&['connection_lost','page_closed','renderer_crashed'].includes(this.endReason),browser_session:this.stateIdentity};
      const references=this.qaOptions.regionContext??[];
      const expected=references.map(r=>r.url),current=this.page?.url();
      if((references.length||args.verification_scope!==undefined)&&['inspect','read','screenshot','qa'].includes(String(args.action))&&current){
        const supplementary=typeof args.supplementary_reason==='string'&&args.supplementary_reason.trim().length>=8&&args.supplementary_reason.length<=240;
        const scopes=(this.qaOptions.routeScopes?.()??[]).filter(scope=>!references.some(r=>r.groupId===scope.deliverable_id));
        const requested=args.verification_scope as {deliverable_id?:string;criterion_id?:string}|undefined;
        const selected=requested?scopes.find(scope=>scope.deliverable_id===requested.deliverable_id&&scope.criterion_id===requested.criterion_id):undefined;
        if(requested&&!selected)return {code:'UNCONFIRMED_VERIFICATION_SCOPE',error:'verification_scope must reference a registered supplementary criterion for this project. Register a separate deliverable with source paths, target and viewport; do not reuse the original Region deliverable.',retrySameArguments:false};
        const matchesOriginal=(url:string,target:string)=>sameBrowserUrl(url,target)||Boolean(this.lastManagedSwitch&&new URL(url).origin===this.lastManagedSwitch.fromOrigin&&new URL(target).origin===this.lastManagedSwitch.toOrigin&&sameBrowserRoute(url,target));
        const matchesScope=(target:string,viewport:{width:number;height:number},binding?:{deliverable_id?:string;criterion_id?:string})=>scopes.some(scope=>{
          const resolved=new URL(scope.target,current);return resolved.origin===this.origin&&sameBrowserUrl(resolved.href,target)&&scope.viewport.width===viewport.width&&scope.viewport.height===viewport.height&&(!selected||scope===selected)&&(!binding||scope.deliverable_id===binding.deliverable_id&&scope.criterion_id===binding.criterion_id);
        });
        const viewport=await this.page!.evaluate(()=>({width:innerWidth,height:innerHeight}));
        let mismatch=!supplementary&&!expected.some(url=>matchesOriginal(url,current))&&!matchesScope(current,viewport);
        if(requested&&!matchesScope(current,viewport))mismatch=true;
        if(args.action==='qa'&&Array.isArray(args.scenarios))for(const scenario of args.scenarios){
          const target=new URL(scenario.target,current).href,original=references.filter(r=>r.groupId===scenario.deliverable_id);
          if(original.length){if(!original.some(r=>matchesOriginal(r.url,target)))mismatch=true;}
          else if(!supplementary&&!expected.some(url=>matchesOriginal(url,target))){try{if(!matchesScope(target,qaViewport(scenario.viewport),scenario))mismatch=true;}catch{mismatch=true;}}
        }
        if(mismatch)return {error:'REGION_ROUTE_MISMATCH: this URL/viewport is outside the original Region and registered supplementary route criteria. For an explicitly requested additional route, register its own deliverable criterion (source paths, target, viewport), then inspect using verification_scope:{deliverable_id,criterion_id} or run qa with scenario_refs. For bounded unbound diagnostics supply supplementary_reason explaining the user request/shared change. Original Region proof still requires its saved URL/viewport. Do not repeat unchanged arguments.',code:'REGION_ROUTE_MISMATCH',current_url:visualPromptUrl(current),region_urls:expected.map(visualPromptUrl),correction_template:{action:args.action,...(typeof args.selector==='string'?{selector:args.selector}:{}),...(args.project===1||args.project===2?{project:args.project}:{}),...(args.action==='qa'?{scenario_refs:[{deliverable_id:'<separate-route-deliverable>',criterion_id:'<registered-criterion>'}]}:{}),supplementary_reason:'REPLACE with the actual user-requested route or shared-component relationship; diagnostic only, not original Region proof'},supplementary_criteria:scopes.map(scope=>({...scope,target:visualPromptUrl(new URL(scope.target,current).href)})),retrySameArguments:false};
      }
      if (!keyboardActions.has(String(args.action))&&(!responsiveRequest(args)||this.isolatedQa)) await this.releaseInput();
      if (args.action === 'qa' && (!this.page || !responsiveRequest(args)&&(args.path !== undefined || args.url !== undefined)) && !this.denied) {
        const opened = await this.executePage({action:'open', ...(args.path ? {path:args.path} : {}), ...(args.url ? {url:args.url} : {})}, signal, confirm, actionId);
        if (opened && typeof opened === 'object' && 'error' in opened) return opened;
      }
      if (this.denied) return { error: 'Browser authorization was denied for this run', code: 'PERMISSION_DENIED', reason: this.denied, layer: 'browser_approval', retrySameArguments: false };
      if (!this.authorized && (args.action === 'open' || this.page)) {
        const proposed = args.url !== undefined ? loopbackTarget(String(args.url)).origin : this.origin ?? staticOrigin;
        const switching=Boolean(this.origin&&proposed!==this.origin);
        let managed:ManagedPreviewTask|undefined;
        if(switching){
          if(args.action!=='open'||args.url===undefined)return {error:'A different preview origin can only be opened with an explicit loopback URL.',code:'PREVIEW_ORIGIN_SCOPE_MISMATCH',expectedOrigin:this.origin,requestedOrigin:proposed,retrySameArguments:false,browser_session:this.stateIdentity};
          const requested=loopbackTarget(String(args.url));
          const taskId=typeof args.preview_task_id==='string'?args.preview_task_id:'';
          managed=this.qaOptions.resolveManagedPreview?.(taskId,requested.href,this.root);
          if(managed){
            try{if(!await isViteClient(requested,AbortSignal.any([signal,AbortSignal.timeout(3500)])))return {error:'The target port did not serve the Vite client reported by the managed project task. The Browser stayed on its current Page.',code:'PROJECT_PREVIEW_SERVICE_MISMATCH',retrySameArguments:false,expectedOrigin:this.origin,requestedOrigin:proposed,task_id:taskId};}
            catch(error){return {error:`Could not confirm the managed Vite preview at the reported port: ${String(error).slice(0,200)}`,code:'PROJECT_PREVIEW_SERVICE_MISMATCH',retrySameArguments:false,expectedOrigin:this.origin,requestedOrigin:proposed,task_id:taskId};}
          }
          pendingManagedSwitch=managed?{fromOrigin:this.origin!,toOrigin:proposed,taskId:managed.taskId,runId:this.qaOptions.runId??'',at:new Date().toISOString(),routePreserved:false}:undefined;
        }
        const automatic=this.qaOptions.securityMode==='autonomous'&&Boolean(this.qaOptions.projectId)&&(!switching||Boolean(managed));
        if(automatic)log('agent.browser.preview.auto-approved',{projectId:this.qaOptions.projectId,root:this.root,origin:proposed,mode:'autonomous',capability:'read-only-local-preview'});
        const decision = automatic?{approved:true,reason:'once' as const}:await confirm?.({ title: 'Проверка локального проекта в браузере', root: this.root, category: 'browser_preview', preview:{projectId:this.qaOptions.projectId??this.root,origin:proposed},actionId,
          detail: `Разрешить браузеру проекта открыть ${proposed}? ${switching?(managed?`Этот loopback-порт сообщён готовым Vite task ${managed.taskId} из текущего запуска; сервис проверен через /@vite/client.`:'Целевой сервис не подтверждён как dev-сервер этого проекта. Открывайте его только если узнаёте локальный сервис.'):'Это выбранный project preview.'} Разрешение ограничивает браузер проектом и GET-запросами; внешняя сеть, credentials, POST и произвольный JavaScript недоступны.` }, signal);
        if (!decision?.approved || signal.aborted) {
          this.ownership='user';this.observer?.ownership?.('blocked');
          this.denied = decision?.reason ?? 'ui_unavailable';
          return { error: switching&&!managed?'Unconfirmed local service was not opened; approve this exact origin through the normal Browser preview dialog or use a current-run project Vite task.':'Project browser authorization denied', code: 'PERMISSION_DENIED', reason: this.denied, layer: 'browser_approval', origin: proposed, projectRoot: this.root, retrySameArguments: false };
        }
        this.authorized = true;this.previewApproved=true;
      }
      if(!responsiveRequest(args)||this.isolatedQa){this.ownership='agent';this.observer?.ownership?.('agent');await this.refreshVisualDisplay();}
      if(args.analyze!==undefined&&typeof args.analyze!=='boolean')throw Error('analyze must be boolean');
      const waitMs = args.wait_ms ?? 100;
      if (!Number.isInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > 2000) throw new Error('wait_ms must be 0..2000');
      if (['read', 'inspect', 'screenshot', 'qa'].includes(String(args.action)) && this.watcher && !responsiveRequest(args)) { await this.watcher.flush(); await this.refresh(); }
      signal.throwIfAborted();
      if (args.action === 'preview_status') {
        if(!this.page||!this.origin||this.origin===staticOrigin)return {code:'NO_DEV_PREVIEW',error:'Open an approved loopback preview first. Static artifacts do not establish a dev server.',retrySameArguments:false};
        const switched=this.lastManagedSwitch?.toOrigin===this.origin;
        const currentRunSwitch=Boolean(switched&&this.qaOptions.runId&&this.lastManagedSwitch?.runId===this.qaOptions.runId);
        const urls=[...new Set((this.qaOptions.regionContext??[]).map(r=>r.url))];
        const refsMatchCurrentOrigin=urls.some(url=>{try{return new URL(url).origin===this.origin;}catch{return false;}});
        if(!switched&&refsMatchCurrentOrigin&&urls.length>1&&!urls.every(url=>sameBrowserUrl(url,urls[0])))return {code:'AMBIGUOUS_PREVIEW_ROUTE',error:'Selected regions have different routes. Inspect each original route explicitly.',retrySameArguments:false};
        const target=loopbackTarget(switched||!refsMatchCurrentOrigin?this.page.url():urls[0]??this.runPreviewUrl??this.page.url());
        if(target.origin!==this.origin)return {code:'PREVIEW_ORIGIN_SCOPE_MISMATCH',error:'Original preview differs from approved origin',retrySameArguments:false};
        const probeSignal=AbortSignal.any([signal,AbortSignal.timeout(6000)]);
        const base={original_url:visualPromptUrl(target.href),current_url:visualPromptUrl(this.page.url()),origin:this.origin,...(switched?{previous_origin:this.lastManagedSwitch!.fromOrigin,managed_task_id:this.lastManagedSwitch!.taskId,managed_switch_current_run:currentRunSwitch}:{}),browser_session:this.stateIdentity,process_ownership:currentRunSwitch?'reported by a current-run managed Vite task; process remains owned by run_terminal':switched?'unknown; prior-run task handles expired and do not establish current process ownership':'unknown; use only existing owned task handles, never adopt a PID or port',browser_workspace:this.native?.workspaceState?.(),formal_verification:false};
        try {
          const html=await fetchLoopback(target,probeSignal);
          const isHtml=(html.headers['content-type']??'').includes('text/html');
          const entries=[...html.body.toString('utf8').matchAll(/<(?:script|link)\b[^>]*?(?:src|href)=["']([^"']+)["']/gi)].map(m=>new URL(m[1],target)).filter(u=>u.origin===this.origin&&/\.(?:[cm]?jsx?|tsx?|css)(?:$|\?)/.test(u.pathname+u.search)).slice(0,4);
          const assets=[];
          for(const entry of entries){const response=await fetchLoopback(entry,probeSignal);assets.push({url:visualPromptUrl(entry.href),status:response.status,ok:response.status>=200&&response.status<300&&!(response.headers['content-type']??'').includes('text/html')});}
          const healthy=html.status>=200&&html.status<300&&isHtml&&assets.every(a=>a.ok);
          return {...base,status:healthy?'responding':'unhealthy',html_status:html.status,assets,freshness:await this.freshness(),guidance:healthy?'Server responds. Do not restart it. Inspect live DOM/CSS and freshness before verifying the changed behavior; HTTP success alone does not prove React/HMR correctness.':'Preserve this Page. Inspect actual project scripts and existing owned task status. Do not kill external/unknown servers or navigate to build HTML. If safe recovery is unavailable, finish with this limitation.'};
        } catch(error){return {...base,status:'unreachable',code:'DEV_PREVIEW_UNREACHABLE',error:String(error).slice(0,240),retrySameArguments:false,guidance:'Do not infer ownership from a port. Use existing task_action status/start only after inspecting project scripts and permissions; never kill an external/unknown server. Preserve the original URL and report limitations if recovery is unavailable.'};}
      }
      if (args.action === 'open') {
        if (args.path !== undefined && args.url !== undefined) throw new Error('Choose path or url');
        let url = args.url !== undefined ? loopbackTarget(String(args.url)) : new URL('/' + String(args.path ?? 'index.html').replace(/^\//, ''), this.origin??staticOrigin);
        if (url.origin !== (this.origin??staticOrigin) && args.url === undefined) throw new Error('Invalid project path');
        const oldOrigin=this.origin,oldPageUrl=this.page?.url(),oldServerManaged=this.serverManaged,oldViteManaged=this.viteManaged;
        if(pendingManagedSwitch&&oldPageUrl){const carried=carryBrowserRoute(oldPageUrl,url.href);url=new URL(carried);pendingManagedSwitch={...pendingManagedSwitch,routePreserved:carried!==args.url};}
        if((this.serverManaged||Boolean(pendingManagedSwitch))&&await devBuildPath(this.root,url.pathname)){
          return {code:'BUILD_ARTIFACT_ON_DEV_SERVER',error:'Built HTML must not replace the original route on a Vite dev server. A failed preview is not a verified production server. Use preview_status, keep the original route and inspect artifacts without navigation; production preview needs a confirmed approved URL.',original_url:visualPromptUrl(this.runPreviewUrl??this.page!.url()),retrySameArguments:false,alternative:{action:'preview_status'}};
        }
        const newPage = !this.origin;
        if (!this.origin) {
          this.origin = url.origin;
          this.observer?.state('loading', url.href);
          await this.start();
        } else if(this.origin!==url.origin){
          // Native Electron has a second, persistent session-level origin guard.
          // Advance it only after the current-run managed-task/service check and
          // normal approval above have authorized this exact preview origin.
          this.native?.approveOrigin(url.origin);
          this.origin=url.origin;
          if(!pendingManagedSwitch){this.serverManaged=false;this.viteManaged=false;}
          this.sourceChangedAt=0;this.loadedAt=0;
        }
        let response;
        try{
          signal.throwIfAborted();this.errors.length = 0; this.blocked.length = 0; this.servedRevisions.clear();
          this.observer?.state('loading', url.href);
          response=await this.page!.goto(url.href,{waitUntil:'load'});
        }
        catch(error){
          if(oldOrigin&&oldPageUrl&&oldOrigin!==url.origin){this.origin=oldOrigin;this.native?.approveOrigin(oldOrigin);this.serverManaged=oldServerManaged;this.viteManaged=oldViteManaged;await this.page!.goto(oldPageUrl,{waitUntil:'load'}).then(()=>this.observer?.state('live',oldPageUrl)).catch(()=>undefined);}
          throw error;
        }
        if(response&&[401,403].includes(response.status())){
          if(oldOrigin&&oldPageUrl&&oldOrigin!==url.origin){this.origin=oldOrigin;this.native?.approveOrigin(oldOrigin);this.serverManaged=oldServerManaged;this.viteManaged=oldViteManaged;await this.page!.goto(oldPageUrl,{waitUntil:'load'}).then(()=>this.observer?.state('live',oldPageUrl)).catch(()=>undefined);}
          return {error:'Authentication required; no authorization bypass was attempted',code:'AUTH_REQUIRED',retrySameArguments:false};
        }
        if(response&&!response.ok()){
          if(oldOrigin&&oldPageUrl&&oldOrigin!==url.origin){this.origin=oldOrigin;this.native?.approveOrigin(oldOrigin);this.serverManaged=oldServerManaged;this.viteManaged=oldViteManaged;await this.page!.goto(oldPageUrl,{waitUntil:'load'}).then(()=>this.observer?.state('live',oldPageUrl)).catch(()=>undefined);}
          throw new Error(`Preview HTTP ${response.status()}`);
        }
        if(pendingManagedSwitch){this.lastManagedSwitch=pendingManagedSwitch;this.runPreviewUrl=url.href;}
        if (newPage) this.qaGuard.reopened(await this.qaState());
        this.observer?.action({ kind: 'navigate', at: Date.now() });
      } else {
        if (!this.page) throw new Error('Use web_project action=open first');
        if (args.action === 'click' || args.action === 'fill') {
          if (typeof args.selector !== 'string' || !args.selector.trim() || args.selector.length > 500) throw new Error('A bounded CSS selector is required');
          const target = this.page.locator(args.selector).first();
          await target.scrollIntoViewIfNeeded();
          const box = await target.boundingBox();signal.throwIfAborted();
          if (args.action === 'click') await target.click();
          else {
            if (!await target.evaluate(element => element.matches('input:not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]),textarea') || (element as HTMLElement).isContentEditable === true)) return {error:'fill requires an editable input, textarea or contenteditable element. For Canvas use key, keydown, keyup or hold; never add hidden inputs to simulate keyboard.',code:'NOT_EDITABLE',retrySameArguments:false};
            if (typeof args.value !== 'string' || args.value.length > 4000) throw new Error('fill requires value of at most 4000 characters');
            signal.throwIfAborted();await target.fill(args.value);
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
          if(this.serverManaged&&(await this.freshness()).status==='possibly-stale')return {error:'Page may be out of date: source changed without an observed HMR update. Preserve unsaved forms; explicitly reload this approved page or ask the user before verifying it.',code:'PREVIEW_POSSIBLY_STALE',retrySameArguments:false,origin:this.origin,alternative:{action:'reload'}};
          let steps, scenarios, responsive; try {
            steps=qaSteps(args.checks);scenarios=qaScenarios(args.scenarios);responsive=responsiveOptions(args.responsive);
            if(!this.isolatedQa&&responsive&&scenarios.length&&(args.responsive as Record<string,unknown>).viewports!==undefined)throw new Error('Declare viewport separately in each immutable scenario, rather than applying global viewports to bound criteria');
            if(!this.isolatedQa&&responsive?.breakpoint&&scenarios.length)throw new Error('Breakpoint probes are diagnostics; execute registered acceptance scenarios separately');
            if(responsive&&!scenarios.length){const target=String(args.url??args.path??this.page.url()),b=responsive.breakpoint;scenarios=(b?[{width:b.minWidth,height:844},{width:b.maxWidth,height:844}]:responsive.viewports).map((v,i)=>layoutScenario(`responsive-${i+1}`,target,v));}
            if(this.serverManaged){for(const scenario of scenarios){if(await devBuildPath(this.root,new URL(scenario.target,this.page.url()).pathname))return {code:'BUILD_ARTIFACT_ON_DEV_SERVER',error:'QA target is built HTML on the dev origin. Keep the original route or use a confirmed approved production preview.',retrySameArguments:false,alternative:{action:'preview_status'}};}}
            if(new Set(scenarios.flatMap(s=>[...(s.viewport?[s.viewport]:[]),...(s.visual_layout?.resize??[])]).map(v=>`${v.width}x${v.height}`)).size>5)throw new Error('At most 5 viewports per QA checkpoint');
            if(!this.isolatedQa&&scenarios.some(s=>s.viewport))return await this.isolatedResponsive(args,scenarios,signal,actionId);
          } catch(error) { return qaArgumentFailure(error,args); }
          // Hidden Native Pages have no user layout; establish metrics before the initial capture/state snapshot.
          if(this.isolatedQa&&scenarios[0]?.viewport)await this.page.setViewportSize({width:scenarios[0].viewport.width,height:scenarios[0].viewport.height});
          const initialState=await this.qaState(scenarios);
          const scope=qaHash({root:this.root,url:this.page.url(),scenario:qaScenarioIdentity({steps,scenarios,responsive}),state:initialState,runtime:this.qaOptions.runtimeIdentity});
          const cached=this.isolatedQa?this.qaGuard.responsiveCached(scope):undefined;
          // Keep the existing whole-project guard revision: a repaired previously failing route must release the guard too.
          // Independent passing observations are reused below by their precise dependency set, before executing QA again.
          const revision = await projectRevision(this.root, [this.captureDirectory, paths.userData, paths.configDirectory, paths.cache, paths.logs, paths.attachments, join(paths.dataRoot,'sqlite'), join(paths.dataRoot,'protected-runtime.json'), join(paths.dataRoot,'llama-cpp-runtime-state.json')]);
          const key = this.qaGuard.key(revision, this.page.url(), {steps,scenarios,responsive}, initialState, this.qaOptions.runtimeIdentity);
          if(cached&&!await this.revisionsChanged(cached.sourceRevisions??{})){this.qaOptions.status?.({phase:'complete',report:cached});return {...await this.read(),qa:cached,visual_analysis:cached.visual.analyzed,reused_evidence:true,guidance:'Unchanged responsive scenario and source dependencies: existing evidence reused. Change relevant source/state/scenario before retesting.'};}
          const blocked = this.qaGuard.before(key);
          if (blocked) {
            const qa: BrowserQaReport = { scope:'interaction', id:randomUUID(), runId:this.qaOptions.runId, status:'Blocked', reasonCode:'QA_NO_PROGRESS', url:this.page.url(), capturedAt:new Date().toISOString(), checks:[], errors:[], captures:[], visual:{analyzed:false,status:'Not Verified',reason:'No new image analysis; previous evidence retained'}, elapsedMs:0, reason:blocked.error, revisionFingerprint:revision, loop:blocked.loop };
            await this.saveQa(qa); this.qaOptions.status?.({phase:'complete',report:qa});
            return { ...blocked, qa };
          }
          const reloadNeeded=!scenarios.length || await this.sourcesChanged();
          if(reloadNeeded){this.errors.length=0;this.blocked.length=0;this.servedRevisions.clear();}
          const reloaded = reloadNeeded ? await this.page.reload({ waitUntil: 'load' }) : null;
          if(reloaded && [401,403].includes(reloaded.status()))return {error:'Authentication required; no authorization bypass was attempted',code:'AUTH_REQUIRED',retrySameArguments:false};
          const qaSignal = AbortSignal.any([signal, AbortSignal.timeout(90000), ...(this.qaOptions.signal ? [this.qaOptions.signal] : [])]);
          const qa = await runBrowserQa({ page: this.page, signal: qaSignal, steps, scenarios, responsive, sourceRevisions:()=>Object.fromEntries(this.servedRevisions), navigate:async target=>{const url=new URL(target,this.page!.url());if(this.serverManaged&&await devBuildPath(this.root,url.pathname))throw new Error('BUILD_ARTIFACT_ON_DEV_SERVER: use the original route; built HTML is not a dev-server preview');if(url.origin!==this.origin)throw new Error('Scenario target outside approved origin');const current=new URL(this.page!.url());if(this.isolatedQa||url.pathname!==current.pathname||url.search!==current.search)this.servedRevisions.clear();if(this.isolatedQa){this.errors.length=0;this.blocked.length=0;}let response=await this.page!.goto(url.href,{waitUntil:'load',timeout:10000});if(this.isolatedQa&&!response)response=await this.page!.reload({waitUntil:'load',timeout:10000});if(response&&[401,403].includes(response.status()))return {authRequired:true};if(response&&!response.ok())throw new Error(`Preview HTTP ${response.status()}`);return {};}, errors: () => [...this.errors, ...this.blocked], metrics:()=>this.qaMetrics(), capture: cdp => this.capture({}, qaSignal, cdp), baseline:ref=>this.visualBaseline(ref), analyze: this.qaOptions.analyze ? (capture, before, scenario) => this.qaOptions.analyze!(capture, qaSignal, before, scenario) : undefined, status: this.qaOptions.status });
          qa.runId = this.qaOptions.runId; qa.revisionFingerprint = revision;
          const sourceRevisions:Record<string,string> = Object.assign({},...qa.scenarios?.map(scenario=>scenario.sourceRevisions??{})??[],Object.fromEntries(this.servedRevisions));
          qa.sourceRevisions=sourceRevisions;
          if(this.isolatedQa&&Object.keys(sourceRevisions).length)qa.revisionFingerprint=qaHash(Object.entries(sourceRevisions).sort());
          const afterRevision=this.isolatedQa&&Object.keys(qa.sourceRevisions??{}).length>0&&!await this.revisionsChanged(qa.sourceRevisions??{})?revision:await projectRevision(this.root,[this.captureDirectory,paths.userData,paths.configDirectory,paths.cache,paths.logs,paths.attachments,join(paths.dataRoot,'sqlite'),join(paths.dataRoot,'protected-runtime.json'),join(paths.dataRoot,'llama-cpp-runtime-state.json')]);
          if(afterRevision!==revision){qa.status='Not Verified';qa.functionalStatus='Not Verified';qa.reasonCode='EVIDENCE_STALE';qa.reason='Project changed during QA; retain observations and rerun the affected scenarios.';for(const result of qa.scenarios??[]){result.status='Not Verified';if(result.visualLayout)result.visualLayout.status='Blocked';}}
          const source = await this.read();
          if (source.source_path) { const bytes = await readPreviewAsset(this.root, '/'+relative(this.root,source.source_path),false,true); qa.sourceFingerprint = screenshotHash(bytes.body); }
          await this.saveQa(qa);
          this.qaGuard.record(key, qa, await this.qaState(scenarios));
          if(this.isolatedQa)this.qaGuard.rememberResponsive(scope,qa);
          return { ...source, qa, visual_analysis: qa.visual.analyzed };
        } else if (args.action === 'inspect') {
          if(typeof args.selector!=='string'||!args.selector.trim()||args.selector.length>500)return {error:'inspect requires a bounded CSS selector. Example: {action:"inspect",selector:"#sticker"}',code:'INVALID_SELECTOR',retrySameArguments:false};
          const refs=(this.qaOptions.regionContext??[]).filter(r=>sameBrowserUrl(r.url,this.page!.url()));
          const input={selector:args.selector,properties:diagnosticStyles,anchorSelectors:refs.flatMap(r=>r.selectors??[]).slice(0,24),anchors:refs.flatMap(r=>r.anchors??[]).slice(0,24)};
          const sourceAtInspection=this.sourceChangedAt;
          const inspection=await this.page.evaluate<ReturnType<typeof inspectBrowserDom>>(`(${inspectBrowserDom.toString()})(${JSON.stringify(input)},${resolveBrowserAnchor.toString()})`);
          const context=await this.read();
          const current={inspection:{...inspection.inspection,url:visualPromptUrl(inspection.inspection!.url)},...context,content:undefined,links:undefined,provenance:{kind:'current-browser-observation',observedAt:inspection.inspection!.observedAt,browserSession:this.stateIdentity}};
          if(inspection.inspection!.documentVersion.timeOrigin!==context.documentVersion?.timeOrigin||JSON.stringify(inspection.inspection!.viewport)!==JSON.stringify(context.documentVersion?.viewport)||sourceAtInspection!==this.sourceChangedAt||inspection.inspection!.documentVersion.hmrAppliedAt!==context.freshness.hmrAppliedAt||!sameBrowserUrl(inspection.inspection!.url,context.url))return {...current,freshness:{...context.freshness,status:'possibly-stale'},error:'Page/source changed while CSS was sampled. This observation cannot verify the current state. Retry inspection once after HMR settles; if unstable, finish with the freshness limitation.',code:'BROWSER_OBSERVATION_CHANGED',retrySameArguments:true};
          if(!inspection.inspection!.matches){const anchored=refs.some(r=>r.selectors?.includes(args.selector as string));return {...current,error:`No current DOM element matches this selector (${inspection.inspection!.matches}) at the reported URL and HMR state. candidate_elements lists live tags, IDs, CSS Modules classes and usable selector hints; choose one or use read. Absence is confirmed only for this current URL/DOM.`,code:anchored?'STALE_DOM_ANCHOR':'ELEMENT_NOT_FOUND',retrySameArguments:false,alternative:{action:'read'},anchorState:inspection.inspection!.anchorResolution.reason??'element-missing'};}
          return current;
        } else if (args.action === 'screenshot') {
          if(this.qaOptions.takeScreenshot?!this.qaOptions.takeScreenshot():this.captures>=8)return {error:'Screenshot limit for this logical task is exhausted. Use DOM/CSS inspection or finish with verification incomplete.',code:'SCREENSHOT_LIMIT',retrySameArguments:false,alternative:{action:'inspect',selector:'<current confirmed selector>'},budget:{limit:8,scope:'logical_task'}};
          this.qaOptions.status?.({phase:'capturing'});
          await this.page.waitForTimeout(Number(waitMs));
          const beforeCapture=await this.freshness();
          const capture = await this.capture(args, signal);
          const afterCapture=await this.freshness();
          const captureProvenance={kind:'point-in-time-capture',capturedAt:capture.capturedAt,url:capture.url,viewport:capture.viewport,region:capture.region,freshness:beforeCapture.sourceChangedAt===afterCapture.sourceChangedAt&&beforeCapture.hmrAppliedAt===afterCapture.hmrAppliedAt&&beforeCapture.loadedAt===afterCapture.loadedAt?afterCapture.status:'unknown',hmrAppliedAt:beforeCapture.hmrAppliedAt};
          this.captures++;
          if (this.qaOptions.analyze && args.analyze !== false) this.qaOptions.status?.({phase:'analyzing'});
          const visual: BrowserVisualResult = this.qaOptions.analyze && args.analyze !== false ? await this.qaOptions.analyze(capture, signal, undefined, args.analyze === true ? {goal:'Inspect this explicitly requested screenshot; no interaction claim.',temporal:false,purpose:'requested'}:undefined) : { analyzed: false, status: 'Not Verified', reason: args.analyze === false ? 'Image analysis was not requested; capture retained.' : 'Vision Off or unavailable; capture retained without model image analysis.' };
          const qa: BrowserQaReport = { scope:'capture', id:randomUUID(), runId:this.qaOptions.runId, status:visual.analyzed?'Partially Verified':'Not Verified', url:capture.url, capturedAt:capture.capturedAt, checks:[], errors:[...this.errors], captures:[capture], visual, elapsedMs: capture.captureMs!+(visual.latencyMs??0), reason:'Single captured image; no interaction verification in this action' };
          qa.evidencePath=join(this.captureDirectory,`${qa.id}.json`);await writeFile(qa.evidencePath,JSON.stringify(qa,null,2),{flag:'wx',mode:0o600});
          this.qaOptions.status?.({phase:'complete',report:qa});
          return { screenshot_path: capture.path, capture, capture_provenance:captureProvenance, visual, qa, visual_analysis: visual.analyzed,vision_input:visual.imageInput??{state:'not-sent',recipient:'vision-analysis',requestAttempted:false,imageCount:0,mime:'image/png',reasonCode:'analysis-not-requested-or-unavailable'},pixels_available_to_task_model:false, pixel_access:'The task inference receives capture metadata/path and any explicit Vision analysis text, not PNG pixels. Vision Off means no image was analyzed; do not claim to see its contents.', ...(await this.read()) };
        } else if (args.action !== 'read') throw new Error('Unknown project browser action');
      }
      if (signal.aborted || this.closed) throw new Error('Project browser cancelled');
      await this.page!.waitForTimeout(Number(waitMs));
      this.observer?.state('live', this.page!.url());
      return await this.read();
    } catch (error) {
      if(this.reusable){await this.releaseInput();this.ownership='user';this.observer?.ownership?.('user');this.refreshVisualDisplaySoon();}
      // Failed startup cannot leave a half-initialized reusable session.
      const code=/Screenshot region|Crop moved|Invalid screenshot selector|Screenshot element/.test(String(error))?'INVALID_CROP':args.selector&&/selector|locator|querySelector/i.test(String(error))?'INVALID_SELECTOR':/page.goto|page.reload|net::ERR_/.test(String(error))?'BROWSER_NAVIGATION_FAILED':String(error).includes('Screenshot limit reached')?'SCREENSHOT_LIMIT':this.endReason==='user_closed'?'BROWSER_USER_CLOSED':this.endReason==='operation_cancelled'?'BROWSER_OPERATION_CANCELLED':['connection_lost','renderer_crashed'].includes(this.endReason)?'BROWSER_CONNECTION_LOST':this.endReason==='page_closed'?'BROWSER_PAGE_CLOSED':this.endReason==='policy_changed'?'BROWSER_POLICY_CHANGED':this.endReason==='preview_unavailable'?'BROWSER_PREVIEW_UNAVAILABLE':signal.aborted?'BROWSER_OPERATION_CANCELLED':!this.page&&this.origin?'BROWSER_UNAVAILABLE':'PROJECT_BROWSER_FAILED';
      if (this.origin && (!this.page || this.page.isClosed())) this.observer?.state('error', undefined, String(error).slice(0, 300));
      else if(args.action==='open'&&this.page)this.observer?.state(this.page.url().startsWith('chrome-error:')?'error':'live',this.page.url(),String(error).slice(0,300));
      if (!this.page && this.origin) await this.close(false,'startup_failed');
      return { error: (error instanceof Error ? error.message : String(error)).slice(0, 4000), code, retrySameArguments: ['startup_failed','connection_lost','renderer_crashed','page_closed'].includes(this.endReason),browser_session:this.stateIdentity };
    } finally { await this.ensureWatching(); }
  }
  private async isolatedResponsive(args:Record<string,unknown>,scenarios:import('../../shared/browser-qa').QaScenario[],signal:AbortSignal,actionId:string) {
    if(this.responsiveSession)throw new Error('A responsive checkpoint is already running');
    if(this.native&&!this.observer?.createQaPage)throw new Error('This Native Browser owner cannot create an isolated QA page');
    const target=new URL(String(args.url??args.path??this.page!.url()),this.page!.url());
    if(target.origin!==this.origin)throw new Error('Responsive QA target must stay inside the approved origin');
    const observer:ProjectBrowserObserver|undefined=this.native?{createPage:origin=>this.observer!.createQaPage!(origin),ready:()=>{},state:()=>{},action:()=>{},closed:()=>{}}:undefined;
    const child=new ProjectBrowserSession(this.root,this.captureDirectory,async()=>this.browser!,observer,{...this.qaOptions,guard:this.qaGuard},true);
    this.responsiveSession=child;
    try {
      const operation=AbortSignal.any([signal,AbortSignal.timeout(90000),...(this.qaOptions.signal?[this.qaOptions.signal]:[])]);
      const result=await child.execute({...args,scenarios,...(this.origin===staticOrigin?{path:target.pathname+target.search+target.hash,url:undefined}:{url:target.href,path:undefined})},operation,async()=>({approved:true,reason:'once'}),actionId);
      return {...result as object,verification_context:{qa_origin:target.origin,native_origin:this.origin,native_url:visualPromptUrl(this.page!.url()),native_freshness:await this.freshness(),same_origin:target.origin===this.origin}};
    } finally {await child.close();this.responsiveSession=undefined;}
  }
  private async privacyCapture<T>(capture:()=>Promise<T>):Promise<T>{
    const page=this.page!;
    // Cover rounding and antialiasing at native compositor crop edges, including tiny Fit.
    const presentation=this.native?.workspaceState?.();
    const padding=presentation?2/(presentation.browserZoom*presentation.displayScale):2;
    const hidden=await page.evaluate(padding=>{
      const hidden=Array.from(document.querySelectorAll<HTMLElement>('#__lad-visual-selection,#__lad-visual-highlight,#__lad-visual-regions')).map(node=>({id:node.id,visibility:node.style.visibility}));for(const saved of hidden){document.getElementById(saved.id)!.style.visibility='hidden';}
      document.getElementById('__lad-capture-mask')?.remove();
      const host=document.createElement('div');host.id='__lad-capture-mask';host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      const shadow=host.attachShadow({mode:'closed'});
      for(const control of document.querySelectorAll('input,textarea,select,[contenteditable],[data-private],[data-sensitive]')){
        const b=control.getBoundingClientRect();if(!b.width||!b.height)continue;const mask=document.createElement('div');mask.style.cssText=`position:absolute;left:${b.x-padding}px;top:${b.y-padding}px;width:${b.width+2*padding}px;height:${b.height+2*padding}px;background:#ff00ff;`;shadow.append(mask);
      }document.documentElement.append(host);void host.getBoundingClientRect();return hidden;
    },padding);
    try{
      // Native capture copies the compositor's last frame, which may predate
      // the DOM mask task after zoom. Wait for a painted mask before copying;
      // never fall back to an unmasked crop when the live surface cannot paint.
      // Hidden isolated QA pages use CDP capture and deliberately have no rAF.
      if(this.native&&!this.isolatedQa)await page.evaluate(()=>new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Privacy mask paint timed out; capture withheld')),1500);
        requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));
      }));
      return await capture();
    }finally{await page.evaluate(hidden=>{document.getElementById('__lad-capture-mask')?.remove();for(const saved of hidden){const node=document.getElementById(saved.id);if(node)node.style.visibility=saved.visibility;}},hidden).catch(()=>undefined);}
  }
  private async qaMetrics():Promise<QaCdp> {
    if(!this.native)return this.page!.context().newCDPSession(this.page!);
    // Fixed commands on this owned target only. Never relax the Native transport's browser-wide CDP prohibition.
    const contents=this.native.contents;
    return {send:async(method,params)=>{
      if(!['Emulation.setDeviceMetricsOverride','Page.captureScreenshot'].includes(method))throw new Error('Unsupported QA target command');
      return contents.debugger.sendCommand(method,params);
    },detach:async()=>{}} as QaCdp;
  }
  private async capture(args: Record<string, unknown>, signal: AbortSignal, captureSession?:QaCdp): Promise<BrowserCapture> {
    const captureStarted = performance.now();
    if (!this.page || signal.aborted || this.closed) throw new Error('Capture cancelled');
    const metrics=await this.page.evaluate(()=>({dpr:devicePixelRatio,scroll:{x:scrollX,y:scrollY}}));
    const page = this.page, viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    let region = { x: 0, y: 0, ...viewport };
    if (args.selector !== undefined) {
      if (typeof args.selector !== 'string' || args.selector.length > 500) throw new Error('Invalid screenshot selector');
      const box = await page.locator(args.selector).first().boundingBox(); if (!box) throw new Error('Screenshot element is not visible'); region = box;
    } else if (args.clip !== undefined) region = args.clip as typeof region;
    if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > viewport.width || region.y + region.height > viewport.height) throw new Error('Screenshot region must fit the current viewport');
    const documentRegion={...region,x:region.x+metrics.scroll.x,y:region.y+metrics.scroll.y};
    const bytes=await this.privacyCapture(async()=>{
    let bytes:Buffer;
    if(!captureSession&&this.native?.workspaceState?.()&&this.native.captureCss){bytes=await this.native.captureCss(documentRegion,metrics.dpr);}
    else if(captureSession||metrics.dpr!==1||!this.native&&(region.width>1280||region.height>900)){
      const cdp=captureSession??await this.qaMetrics();
      try {const result=await cdp.send('Page.captureScreenshot',{format:'png',clip:{...documentRegion,scale:Math.min(1,1280/region.width,900/region.height)/metrics.dpr},captureBeyondViewport:false});bytes=Buffer.from(result.data,'base64');}
      finally {if(!captureSession)await cdp.detach().catch(()=>undefined);}
    }else bytes=await page.screenshot({ type: 'png', clip: documentRegion, scale: 'css', timeout: 10000 });
    if (!captureSession && this.native && (bytes.readUInt32BE(16)>1280||bytes.readUInt32BE(20)>900)) {
      const { nativeImage } = await import('electron');
      const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);const scale = Math.min(1280/width, 900/height);
      bytes = nativeImage.createFromBuffer(bytes).resize({ width:Math.max(1,Math.floor(width*scale)), height:Math.max(1,Math.floor(height*scale)), quality:'good' }).toPNG();
    }
    return bytes;});
    if (signal.aborted || this.closed) throw new Error('Capture cancelled');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Screenshot exceeds 2 MiB budget');
    await mkdir(this.captureDirectory, { recursive: true, mode: 0o700 });
    const id = randomUUID(), path = join(this.captureDirectory, `${id}.png`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return { ...(this.qaOptions.runId ? {runId:this.qaOptions.runId} : {}), ...metrics, id, path, sha256: screenshotHash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), viewport, region, ...(typeof args.selector === 'string' ? { selector: args.selector } : {}), url: page.url(), capturedAt: new Date().toISOString(), captureMs: performance.now()-captureStarted, bytes: bytes.length };
  }
  private async saveQa(qa: BrowserQaReport) {
    await mkdir(this.captureDirectory, { recursive: true, mode: 0o700 });
    qa.evidencePath = join(this.captureDirectory, `${qa.id}.json`);
    await writeFile(qa.evidencePath, JSON.stringify({...qa,projectRoot:this.root}, null, 2), { flag:'wx', mode:0o600 });
  }
  private async visualBaseline(ref:{report_id:string;scenario_id:string}) {
    if(!/^[a-f0-9-]{36}$/.test(ref.report_id))throw new Error('Invalid baseline ID');
    const file=await open(join(this.captureDirectory,`${ref.report_id}.json`),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const stat=await file.stat();if(!stat.isFile()||stat.size>1024*1024)throw new Error('Baseline exceeds report budget');
      const bytes=Buffer.alloc(stat.size+1),read=await file.read(bytes,0,bytes.length,0);if(read.bytesRead>stat.size)throw new Error('Baseline changed during read');
      const report=JSON.parse(bytes.subarray(0,read.bytesRead).toString()) as BrowserQaReport&{projectRoot?:string};
      if(report.projectRoot!==this.root||report.id!==ref.report_id)throw new Error('Baseline belongs to another project');
      return report.scenarios?.find(s=>s.id===ref.scenario_id)?.visualLayout;
    } finally {await file.close();}
  }
  private async sourcesChanged() {
    let bytes=0;
    for(const [path,hash] of this.servedRevisions){
      try{const asset=await readPreviewAsset(this.root,'/'+relative(this.root,path),false,true);bytes+=asset.body.length;if(bytes>32*1024*1024||screenshotHash(asset.body)!==hash)return true;}catch{return true;}
    }
    return false;
  }
  private async currentSourceRevisions(revisions:Record<string,string>) {
    const current:Record<string,string>={};let bytes=0;
    if(Object.keys(revisions).length>64)throw new Error('Responsive dependency set exceeds 64 assets');
    for(const path of Object.keys(revisions).sort()){
      if(bytes>=32*1024*1024){current[path]='[budget exceeded]';continue;}
      try{const asset=await readPreviewAsset(this.root,'/'+relative(this.root,path),false,true);bytes+=asset.body.length;if(bytes>32*1024*1024)throw new Error('Responsive dependency bytes exceeded');current[path]=screenshotHash(asset.body);}catch{current[path]='[unavailable]';}
    }
    return current;
  }
  private async revisionsChanged(revisions:Record<string,string>) {
    const current=await this.currentSourceRevisions(revisions);return Object.entries(revisions).some(([path,hash])=>current[path]!==hash);
  }
  private async qaState(scenarios:import('../../shared/browser-qa').QaScenario[] = []) {
    const conditions=scenarios.flatMap(scenario=>[...scenario.preconditions,...scenario.required_state]);
    return this.page!.evaluate(conditions=>({url:location.href,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY},focus:document.activeElement?.id||document.activeElement?.tagName,
      fields:Array.from(document.querySelectorAll('input:not([type=file]),textarea,select')).slice(0,40).map(element=>({id:element.id,value:(element as HTMLInputElement).value})),
      conditions:conditions.map(condition=>{try{
        const element=condition.selector?document.querySelector(condition.selector):undefined;
        let diagnostic:unknown=(window as unknown as {__qaDiagnostics?:unknown}).__qaDiagnostics;
        if(condition.source==='diagnostic')for(const key of condition.path!.split('.')){diagnostic=diagnostic&&typeof diagnostic==='object'&&Object.prototype.hasOwnProperty.call(diagnostic,key)?(diagnostic as Record<string,unknown>)[key]:undefined;}
        const actual=condition.source==='diagnostic'?diagnostic:condition.source==='url'?location.pathname+location.search+location.hash:condition.source==='visible'?Boolean(element&&(element as HTMLElement).getBoundingClientRect().width):condition.source==='value'?(element as HTMLInputElement)?.value:condition.source==='text'?(element as HTMLElement)?.innerText?.trim():undefined;
        return actual===condition.expected;
      }catch{return false;}})
    }),conditions);
  }
  /** One security/asset implementation for native session delivery and CLI CDP routing. */
  private async resource(raw: string, method: string, signal: AbortSignal) {
    const url = new URL(raw);
    if (this.closed || signal.aborted) throw new Error('Project browser cancelled or closed');
    if (Date.now()-this.networkBudget.started > 30000) this.networkBudget = {requests:0,bytes:0,started:Date.now()};
    if (url.origin !== this.origin || url.username || url.password || method !== 'GET' || ++this.networkBudget.requests > 256 || this.networkBudget.bytes > 32 * maxBytes) throw new Error('Outside approved origin, request method or per-operation/30-second request budget');
    const safetyHeaders = {'x-content-type-options':'nosniff','x-dns-prefetch-control':'off'};
    if (this.origin === staticOrigin) {
      const asset = await readPreviewAsset(this.root,url.pathname); this.servedRevisions.set(await projectPath(this.root,decodeURIComponent(url.pathname).replace(/^\//,'')),screenshotHash(asset.body)); this.networkBudget.bytes += asset.body.length;
      return {status:200,body:asset.body,headers:{...safetyHeaders,'content-type':asset.contentType,'content-security-policy':previewCsp}};
    }
    const response = await fetchLoopback(url,AbortSignal.any([signal,this.abort.signal])); this.networkBudget.bytes += response.body.length;
    await this.detectServerReload(url.pathname,response.body,Boolean(response.headers['content-type']?.includes('text/html')));
    if(this.viteManaged&&response.status===200&&this.servedRevisions.size<64&&/\.(?:[cm]?js|jsx|tsx?|css)$/.test(url.pathname)&&!url.pathname.includes('/node_modules/')){
      try{const asset=await readPreviewAsset(this.root,url.pathname,false,true);
        if(matchesDevSourceMap(response.body,asset.body))this.servedRevisions.set(await projectPath(this.root,decodeURIComponent(url.pathname).slice(1)),screenshotHash(asset.body));
      }catch{/* No source proof for virtual modules, symlinks, or unrelated transforms. */}
    }
    if(url.pathname==='/@vite/client'&&response.status===200){response.body=Buffer.concat([response.body,Buffer.from('\nconst __ladHot=createHotContext("/@lad-observer");__ladHot.on("vite:afterUpdate",()=>{window.__ladHmrAt=Date.now()});\n')]);}
    const csp=this.serverManaged?previewCsp.replace("connect-src 'self'","connect-src 'self' "+this.origin!.replace('http:','ws:')):previewCsp;
    return {...response,headers:{...response.headers,...safetyHeaders,'content-security-policy':[response.headers['content-security-policy'],csp].filter(Boolean).join(', ')}};
  }
  private async start() {
    this.native = await this.observer?.createPage?.(this.origin!);
    this.browser = this.native?.browser ?? await this.launch();
    if (this.closed) { if(this.native)await this.native.close();else if(!this.isolatedQa)await this.browser.close();throw new Error('Project browser cancelled during launch'); }
    this.context = this.native?.context ?? await this.browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await this.context.clearPermissions();
    await this.context.addInitScript(() => { Object.defineProperty(window, 'RTCPeerConnection', { value: undefined, configurable: false }); Object.defineProperty(navigator, 'serviceWorker', {value:undefined,configurable:false}); });
    await this.context.routeWebSocket('**/*', socket => {
      if(!allowedViteSocket(socket.url(),this.origin!,this.serverManaged)){socket.close();return;}
      const upstream=socket.connectToServer();let began=Date.now(),messages=0,bytes=0;
      socket.onMessage(raw=>{const safe=typeof raw==='string'?viteClientMessage(raw):undefined;if(safe)upstream.send(safe);else socket.close({code:1008,reason:'Only Vite HMR control messages are allowed'});});
      upstream.onMessage(raw=>{if(Date.now()-began>30000){began=Date.now();messages=0;bytes=0;}bytes+=typeof raw==='string'?raw.length:raw.length;
        if(++messages>256||bytes>2*1024*1024||raw.length>256*1024){socket.close({code:1008,reason:'HMR resource budget exceeded'});return;}socket.send(raw);});
    });
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
    this.endReason='live';
    this.page.on('crash', () => {this.endReason='renderer_crashed'; this.observer?.state('error', undefined, 'Browser renderer crashed'); void this.close(false,'renderer_crashed'); });
    this.page.on('close', () => {clearInterval(this.displayTimer);this.displayTimer=undefined; if(!this.closed)this.endReason='page_closed';this.stopWatching(); if (!this.closed) this.observer?.state('error', undefined, 'Browser page closed'); });
    this.bindObserver();
    if(!this.isolatedQa)this.browser.on('disconnected', () => { if(!this.closed)this.endReason='connection_lost';this.stopWatching(); if (!this.closed) this.observer?.state('error', undefined, 'Browser disconnected'); this.observer?.closed(this.endReason); });
    this.page.on('load',()=>{this.loadedAt=Date.now();void this.freshness();});
    this.page.setDefaultTimeout(5_000); this.page.setDefaultNavigationTimeout(10_000);
    this.context.on('page', page => { if (page !== this.page) void page.close(); });
    this.page.on('framenavigated', frame => {
      if(this.closed)return;
      if (frame === this.page?.mainFrame() && frame.url() !== 'about:blank') {
        this.visualEpoch++;this.selectionRegions=[];this.selectionActive=false;this.selectionCallback=undefined;
        try { if (new URL(frame.url()).origin === this.origin) { this.lastAllowedUrl = frame.url(); this.endReason='live';this.blockedNavigation = false; this.observer?.state('live', frame.url()); return; } } catch { /* Unsupported navigation. */ }
        this.note(this.blocked, `Navigation outside approved origin: ${frame.url()}`);
        if (frame.url() === 'chrome-error://chromewebdata/' && this.blockedNavigation && this.lastAllowedUrl && !this.recoveringNavigation && !this.navigationRecoveryUsed) {
          const target = this.lastAllowedUrl; this.blockedNavigation = false; this.recoveringNavigation = true;this.navigationRecoveryUsed=true;
          void this.exclusive(async () => {
            if (!this.closed && this.page && !this.page.isClosed()) await this.page.goto(target, { waitUntil: 'load' });
          }).catch(error => {this.observer?.state('error',undefined,`Approved preview unavailable: ${String(error).slice(0,200)}. Reopen it when the server is ready.`);}).finally(() => { this.recoveringNavigation = false; });
        } else if(frame.url()==='chrome-error://chromewebdata/'){this.endReason='preview_unavailable';this.observer?.state('error',undefined,'Preview server/navigation unavailable; reopen the approved project URL.');}
        else void this.page?.close();
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
    const dom=await page.evaluate(inspectBrowserDom,{});
    const workspace=this.native?.workspaceState?.();
    const refs=this.qaOptions.regionContext??[];
    const currentRunSwitch=Boolean(this.lastManagedSwitch&&this.qaOptions.runId&&this.lastManagedSwitch.runId===this.qaOptions.runId);
    return { provenance:{kind:'current-browser-observation',observedAt:new Date().toISOString(),browserSession:this.stateIdentity}, freshness:await this.freshness(), ...(workspace?{browser_workspace:workspace}:{}), region_context:{current_url:visualPromptUrl(page.url()),supplementary_scopes:(this.qaOptions.routeScopes?.()??[]).filter(scope=>!refs.some(r=>r.groupId===scope.deliverable_id)&&new URL(scope.target,page.url()).origin===this.origin&&sameBrowserUrl(new URL(scope.target,page.url()).href,page.url())&&scope.viewport.width===dom.documentVersion?.viewport.width&&scope.viewport.height===dom.documentVersion?.viewport.height).map(scope=>({...scope,target:visualPromptUrl(new URL(scope.target,page.url()).href)})),references:refs.map(r=>{const changedOrigin=new URL(r.url).origin!==new URL(page.url()).origin;return {...r,url:visualPromptUrl(r.url),matches_current:sameBrowserUrl(r.url,page.url()),matches_route_after_port_switch:Boolean(changedOrigin&&this.lastManagedSwitch&&sameBrowserRoute(r.url,page.url())),origin_changed:changedOrigin,usable_as_current_evidence:sameBrowserUrl(r.url,page.url())};}),...(this.lastManagedSwitch?{approved_origin_switch:{...this.lastManagedSwitch,current_run:currentRunSwitch}}:{})}, browser_session:this.stateIdentity, source_revisions:Object.fromEntries(this.servedRevisions), source_binding:{state:this.origin===staticOrigin?'static-assets':this.servedRevisions.size?'matched-inline-source-map':'unavailable',...(this.origin!==staticOrigin&&!this.servedRevisions.size?{reason:'No exact project-source match for the served transform. DOM observations alone do not formally verify source changes.'}:{})}, ...dom,url:visualPromptUrl(page.url()), ...(this.origin === staticOrigin ? { source_path: await projectPath(this.root, decodeURIComponent(new URL(page.url()).pathname).slice(1) || 'index.html') } : this.servedRevisions.size?{source_path:this.servedRevisions.keys().next().value!}:{}), javascript_errors: [...this.errors], blocked_requests: [...this.blocked], browser_check: `DOM and runtime diagnostics only; screenshots require separate visual analysis. Display: ${this.native ? 'native Electron WebContentsView (headed), same Page as Live Browser' : 'headless CLI Chromium'}` };
  }
  private closing?: Promise<void>;
  private browserClosing?: Promise<void>;
  private closeBrowser() {
    return this.browserClosing ??= Promise.resolve().then(async () => {
      if (this.native) await this.native.close();
      else { await this.context?.close().catch(() => undefined); if(!this.isolatedQa)await this.browser?.close().catch(() => undefined); }
    });
  }
  close(refresh = false, reason='closed'): Promise<void> {
    if(!this.closed)this.endReason=reason;
    if (!refresh) {
      void this.responsiveSession?.close();
      this.closed = true; this.stopWatching(); this.abort.abort();
      // Stop can interrupt a pending final refresh instead of waiting behind it.
      if (this.closing) void this.closeBrowser();
    }
    return this.closing ??= Promise.resolve().then(() => this.dispose(refresh));
  }
  private async dispose(refresh: boolean) {
    clearInterval(this.displayTimer);this.displayTimer=undefined;this.displayedRegions=[];
    await this.clearSelection();
    if (refresh && !this.closed) {
      await this.watcher?.flush();
      await this.exclusive(async () => {
        await this.refresh(true);
      }).catch(error => { if (!this.closed) this.observer?.state('error', undefined, `Auto-reload failed: ${String(error).slice(0, 200)}`); });
    }
    this.closed = true; this.stopWatching(); this.abort.abort(); this.observer?.closed(this.endReason);
    await this.closeBrowser();
  }
}
