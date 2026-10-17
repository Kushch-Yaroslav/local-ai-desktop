/** Preview transport; never part of LLM context or persisted history. */
export type BrowserOwnership = 'idle' | 'agent' | 'user' | 'closed' | 'unavailable';
export type BrowserInput = { kind: 'release' } | { kind: 'pointer'; phase: 'down' | 'up' | 'move'; x: number; y: number } | { kind: 'wheel'; dx: number; dy: number } | { kind: 'key'; phase: 'down' | 'up'; key: string } | { kind: 'text'; text: string } | { kind: 'back' | 'forward' | 'reload' };
export type BrowserStatus = 'loading' | 'live' | 'ended' | 'error';
export interface BrowserAction { kind: string; x?: number; y?: number; at: number }
export interface LiveBrowserState {
  conversationId: string; generationId: string; sessionId: string;
  ownership?: BrowserOwnership;
  status: BrowserStatus; url: string; error?: string; action?: BrowserAction;
}
export interface BrowserFrame {
  conversationId: string; generationId: string; sessionId: string;
  sequence: number; data: string; width: number; height: number;
}
export type LiveBrowserEvent = { type: 'state'; state: LiveBrowserState } | { type: 'frame'; frame: BrowserFrame };
export interface LiveBrowserApi {
  input(sessionId: string, input: BrowserInput): Promise<void>;
  close(sessionId: string): Promise<void>;
  watch(conversationId: string | null, visible: boolean): Promise<void>;
  acknowledge(sessionId: string, sequence: number): void;
  onEvent(listener: (event: LiveBrowserEvent) => void): () => void;
}
