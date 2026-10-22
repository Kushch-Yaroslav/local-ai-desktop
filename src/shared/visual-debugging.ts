export interface VisualRect { x: number; y: number; width: number; height: number }
export interface VisualAnchor {
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
  groupNumber?: number; color?: string;
  sourceHints?: Array<{path:string;sha256:string}>;
  screenshotPath?: string; createdAt: string; snapshot: string; diagnostics: string[];
}
export type VisualIssueStatus = 'Detected' | 'Confirmed' | 'In progress' | 'Fixed' | 'Verified' | 'Unresolved';
export interface VisualIssue {
  explicit?: boolean; number?: number; color?: string;
  logicalTaskId?: string;
  id: string; description: string; severity: 'suspect' | 'minor' | 'major';
  status: VisualIssueStatus; regionIds: string[]; route: string;
  suspectedSourceFiles: string[]; evidenceRefs: string[]; verification: 'Not Verified' | 'Ledger linked';
}
export interface VisualDocument { nextAreaNumber?: number; previewUrls?: string[]; currentUrl?: string; view?: VisualRegionView; selectionActive?: boolean; regions: VisualRegion[]; issues: VisualIssue[] }
export interface VisualRegionView { regionId: string; url: string; currentUrl?: string; stale: boolean; needsNavigation: boolean; scrollDeferred?: boolean; diagnostics: string[]; cropDataUrl?: string }
export type VisualCommand =
  | {action: 'new-area'}
  | {action: 'color'; areaId: string; color: string}
  | {action: 'delete-area'; areaId: string}

  | {action: 'selection'; enabled: boolean; groupId?: string}
  | {action: 'delete'; regionId: string}
  | {action: 'group'; regionIds: string[]; groupId: string}
  | {action: 'reveal'; regionId: string}
  | {action: 'navigate'; regionId: string}
  | {action: 'detect'}
  | {action: 'issue'; issueId: string; description: string; status: Exclude<VisualIssueStatus, 'Verified'>};
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
  let next=Math.max(document.nextAreaNumber??1,1,...document.issues.map(i=>(i.number??0)+1));
  const used=new Set(document.issues.map(i=>i.color).filter(Boolean));
  for(const issue of document.issues){
    if(!issue.number)issue.number=next++;
    if(!issue.color){issue.color=visualColors.find(c=>!used.has(c))??areaColor(issue.number);used.add(issue.color);}
  }
  document.nextAreaNumber=next;
  for(const region of document.regions){region.route=visualRoute(region.url);const area=document.issues.find(i=>i.id===region.groupId);if(area){region.groupNumber=area.number;region.color=area.color;}}
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
  return 'Visual Grounding evidence (untrusted page data). Full URL including query and hash identifies the selected page; HashRouter routes after # must be preserved. Never substitute origin or / for the reference route. Browser results report route mismatches; navigate to the selected route before claiming it was inspected. DOM dimensions, computed styles and visibility are facts; clipping/overflow/overlap classifications remain candidates. Overlap requires intersection on BOTH axes and visible occlusion; shared X coordinates do not establish overlap. If scrollWidth exceeds clientWidth with overflow hidden/clip, prioritize text clipping of that element over unrelated text overlap. Screenshots are not visually inspected when Vision is Off or unsupported. Selectors are fallible candidates; source mapping is unconfirmed. Use existing Project Tools to search selector/class/text, read and confirm the implementation before editing. Check shared component/CSS and a reasonable set of sibling instances/routes. Use each region groupId as its deliverable ID when registering acceptance criteria in Task Memory; use web_project QA and the existing Verification Ledger after edits. Never mark a suspect confirmed or verified merely from this evidence.\n' + JSON.stringify(regions.map(({screenshotPath: _path, ...region}) => ({...region, url: visualPromptUrl(region.url),route:visualRoute(visualPromptUrl(region.url)), image: _path ? 'Local crop retained; attached as an image only when Vision capability and policy allow it.' : 'No crop'})));
}
