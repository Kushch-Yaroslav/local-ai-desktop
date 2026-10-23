import {visualRegionsOverlay} from './visual-regions-overlay';
import {projectVisualRegion} from '../../shared/browser-coordinates';
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
import { qaScenarios, assertionSchema } from './browser-scenarios';
import { paths } from '../services/paths';
import { layoutScenario, responsiveOptions, viewportSchema } from './responsive-qa';
import { qaHash, qaScenarioIdentity } from './qa-loop-guard';

const qaStepSchema = {type:'object',properties:{action:{type:'string',enum:['click','fill','key','keydown','keyup','hold','scroll','focus','mousemove','drag','wait','pointer-lock']},selector:{type:'string'},value:{type:'string'},key:{type:'string'},duration_ms:{type:'integer',minimum:0,maximum:2000},repeat:{type:'integer',minimum:1,maximum:8},x:{type:'number'},y:{type:'number'},to_x:{type:'number'},to_y:{type:'number'},delta_y:{type:'number'},expect:{type:'object',properties:{selector:{type:'string'},text:{type:'string'},value:{type:'string'},changed:{type:'boolean'}},required:['selector'],additionalProperties:false}},required:['action'],additionalProperties:false};
export const projectBrowserTool: ProjectToolDefinition = { type: 'function', function: {
  name: 'web_project',
  description: 'Verify a local web project using the application Playwright browser. In Electron it is the visible native WebContentsView shared with the user (headed); only the CLI fallback is headless. Do not infer headless rendering just from Playwright. Use this browser without installing npm packages or launching Chrome in run_terminal. Screenshots capture pixels independently of Vision; set analyze=true for an explicit model image assessment when Vision is allowed. First open a project-relative HTML path (default index.html), or an explicitly approved http://localhost:PORT / http://127.0.0.1:PORT URL. Then read DOM, click a CSS selector (including hash navigation), go back/forward, reload explicitly if needed (Live Browser automatically refreshes ordinary HTML/CSS/JS edits when visible), fill a field, scroll, or capture a screenshot file. Returns JS/console/network errors. Use action qa for bounded real interaction tests and optional actual pixel analysis. For relevant UI checkpoints, responsive:{reason,viewports:[mobile,desktop]} runs isolated DOM geometry checks; omit for backend work and color-only edits. Bound acceptance scenarios specify their own viewport (named profile or width/height) and assertion source=layout, operator=equals, expected=0 for DOM bounds only. Layout candidates need review; absence of DOM defects does not prove Canvas visuals. At most 5 viewports per checkpoint. Optional breakpoint:{minWidth,maxWidth,attempts} performs 2..5 bounded diagnostic probes, without modifying acceptance criteria. Optional responsive.vision=auto analyzes candidates or Canvas only; off retains DOM checks. Never claim physical mobile/iOS testing from desktop Chromium. Visual layout QA uses an explicit viewport and assertion {source:visual_layout,path:coverage|backing|seams,selector,operator:equals,expected:0}. Coverage is only for an explicitly fullscreen target. Seams/backing-scale findings are suspects, never automatic bugs. Optional visual_layout {dpr:1|2,resize:[viewport,viewport],baseline:{report_id,scenario_id},state_key,vision:auto|on|off} captures two frames per size in the isolated QA page. Baselines must match route, viewport, DPR, scroll and scenario conditions. Targeted Vision reviews regions, never certifies all aesthetics. Use at meaningful visual/Canvas/background/height-fix checkpoints, omit for backend work. For Canvas keyboard use key/keydown/keyup/hold with real browser events, never fill(body) or hidden HTML inputs. QA may be repeated after meaningful edits without a fixed lifetime count; unchanged loops return QA_NO_PROGRESS with prior evidence. Screenshots alone are not vision. QA reports include per-action evidence; fix failures and retest. Declare scenarios with an ID, goal, correct target route/mode, preconditions, required_state, steps, assertion and timeout. Register deliverable acceptance criteria before binding deliverable_id/criterion_id. No automatic WASD or drag is performed. Use hold (300..2000 ms) for frame-based movement. Observe a stable camera/state scalar inside window.__qaDiagnostics or a specific UI value; whole-body text and background pixel animation do not prove controls. For motion supply sample_ms [0,300,800] with a numeric trend assertion; one image cannot prove dynamics. Missing observers/preconditions produce inconclusive/blocked, not an invented failure. Only the approved project/origin is reachable; no external network, file://, WebSocket, POST or arbitrary JS evaluation. With web disabled this tool is unavailable.',
  parameters: { type: 'object', properties: { analyze: { type: 'boolean', description: 'For screenshot: explicitly request model image analysis; capture works without Vision.' },
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

export type ProjectQaOptions = { regionContext?:Array<{id:string;groupId:string;url:string}>; projectId?:string; securityMode?:'strict'|'autonomous'; runId?: string; guard?: QaLoopGuard; runtimeIdentity?: unknown; analyze?: (capture: BrowserCapture, signal: AbortSignal, before?: BrowserCapture, scenario?: VisionQuestion) => Promise<BrowserVisualResult>; status?: (status: BrowserQaStatus) => void; signal?: AbortSignal };
export class ProjectBrowserSession {
  private browser?: Browser;
  private native?: NativeProjectPage;
  private context?: BrowserContext;
  private page?: Page;
  private origin?: string;
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
    await this.exclusive(async()=>{await this.clearSelection();await this.releaseInput();if(this.reusable){this.ownership='user';this.observer?.ownership?.('user');void this.refreshVisualDisplay();}});
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
  beginRun(observer: ProjectBrowserObserver, qaOptions: ProjectQaOptions = {}) {
    void this.clearSelection();
    this.qaOptions = qaOptions;
    if (!qaOptions.guard) this.fallbackGuard.rearm();
    this.authorized = false; this.denied = undefined; this.captures = 0; this.observer = observer;
    if (this.page) this.bindObserver();
  }
  async finishRun(refresh = true) {
    if (refresh) await this.exclusive(async () => { await this.watcher?.flush(); await this.refresh(true); }).catch(error=>{if(!this.closed)this.observer?.state('error',undefined,`Preview refresh failed; reopen the approved URL: ${String(error).slice(0,200)}`);});
    if (!this.reusable || !this.previewApproved) { await this.close(); return; }
    await this.releaseInput();
    this.ownership = 'user'; this.observer?.ownership?.('user');void this.refreshVisualDisplay();
  }
  async pauseRun() { await this.clearSelection(); this.ownership = this.userSession?'user':'paused'; await this.releaseInput(); this.observer?.ownership?.(this.ownership);void this.refreshVisualDisplay(); }
  private bindObserver() {
    this.observer?.ready(this.page!, visible => { this.previewVisible = visible; this.scheduleRefresh(); }, { input: input => this.input(input), suspend:()=>this.clearSelection(), policyChanged:()=>this.policyChanged(), close: reason => this.close(false,reason??'user_closed') });
    this.observer?.ownership?.(this.ownership);void this.refreshVisualDisplay();
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
    if(!this.displayTimer&&regions.length){this.displayTimer=setInterval(()=>{void this.refreshVisualDisplay().catch(()=>undefined);},200);this.displayTimer.unref();}
    if(!regions.length){clearInterval(this.displayTimer);this.displayTimer=undefined;}
    return this.displayState;
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
    const evidence=await groundRegion(page,rect);
    if(new URL(evidence.url).origin!==this.origin || rect.x+rect.width>evidence.viewport.width+1 || rect.y+rect.height>evidence.viewport.height+1)throw new Error('Selection outside approved viewport');
    const id='region-'+randomUUID();
    const region:VisualRegion={...evidence,sourceHints:Array.from(this.servedRevisions).slice(0,12).map(([path,sha256])=>({path,sha256})),id,conversationId:'',projectId:this.qaOptions.projectId??'',projectRoot:this.root,groupId,createdAt:new Date().toISOString()};
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
    const safe=regions.filter(r=>r.projectRoot===this.root).map(r=>({id:r.id,url:r.url,rect:r.rect,viewport:r.viewport,dpr:r.dpr,snapshot:r.snapshot,anchors:r.anchors.map(a=>({tag:a.tag,selector:a.selector,confidence:a.confidence,rect:a.rect,identity:a.identity}))}));
    const inspect=(regions:VisualRegion[],project:typeof projectVisualRegion)=>regions.map(r=>{const result=project(r);return {id:r.id,live:{url:location.href,viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,scroll:{x:scrollX,y:scrollY},...result,observedAt:new Date().toISOString()}};});
    const results=await this.page.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})(${JSON.stringify(safe)},${projectVisualRegion.toString()})`);
    return regions.map(r=>({...r,live:results.find(result=>result.id===r.id)?.live}));
  }
  async visualReveal(region: VisualRegion, siblings: VisualRegion[]=[region]) {
    const page=this.page;
    if(!this.reusable||!page||region.projectRoot!==this.root)throw new Error('Region outside current preview scope');
    const epoch=this.visualEpoch;
    const currentUrl=page.url(),needsNavigation=currentUrl!==region.url;
    const view={regionId:region.id,url:region.url,currentUrl,needsNavigation,stale:false,reason:undefined as string|undefined,screenshotOnly:!region.anchors.length,scrollDeferred:this.ownership!=='user'||Boolean(this.operationAbort),diagnostics:[] as string[]};
    if(needsNavigation){view.diagnostics.push('Region belongs to another route; explicit navigation is required');return view;}
    // While the agent owns the page, read geometry without scrolling or changing its DOM.
    const data={region,siblings,scroll:!view.scrollDeferred};
    // Pass only safe page geometry, never host paths or source file contents.
    const safe=(r:VisualRegion)=>({id:r.id,url:r.url,rect:r.rect,viewport:r.viewport,dpr:r.dpr,snapshot:r.snapshot,color:r.color,groupNumber:r.groupNumber,anchors:r.anchors.map(a=>({tag:a.tag,confidence:a.confidence,selector:a.selector,rect:a.rect,identity:a.identity}))});
    const inspect=({region,siblings,scroll}:typeof data,project:typeof projectVisualRegion)=>{
      const before=project(region);
      if(scroll&&!before.stale){const anchor=region.anchors.find(a=>a.confidence>=.8);if(anchor)document.querySelector(anchor.selector)?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});else scrollTo(region.rect.x,Math.max(0,region.rect.y-innerHeight/3));}
      return {stale:before.stale,reason:before.reason,url:location.href,boxes:siblings.flatMap(r=>{const result=project(r);return result.rect?[{...result.rect,color:r.color??'#22d3ee',label:`${r.groupNumber??''} · #${r.id}`}]:[];})};
    };
    const result=await page.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})(${JSON.stringify({region:safe(region),siblings:siblings.map(safe),scroll:data.scroll})},${projectVisualRegion.toString()})`);
    if(result.url!==region.url){view.currentUrl=result.url;view.needsNavigation=true;view.diagnostics.push('The page changed while viewing; no original-route claim was made');return view;}
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
    await this.exclusive(async()=>{if(this.ownership!=='user'||!this.page||region.projectRoot!==this.root||new URL(region.url).origin!==this.origin)throw new Error('Region outside current preview scope');await this.clearSelection();if(this.page.url()!==region.url)await this.page.goto(region.url,{waitUntil:'load'});});
    return this.visualReveal(region);
  }
  get visualWorkspace(){return this.native?.workspaceState?.()?.settings;}
  async visualRecheck(regions:VisualRegion[]):Promise<BrowserQaReport>{
    return this.exclusive(async()=>{
      if(this.ownership!=='user'||!this.page||!this.reusable)throw new Error('Recheck requires user ownership');
      if(!regions.length||regions.length>6)throw new Error('Recheck supports one to six selections');
      const first=regions[0],page=this.page;
      if(regions.some(r=>r.projectRoot!==this.root||new URL(r.url).origin!==this.origin||r.url!==first.url||r.viewport.width!==first.viewport.width||r.viewport.height!==first.viewport.height))throw new Error('Recheck requires one approved route and original viewport');
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
          if(this.native&&originalWorkspace)await this.native.workspace({...originalWorkspace,viewport});
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
  private autoReloadQueued = false;
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
  private stopWatching() { this.watcher?.close(); this.watcher = undefined; clearTimeout(this.reloadTimer); this.dirty = false; }
  private async ensureWatching() {
    if (this.isolatedQa || !this.observer || this.watcher || this.serverManaged || this.closed || !this.page || this.page.isClosed()) return;
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
    if(new URL(this.page.url()).origin!==this.origin){this.observer?.state('error',undefined,'Preview navigation failed; reopen the approved project URL.');return;}
    this.navigationRecoveryUsed=false;
    const response = await this.page.reload({ waitUntil: 'load' });
    if (response && !response.ok()) throw new Error(`Preview HTTP ${response.status()}`);
    // Let the real page settle before reporting the refreshed revision.
    if(this.closed||this.page.isClosed())return;
    await this.page.waitForTimeout(150);
    if (!this.closed) { this.observer?.action({ kind: 'auto-reload', at: Date.now() }); this.observer?.state('live', this.page.url()); }
  }
  private detectServerReload(path: string, body: Buffer, html: boolean) {
    if (this.origin === staticOrigin || this.serverManaged) return;
    if (/^\/(?:@vite\/client|@react-refresh|_next\/|__webpack_hmr)/.test(path) || (html && /(?:\/@vite\/client|\/_next\/|__NEXT_DATA__|webpack-dev-server|webpack-hot-middleware|parcelRequire.*hmr)/i.test(body.toString('utf8')))) {
      this.serverManaged = true; this.stopWatching();
    }
  }
  constructor(private readonly root: string, private readonly captureDirectory: string, private readonly launch: () => Promise<Browser> = launchWebBrowser, private observer?: ProjectBrowserObserver, private qaOptions: ProjectQaOptions = {}, private readonly isolatedQa=false) {}
  private note(list: string[], text: string) { if (list.length < 40) list.push(text.slice(0, 500)); }
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
      this.networkBudget = { requests:0, bytes:0, started:Date.now() };
      if (signal.aborted || this.closed || this.page?.isClosed() || this.browser&&!this.browser.isConnected())return {error:'Project browser is unavailable; open it explicitly in an authorized new task, or recreate a lost connection.',code:signal.aborted&&!this.closed?'BROWSER_OPERATION_CANCELLED':'BROWSER_SESSION_UNAVAILABLE',retrySameArguments:!signal.aborted&&['connection_lost','page_closed','renderer_crashed'].includes(this.endReason),browser_session:this.stateIdentity};
      const references=this.qaOptions.regionContext??[];
      const expected=references.map(r=>r.url),current=this.page?.url();
      if(references.length&&['read','screenshot','qa'].includes(String(args.action))&&current){
        let mismatch=!expected.includes(current);
        if(args.action==='qa'&&Array.isArray(args.scenarios))for(const scenario of args.scenarios){const scoped=references.filter(r=>r.groupId===scenario.deliverable_id);if(scoped.length&&!scoped.some(r=>new URL(scenario.target,current).href===r.url))mismatch=true;}
        if(mismatch)return {error:'REGION_ROUTE_MISMATCH: the current/QA route differs from the selected region. Preserve full URL query and hash; explicitly open the reference URL before analyzing it.',code:'REGION_ROUTE_MISMATCH',current_url:visualPromptUrl(current),region_urls:expected.map(visualPromptUrl),retrySameArguments:false};
      }
      if (!keyboardActions.has(String(args.action))&&(!responsiveRequest(args)||this.isolatedQa)) await this.releaseInput();
      if (args.action === 'qa' && (!this.page || !responsiveRequest(args)&&(args.path !== undefined || args.url !== undefined)) && !this.denied) {
        const opened = await this.executePage({action:'open', ...(args.path ? {path:args.path} : {}), ...(args.url ? {url:args.url} : {})}, signal, confirm, actionId);
        if (opened && typeof opened === 'object' && 'error' in opened) return opened;
      }
      if (this.denied) return { error: 'Browser authorization was denied for this run', code: 'PERMISSION_DENIED', reason: this.denied, layer: 'browser_approval', retrySameArguments: false };
      if (!this.authorized && (args.action === 'open' || this.page)) {
        const proposed = args.url !== undefined ? loopbackTarget(String(args.url)).origin : this.origin ?? staticOrigin;
        if(this.origin&&proposed!==this.origin){this.ownership='user';this.observer?.ownership?.('user');void this.refreshVisualDisplay();return {error:'Requested origin differs from the approved preview origin; keep project-relative navigation on the existing origin.',code:'PREVIEW_ORIGIN_SCOPE_MISMATCH',expectedOrigin:this.origin,requestedOrigin:proposed,retrySameArguments:false,browser_session:this.stateIdentity};}
        const automatic=this.qaOptions.securityMode==='autonomous'&&Boolean(this.qaOptions.projectId);
        if(automatic)log('agent.browser.preview.auto-approved',{projectId:this.qaOptions.projectId,root:this.root,origin:proposed,mode:'autonomous',capability:'read-only-local-preview'});
        const decision = automatic?{approved:true,reason:'once' as const}:await confirm?.({ title: 'Проверка локального проекта в браузере', root: this.root, category: 'browser_preview', preview:{projectId:this.qaOptions.projectId??this.root,origin:proposed},actionId,
          detail: `Разрешить браузер проекта ${this.root} для этой операции? Разрешение «в этой сессии» действует в текущем чате до отзыва, смены проекта/режима или закрытия приложения. Origin: ${proposed}. Только GET, без внешней сети.` }, signal);
        if (!decision?.approved || signal.aborted) {
          this.ownership='user';this.observer?.ownership?.('blocked');
          this.denied = decision?.reason ?? 'ui_unavailable';
          return { error: 'Project browser authorization denied', code: 'PERMISSION_DENIED', reason: this.denied, layer: 'browser_approval', origin: proposed, projectRoot: this.root, retrySameArguments: false };
        }
        this.authorized = true;this.previewApproved=true;
      }
      if(!responsiveRequest(args)||this.isolatedQa){this.ownership='agent';this.observer?.ownership?.('agent');await this.refreshVisualDisplay();}
      if(args.analyze!==undefined&&typeof args.analyze!=='boolean')throw Error('analyze must be boolean');
      const waitMs = args.wait_ms ?? 100;
      if (!Number.isInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > 2000) throw new Error('wait_ms must be 0..2000');
      if (['read', 'screenshot', 'qa'].includes(String(args.action)) && this.watcher && !responsiveRequest(args)) { await this.watcher.flush(); await this.refresh(); }
      signal.throwIfAborted();
      if (args.action === 'open') {
        if (args.path !== undefined && args.url !== undefined) throw new Error('Choose path or url');
        const url = args.url !== undefined ? loopbackTarget(String(args.url)) : new URL('/' + String(args.path ?? 'index.html').replace(/^\//, ''), this.origin??staticOrigin);
        if (url.origin !== (this.origin??staticOrigin) && args.url === undefined) throw new Error('Invalid project path');
        if (this.origin && this.origin !== url.origin){this.ownership='user';this.observer?.ownership?.('user');void this.refreshVisualDisplay();return {error:'Origin differs from the approved preview. Keep project-relative navigation on the current origin; another origin requires a new explicitly authorized session.',code:'PREVIEW_ORIGIN_SCOPE_MISMATCH',retrySameArguments:false,browser_session:this.stateIdentity};}
        const newPage = !this.origin;
        if (!this.origin) {
          this.origin = url.origin;
          this.observer?.state('loading', url.href);
          await this.start();
        }
        signal.throwIfAborted();this.errors.length = 0; this.blocked.length = 0; this.servedRevisions.clear();
        this.observer?.state('loading', url.href);
        const response = await this.page!.goto(url.href, { waitUntil: 'load' });
        if(response && [401,403].includes(response.status()))return {error:'Authentication required; no authorization bypass was attempted',code:'AUTH_REQUIRED',retrySameArguments:false};
        if (response && !response.ok()) throw new Error(`Preview HTTP ${response.status()}`);
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
          let steps, scenarios, responsive; try {
            steps=qaSteps(args.checks);scenarios=qaScenarios(args.scenarios);responsive=responsiveOptions(args.responsive);
            if(!this.isolatedQa&&responsive&&scenarios.length&&(args.responsive as Record<string,unknown>).viewports!==undefined)throw new Error('Declare viewport separately in each immutable scenario, rather than applying global viewports to bound criteria');
            if(!this.isolatedQa&&responsive?.breakpoint&&scenarios.length)throw new Error('Breakpoint probes are diagnostics; execute registered acceptance scenarios separately');
            if(responsive&&!scenarios.length){const target=String(args.url??args.path??this.page.url()),b=responsive.breakpoint;scenarios=(b?[{width:b.minWidth,height:844},{width:b.maxWidth,height:844}]:responsive.viewports).map((v,i)=>layoutScenario(`responsive-${i+1}`,target,v));}
            if(new Set(scenarios.flatMap(s=>[...(s.viewport?[s.viewport]:[]),...(s.visual_layout?.resize??[])]).map(v=>`${v.width}x${v.height}`)).size>5)throw new Error('At most 5 viewports per QA checkpoint');
            if(!this.isolatedQa&&scenarios.some(s=>s.viewport))return await this.isolatedResponsive(args,scenarios,signal,actionId);
          } catch(error) { return {error:String(error),code:'INVALID_QA_ARGUMENTS',retrySameArguments:false}; }
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
          const qa = await runBrowserQa({ page: this.page, signal: qaSignal, steps, scenarios, responsive, sourceRevisions:()=>Object.fromEntries(this.servedRevisions), navigate:async target=>{const url=new URL(target,this.page!.url());if(url.origin!==this.origin)throw new Error('Scenario target outside approved origin');const current=new URL(this.page!.url());if(this.isolatedQa||url.pathname!==current.pathname||url.search!==current.search)this.servedRevisions.clear();if(this.isolatedQa){this.errors.length=0;this.blocked.length=0;}let response=await this.page!.goto(url.href,{waitUntil:'load',timeout:10000});if(this.isolatedQa&&!response)response=await this.page!.reload({waitUntil:'load',timeout:10000});if(response&&[401,403].includes(response.status()))return {authRequired:true};if(response&&!response.ok())throw new Error(`Preview HTTP ${response.status()}`);return {};}, errors: () => [...this.errors, ...this.blocked], metrics:()=>this.qaMetrics(), capture: cdp => this.capture({}, qaSignal, cdp), baseline:ref=>this.visualBaseline(ref), analyze: this.qaOptions.analyze ? (capture, before, scenario) => this.qaOptions.analyze!(capture, qaSignal, before, scenario) : undefined, status: this.qaOptions.status });
          qa.runId = this.qaOptions.runId; qa.revisionFingerprint = revision;
          const sourceRevisions:Record<string,string> = Object.assign({},...qa.scenarios?.map(scenario=>scenario.sourceRevisions??{})??[],Object.fromEntries(this.servedRevisions));
          qa.sourceRevisions=sourceRevisions;
          if(this.isolatedQa&&Object.keys(sourceRevisions).length)qa.revisionFingerprint=qaHash(Object.entries(sourceRevisions).sort());
          const afterRevision=this.isolatedQa&&Object.keys(qa.sourceRevisions??{}).length>0&&!await this.revisionsChanged(qa.sourceRevisions??{})?revision:await projectRevision(this.root,[this.captureDirectory,paths.userData,paths.configDirectory,paths.cache,paths.logs,paths.attachments,join(paths.dataRoot,'sqlite'),join(paths.dataRoot,'protected-runtime.json'),join(paths.dataRoot,'llama-cpp-runtime-state.json')]);
          if(afterRevision!==revision){qa.status='Not Verified';qa.functionalStatus='Not Verified';qa.reasonCode='EVIDENCE_STALE';qa.reason='Project changed during QA; retain observations and rerun the affected scenarios.';for(const result of qa.scenarios??[]){result.status='Not Verified';if(result.visualLayout)result.visualLayout.status='Blocked';}}
          const source = await this.read();
          if (source.source_path) { const bytes = await readPreviewAsset(this.root, new URL(this.page.url()).pathname); qa.sourceFingerprint = screenshotHash(bytes.body); }
          await this.saveQa(qa);
          this.qaGuard.record(key, qa, await this.qaState(scenarios));
          if(this.isolatedQa)this.qaGuard.rememberResponsive(scope,qa);
          return { ...source, qa, visual_analysis: qa.visual.analyzed };
        } else if (args.action === 'screenshot') {
          if (this.captures >= 8) throw new Error('Screenshot limit reached (8 explicit screenshots per run; QA captures are independent)');
          this.qaOptions.status?.({phase:'capturing'});
          await this.page.waitForTimeout(Number(waitMs));
          const capture = await this.capture(args, signal);
          this.captures++;
          if (this.qaOptions.analyze && args.analyze !== false) this.qaOptions.status?.({phase:'analyzing'});
          const visual: BrowserVisualResult = this.qaOptions.analyze && args.analyze !== false ? await this.qaOptions.analyze(capture, signal, undefined, args.analyze === true ? {goal:'Inspect this explicitly requested screenshot; no interaction claim.',temporal:false,purpose:'requested'}:undefined) : { analyzed: false, status: 'Not Verified', reason: args.analyze === false ? 'Image analysis was not requested; capture retained.' : 'Vision Off or unavailable; capture retained without model image analysis.' };
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
      if(this.reusable){await this.releaseInput();this.ownership='user';this.observer?.ownership?.('user');void this.refreshVisualDisplay();}
      // Failed startup cannot leave a half-initialized reusable session.
      const code=String(error).includes('Screenshot limit reached')?'SCREENSHOT_LIMIT':this.endReason==='user_closed'?'BROWSER_USER_CLOSED':this.endReason==='operation_cancelled'?'BROWSER_OPERATION_CANCELLED':['connection_lost','renderer_crashed'].includes(this.endReason)?'BROWSER_CONNECTION_LOST':this.endReason==='page_closed'?'BROWSER_PAGE_CLOSED':this.endReason==='policy_changed'?'BROWSER_POLICY_CHANGED':this.endReason==='preview_unavailable'?'BROWSER_PREVIEW_UNAVAILABLE':signal.aborted?'BROWSER_OPERATION_CANCELLED':!this.page&&this.origin?'BROWSER_UNAVAILABLE':'PROJECT_BROWSER_FAILED';
      if (this.origin && (!this.page || this.page.isClosed())) this.observer?.state('error', undefined, String(error).slice(0, 300));
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
      return await child.execute({...args,scenarios,...(this.origin===staticOrigin?{path:target.pathname+target.search+target.hash,url:undefined}:{url:target.href,path:undefined})},operation,async()=>({approved:true,reason:'once'}),actionId);
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
      // Capture follows this privacy DOM/layout task; native and CDP paths share masks.
      // Hidden QA pages deliberately have no rAF; waiting for it would deadlock privacy capture.
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
      try{const asset=await readPreviewAsset(this.root,'/'+relative(this.root,path));bytes+=asset.body.length;if(bytes>32*1024*1024||screenshotHash(asset.body)!==hash)return true;}catch{return true;}
    }
    return false;
  }
  private async currentSourceRevisions(revisions:Record<string,string>) {
    const current:Record<string,string>={};let bytes=0;
    if(Object.keys(revisions).length>64)throw new Error('Responsive dependency set exceeds 64 assets');
    for(const path of Object.keys(revisions).sort()){
      if(bytes>=32*1024*1024){current[path]='[budget exceeded]';continue;}
      try{const asset=await readPreviewAsset(this.root,'/'+relative(this.root,path));bytes+=asset.body.length;if(bytes>32*1024*1024)throw new Error('Responsive dependency bytes exceeded');current[path]=screenshotHash(asset.body);}catch{current[path]='[unavailable]';}
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
    this.detectServerReload(url.pathname,response.body,Boolean(response.headers['content-type']?.includes('text/html')));
    return {...response,headers:{...response.headers,...safetyHeaders,'content-security-policy':[response.headers['content-security-policy'],previewCsp].filter(Boolean).join(', ')}};
  }
  private async start() {
    this.native = await this.observer?.createPage?.(this.origin!);
    this.browser = this.native?.browser ?? await this.launch();
    if (this.closed) { if(this.native)await this.native.close();else if(!this.isolatedQa)await this.browser.close();throw new Error('Project browser cancelled during launch'); }
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
    this.endReason='live';
    this.page.on('crash', () => {this.endReason='renderer_crashed'; this.observer?.state('error', undefined, 'Browser renderer crashed'); void this.close(false,'renderer_crashed'); });
    this.page.on('close', () => {clearInterval(this.displayTimer);this.displayTimer=undefined; if(!this.closed)this.endReason='page_closed';this.stopWatching(); if (!this.closed) this.observer?.state('error', undefined, 'Browser page closed'); });
    this.bindObserver();
    if(!this.isolatedQa)this.browser.on('disconnected', () => { if(!this.closed)this.endReason='connection_lost';this.stopWatching(); if (!this.closed) this.observer?.state('error', undefined, 'Browser disconnected'); this.observer?.closed(this.endReason); });
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
    const dom = await page.evaluate(() => ({ title: document.title, url: location.href, content: document.body.innerText.slice(0, 12_000), links: Array.from(document.querySelectorAll('a[href]')).slice(0, 40).map(a => ({ text: a.textContent, href: (a as HTMLAnchorElement).href })) }));
    return { region_context:{current_url:visualPromptUrl(page.url()),references:(this.qaOptions.regionContext??[]).map(r=>({...r,url:visualPromptUrl(r.url),matches_current:r.url===page.url()}))}, browser_session:this.stateIdentity, source_revisions:Object.fromEntries(this.servedRevisions), ...dom, ...(this.origin === staticOrigin ? { source_path: await projectPath(this.root, decodeURIComponent(new URL(page.url()).pathname).slice(1) || 'index.html') } : {}), javascript_errors: [...this.errors], blocked_requests: [...this.blocked], browser_check: `DOM and runtime diagnostics only; screenshots require separate visual analysis. Display: ${this.native ? 'native Electron WebContentsView (headed), same Page as Live Browser' : 'headless CLI Chromium'}` };
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
