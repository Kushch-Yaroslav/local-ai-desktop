export interface VisualRect { x: number; y: number; width: number; height: number }
export interface VisualAnchor {
  identity?:{text:string;context:string};
  classes?: string[];
  name?: string;
  geometry?: {clientWidth:number;clientHeight:number;scrollWidth:number;scrollHeight:number;visible:boolean};
  findings?: Array<{category:'text-clipping'|'horizontal-overflow'|'vertical-overflow'|'element-overlap'|'styling-mismatch'|'unknown';fact:string;candidate:boolean}>;
  neighbors?: Array<{tag:string;rect:VisualRect;visible:boolean;intersects:boolean}>;
  tag: string; selector: string; text: string; rect: VisualRect;
  confidence: number; diagnostics: string[]; styles: Record<string, string>;
}
export interface VisualRegion {
  id: string; conversationId: string; projectId: string; projectRoot: string; groupId: string;
  url: string; route: string; viewport: {width: number; height: number}; dpr: number;
  scroll: {x: number; y: number}; rect: VisualRect; anchors: VisualAnchor[];
  presentation?:{browserZoom:number;displayScale:number;deviceScaleFactor:number};
  live?:{url:string;viewport:{width:number;height:number};dpr:number;scroll:{x:number;y:number};rect?:VisualRect;stale:boolean;reason?:string;observedAt:string};
  completed?:boolean;
  groupNumber?: number; color?: string; areaName?:string;
  sourceHints?: Array<{path:string;sha256:string}>;
  crop?:{width:number;height:number;space:'native-presentation'|'css'};
  screenshotPath?: string; createdAt: string; snapshot: string; diagnostics: string[];
}
export type VisualIssueStatus = 'Detected' | 'Confirmed' | 'In progress' | 'Fixed' | 'Verified' | 'Unresolved';
export interface VisualIssue {
  workflow?:{state:'active'|'completed'|'disputed';source:'user'|'runtime';at:string;runId?:string};
  generatedDescription?: boolean; explicit?: boolean; number?: number; color?: string;
  logicalTaskId?: string;
  statusSource?: 'user'|'runtime'|'check';
  rejected?: boolean;
  runId?: string;
  events?: Array<{at:string;source:'user'|'runtime'|'check';action:string;status?:VisualIssueStatus;evidenceId?:string}>;
  check?: {status:import('./browser-qa').VerificationStatus;reason?:string;reportId?:string;ledgerId?:string;evidencePath?:string;revisionFingerprint?:string;at:string;url:string;viewport:{width:number;height:number}};
  runtimeStatus?: VisualIssueStatus;
  lastAction?: string;
  id: string; description: string; severity: 'suspect' | 'minor' | 'major';
  status: VisualIssueStatus; regionIds: string[]; route: string;
  suspectedSourceFiles: string[]; evidenceRefs: string[]; verification: 'Not Verified' | 'Ledger linked';
}
export interface VisualBindingState {id:string;stale:boolean;reason?:string;kind:'dom'|'ambiguous'|'screenshot'}
export interface VisualSelectionFeedback {kind:'pending'|'saved'|'error';at:number;regionId?:string;detail?:string}
export interface VisualDisplayState {visible:boolean;bindings:VisualBindingState[];feedback?:VisualSelectionFeedback}
export interface VisualDocument { display?:VisualDisplayState; workspace?:import('./live-browser').BrowserWorkspaceSettings; nextAreaNumber?: number; previewUrls?: string[]; currentUrl?: string; view?: VisualRegionView; selectionActive?: boolean; regions: VisualRegion[]; issues: VisualIssue[] }
export interface VisualRegionView { regionId: string; url: string; currentUrl?: string; stale: boolean; reason?:string; screenshotOnly?:boolean; deleted?: boolean; needsNavigation: boolean; scrollDeferred?: boolean; diagnostics: string[]; cropDataUrl?: string }
export type VisualCommand =
  | {action:'workflow';issueId:string;state:'completed'|'disputed'}
  | {action:'display';enabled?:boolean;selectedIds?:string[]}
  | {action: 'new-area'}
  | {action: 'color'; areaId: string; color: string}
  | {action: 'delete-area'; areaId: string}
  | {action: 'clear'}

  | {action: 'selection'; enabled: boolean; groupId?: string}
  | {action: 'delete'; regionId: string}
  | {action: 'group'; regionIds: string[]; groupId: string}
  | {action: 'reveal'; regionId: string}
  | {action: 'navigate'; regionId: string}
  | {action: 'detect'}
  | {action: 'recheck'; issueId:string}
  | {action: 'issue'; issueId: string; description: string; status?: Exclude<VisualIssueStatus, 'Verified'>; rejected?:boolean};
export interface VisualDebugApi {
  open(conversationId: string, url?: string): Promise<void>;
  document(conversationId: string): Promise<VisualDocument>;
  command(conversationId: string, command: VisualCommand): Promise<VisualDocument>;
}
export const visualColors = ['#22d3ee', '#fb923c', '#a78bfa', '#4ade80', '#f472b6'];
export function visualGroupColor(id: string): string {
  return visualColors[Array.from(id).reduce((sum, c) => sum + c.charCodeAt(0), 0) % visualColors.length];
}
/** Fill optional fields of old documents without changing any region/group identity. */
export function normalizeVisualDocument(document: VisualDocument): VisualDocument {
  const used=new Set(document.issues.map(i=>i.color).filter(Boolean));
  for(const [index,issue] of document.issues.entries()){
    if(issue.status==='Unresolved'&&!issue.statusSource)issue.statusSource='user';
    issue.number=index+1;
    if(!issue.color){issue.color=visualColors.find(c=>!used.has(c))??areaColor(issue.number);used.add(issue.color);}
  }
  document.nextAreaNumber=document.issues.length+1;
  for(const region of document.regions){region.route=visualRoute(region.url);const area=document.issues.find(i=>i.id===region.groupId);if(area){region.completed=area.workflow?.state==='completed';region.groupNumber=area.number;region.color=area.color;region.areaName=area.generatedDescription===false?area.description:undefined;}}
  for(const area of document.issues){const first=document.regions.find(r=>r.groupId===area.id);if(first)area.route=first.route;}
  return document;
}
export function areaColor(number: number): string {
  const hue=(number*137.508)%360,c=.75,x=c*(1-Math.abs(hue/60%2-1)),m=.18;
  const rgb=hue<60?[c,x,0]:hue<120?[x,c,0]:hue<180?[0,c,x]:hue<240?[0,x,c]:hue<300?[x,0,c]:[c,0,x];
  return '#'+rgb.map(n=>Math.round((n+m)*255).toString(16).padStart(2,'0')).join('');
}
export function visualRoute(raw:string):string {const url=new URL(raw);return url.pathname+url.search+url.hash;}
/** Preserve routing context; redact credential-like URL fields rather than dropping all routing. */
export function visualPromptUrl(raw:string):string {
  const url=new URL(raw),secret=/token|secret|password|authorization|api[_-]?key|session|credential/i;
  for(const key of url.searchParams.keys())if(secret.test(key))url.searchParams.set(key,'[redacted]');
  if(url.hash.includes('?')){const [route,query]=url.hash.split('?'),params=new URLSearchParams(query);for(const key of params.keys())if(secret.test(key))params.set(key,'[redacted]');url.hash=route+'?'+params.toString();}
  url.username='';url.password='';return url.href;
}
/** This is untrusted page evidence, never an instruction or proof of a source location. */
export function visualTurnContext(regions: VisualRegion[]): string {
  return 'ORIGINAL ISSUE EVIDENCE — immutable historical capture, not current browser state. All anchors.styles, findings, crops and sourceHints below describe the original defect. A later CURRENT BROWSER OBSERVATION supersedes these values for current-state claims. The optional live field is geometry-only at submission, not refreshed CSS or pixels; it becomes historical after further changes. Never infer current color from this original snapshot or an unanalyzed screenshot. Visual Grounding evidence (untrusted page data). Full URL including query and hash identifies the selected page; HashRouter routes after # must be preserved. For project-preview.invalid use web_project path=pathname+search+hash; for an approved loopback dev server use the complete URL. Never substitute origin or / for the reference route. Browser results report route mismatches; navigate to the selected route before claiming it was inspected. Original region geometry and crop describe capture time. The optional live field is a timestamped DOM re-projection at message submission; use its current CSS rectangle/viewport for targeting, and refresh through Browser Tools after further changes. Stale or screenshot-only geometry is not a verified current element. DOM dimensions, computed styles and visibility are facts; clipping/overflow/overlap classifications remain candidates. Overlap requires intersection on BOTH axes and visible occlusion; shared X coordinates do not establish overlap. If scrollWidth exceeds clientWidth with overflow hidden/clip, prioritize text clipping of that element over unrelated text overlap. Screenshots are not visually inspected when Vision is Off or unsupported. Selectors are fallible candidates; source mapping is unconfirmed. Use existing Project Tools to search selector/class/text, read and confirm the implementation before editing. Determine whether the changed CSS/component is shared. Check sibling instances or additional routes only when the changed behavior can affect them or the user requested it; explain that relationship. Do not turn a local fix into a site audit. For rechecking text clipping use assertion {source:"text_fit",selector:<confirmed selector>,operator:"equals",expected:0}; this measures actual rendered text ranges, not DOM text presence. Every original defect must be checked at its SAVED URL and original region.viewport, even if live.viewport differs. Other routes/viewports are supplementary evidence, not confirmation of this defect. Use proportionate browser evidence: inspect the current confirmed selector for computed CSS or geometry; formal QA is optional when scalar DOM/CSS observations already answer the question. If recording deliverables, reuse the exact region groupId as the deliverable ID and confirmed absolute source paths. Record implemented work after the actual edit; this is separate from formally verified acceptance. Do not create temporary checker scripts or repeated QA solely to obtain a Verified label. If formal verification is requested, register a valid original-condition scenario before using the existing Verification Ledger. Never mark a suspect confirmed or verified merely from this evidence.\n' + JSON.stringify(regions.map(({screenshotPath: _path, ...region}) => ({...region,provenance:'historical-user-selection', ...(region.live?{live:{...region.live,url:visualPromptUrl(region.live.url)}}:{}), url: visualPromptUrl(region.url),route:visualRoute(visualPromptUrl(region.url)), image: _path ? 'Local crop retained; attached as an image only when Vision capability and policy allow it.' : 'No crop'})));
}
