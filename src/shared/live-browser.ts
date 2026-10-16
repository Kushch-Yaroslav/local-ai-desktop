/** Observation-only channel; never part of LLM context or persisted history. */
export type BrowserStatus = 'loading' | 'live' | 'ended' | 'error';
export interface BrowserAction { kind: string; x?: number; y?: number; at: number }
export interface LiveBrowserState {
  conversationId: string; generationId: string; sessionId: string;
  status: BrowserStatus; url: string; error?: string; action?: BrowserAction;
}
export interface BrowserFrame {
  conversationId: string; generationId: string; sessionId: string;
  sequence: number; data: string; width: number; height: number;
}
export type LiveBrowserEvent = { type: 'state'; state: LiveBrowserState } | { type: 'frame'; frame: BrowserFrame };
export interface LiveBrowserApi {
  watch(conversationId: string | null, visible: boolean): Promise<void>;
  acknowledge(sessionId: string, sequence: number): void;
  onEvent(listener: (event: LiveBrowserEvent) => void): () => void;
}
