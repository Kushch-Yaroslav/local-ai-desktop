/** Native browser surface state; no image/frame transport. */
export type BrowserOwnership = 'recovering' | 'blocked' | 'idle' | 'agent' | 'user' | 'paused' | 'closed' | 'unavailable';
export type BrowserInput = { kind: 'release' | 'focus' } | { kind: 'pointer'; phase: 'down' | 'up' | 'move'; x: number; y: number } | { kind: 'wheel'; dx: number; dy: number } | { kind: 'key'; phase: 'down' | 'up'; key: string } | { kind: 'text'; text: string } | { kind: 'back' | 'forward' | 'reload' };
export type BrowserStatus = 'loading' | 'live' | 'ended' | 'error';
export interface BrowserAction { kind: string; x?: number; y?: number; at: number }
export interface LiveBrowserState {
  conversationId: string; generationId: string; sessionId: string;
  ownership?: BrowserOwnership;
  status: BrowserStatus; url: string; error?: string; action?: BrowserAction;
}
export type LiveBrowserEvent = { type: 'state'; state: LiveBrowserState };
export interface LiveBrowserApi {
  input(sessionId: string, input: BrowserInput): Promise<void>;
  close(sessionId: string): Promise<void>;
  watch(conversationId: string | null, visible: boolean): Promise<void>;
  layout(sessionId: string, bounds: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  onEvent(listener: (event: LiveBrowserEvent) => void): () => void;
}
