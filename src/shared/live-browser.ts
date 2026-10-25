/** Native GPU surface state; no image/frame transport. */
export type BrowserOwnership = 'recovering' | 'blocked' | 'idle' | 'agent' | 'user' | 'paused' | 'closed' | 'unavailable';
export type BrowserInput = { kind: 'release' | 'focus' } | { kind: 'pointer'; phase: 'down' | 'up' | 'move'; x: number; y: number } | { kind: 'wheel'; dx: number; dy: number } | { kind: 'key'; phase: 'down' | 'up'; key: string } | { kind: 'text'; text: string } | { kind: 'back' | 'forward' | 'reload' };
export type BrowserStatus = 'loading' | 'live' | 'ended' | 'error';
export interface BrowserAction { kind: string; x?: number; y?: number; at: number }
export interface LiveBrowserState {
  conversationId: string; generationId: string; sessionId: string;
  freshness?: {status:'unknown'|'updated'|'possibly-stale';origin?:string;sourceChangedAt?:number;observedAt:number};
  visualFeedback?:import('./visual-debugging').VisualSelectionFeedback;
  workspace?:BrowserWorkspaceState;
  ownership?: BrowserOwnership;
  status: BrowserStatus; url: string; error?: string; action?: BrowserAction;
}
export type LiveBrowserEvent = { type: 'state'; state: LiveBrowserState };
export interface LiveBrowserApi {
  workspace(sessionId:string,settings:BrowserWorkspaceSettings):Promise<void>;
  input(sessionId: string, input: BrowserInput): Promise<void>;
  close(sessionId: string): Promise<void>;
  watch(conversationId: string | null, visible: boolean): Promise<void>;
  layout(sessionId: string, bounds: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  onEvent(listener: (event: LiveBrowserEvent) => void): () => void;
}

export interface BrowserWorkspaceSettings {
  layout?:'vertical'|'horizontal';
  toolsWidth?:number;
  previewScale?:number;
  viewport:'auto'|{width:number;height:number};
  /** Native page zoom; absent in legacy saved workspaces. */
  zoom?:number;
  scale:'fit'|number;
  pan:{x:number;y:number};
}
export interface BrowserWorkspaceState {
  settings:BrowserWorkspaceSettings;viewport:{width:number;height:number};
  panel:{width:number;height:number};surface:{width:number;height:number};
  displayScale:number;browserZoom:number;deviceScaleFactor:number;
  error?:string;
}
export const defaultBrowserWorkspace:BrowserWorkspaceSettings={viewport:'auto',scale:'fit',pan:{x:0,y:0}};
export function validateBrowserWorkspace(value:unknown):BrowserWorkspaceSettings {
  const s=value as BrowserWorkspaceSettings;
  if(!s||!['fit',.5,.75,1,1.25].includes(s.scale)||!s.pan||![s.pan.x,s.pan.y].every(n=>Number.isFinite(n)&&n>=0&&n<=8192))throw new Error('Invalid browser presentation');
  if(s.layout!==undefined&&!['vertical','horizontal'].includes(s.layout)||s.toolsWidth!==undefined&&(!Number.isFinite(s.toolsWidth)||s.toolsWidth<220||s.toolsWidth>520)||s.previewScale!==undefined&&![.5,.75,1,1.25].includes(s.previewScale))throw new Error('Invalid workspace layout');
  if(s.zoom!==undefined&&![.5,.67,.75,.8,.9,1,1.1,1.25,1.5].includes(s.zoom))throw new Error('Invalid page zoom');
  if(s.viewport!=='auto'&&(!s.viewport||![s.viewport.width,s.viewport.height].every(n=>Number.isInteger(n)&&n>=240&&n<=4096)||s.viewport.width*s.viewport.height>8847360))throw new Error('Viewport must fit 240–4096 px and 8.84 megapixels');
  return {...(s.layout?{layout:s.layout}:{}),...(s.toolsWidth?{toolsWidth:s.toolsWidth}:{}),...(s.previewScale?{previewScale:s.previewScale}:{}),...(s.zoom!==undefined?{zoom:s.zoom}:{}),viewport:s.viewport==='auto'?'auto':{...s.viewport},scale:s.scale,pan:{...s.pan}};
}
