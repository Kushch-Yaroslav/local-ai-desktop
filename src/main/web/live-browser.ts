import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { CDPSession, Page } from 'playwright-core';
import type { BrowserAction, BrowserFrame, BrowserStatus, LiveBrowserEvent, LiveBrowserState, BrowserInput, BrowserOwnership } from '../../shared/live-browser';

export interface ProjectBrowserObserver {
  readonly ownerId?: number;
  ready(page: Page, visibility?: (visible: boolean) => void, controls?: { input(input: BrowserInput): Promise<void>; close(): Promise<void> }): void;
  ownership?(ownership: BrowserOwnership): void;
  state(status: BrowserStatus, url?: string, error?: string): void;
  action(action: BrowserAction): void;
  closed(): void;
  captureFinal?(): Promise<void>;
}
interface Entry {
  controls?: { input(input: BrowserInput): Promise<void>; close(): Promise<void> };
  owner: WebContents; state: LiveBrowserState; page?: Page; cdp?: CDPSession;
  frame?: BrowserFrame; sequence: number; pending?: number;
  removeFrameListener?: () => void; credit?: () => void; deadline?: ReturnType<typeof setTimeout>; lastSent: number; streaming: boolean; attaching?: boolean;
  reconcile: Promise<void>; ended: boolean; visibility?: (visible: boolean) => void;
}
/** One bounded feed for the SAME Playwright Page. No browser creation here. */
export class LiveBrowserHub {
  private readonly entries = new Map<string, Entry>();
  private readonly viewers = new Map<number, { conversationId: string | null; visible: boolean }>();
  private readonly owners = new Set<number>();
  private key(owner: number, conversation: string) { return `${owner}:${conversation}`; }
  private send(entry: Entry, event: LiveBrowserEvent) {
    if (!entry.owner.isDestroyed() && this.viewers.get(entry.owner.id)?.conversationId === entry.state.conversationId) entry.owner.send('live-browser:event', event);
  }
  private visible(entry: Entry) {
    const viewer = this.viewers.get(entry.owner.id);
    return !entry.owner.isDestroyed() && viewer?.conversationId === entry.state.conversationId && viewer.visible;
  }
  private trackOwner(owner: WebContents) {
    if (this.owners.has(owner.id)) return;
    this.owners.add(owner.id);
    owner.once('destroyed', () => { this.viewers.delete(owner.id); this.owners.delete(owner.id); for (const [id, item] of this.entries) if (item.owner === owner) { void this.end(item); this.entries.delete(id); } });
  }
  observer(owner: WebContents, conversationId: string, generationId: string): ProjectBrowserObserver {
    let entry: Entry | undefined;
    const ensure = () => {
      if (entry) return entry;
      const key = this.key(owner.id, conversationId), previous = this.entries.get(key);
      if (previous && !previous.ended && previous.page && !previous.page.isClosed()) {
        entry = previous;
        entry.state = { ...entry.state, generationId, ownership: 'agent', action: undefined, error: undefined };
        this.send(entry, { type: 'state', state: entry.state });
        return entry;
      }
      if (previous) void this.end(previous);
      entry = { owner, state: { conversationId, generationId, sessionId: randomUUID(), ownership: 'agent', status: 'loading', url: '' }, sequence: 0, lastSent: 0, streaming: false, reconcile: Promise.resolve(), ended: false };
      this.entries.delete(key); this.entries.set(key, entry);
      // Keep at most eight last frames per window; no disk persistence.
      const older = [...this.entries.entries()].filter(([, item]) => item.owner.id === owner.id && item.ended);
      for (const [oldKey] of older.slice(0, Math.max(0, older.length - 7))) this.entries.delete(oldKey);
      this.trackOwner(owner);
      return entry;
    };
    return {
      ownerId: owner.id,
      ownership: ownership => { const item = ensure(); if (!item.ended) { item.state = { ...item.state, ownership }; this.send(item, { type: 'state', state: item.state }); } },
      ready: (page, visibility, controls) => { const item = ensure(); const changedPage = item.page !== page; item.controls = controls; item.page = page; item.visibility = visibility; visibility?.(this.visible(item)); if (changedPage) page.once('close', () => { void this.end(item); }); void this.attach(item); },
      state: (status, url, error) => { const item = ensure(); if (item.ended) return; item.state = { ...item.state, status, ...(url === undefined ? {} : { url }), error }; this.send(item, { type: 'state', state: item.state }); },
      action: action => { const item = ensure(); if (item.ended) return; item.state = { ...item.state, action }; this.send(item, { type: 'state', state: item.state }); },
      captureFinal: async () => {
        const item = entry;
        if (!item?.page || item.ended || item.owner.isDestroyed()) return;
        // One final hidden snapshot, only when edits would otherwise leave an obsolete last frame.
        const data = (await item.page.screenshot({ type: 'jpeg', quality: 65, timeout: 2000 })).toString('base64');
        if (item.ended || data.length > 2 * 1024 * 1024) return;
        const viewport = item.page.viewportSize() ?? { width: 1280, height: 900 };
        item.frame = { conversationId, generationId: item.state.generationId, sessionId: item.state.sessionId, sequence: ++item.sequence, data, ...viewport };
      },
      closed: () => { if (entry) void this.end(entry); },
    };
  }
  private async attach(entry: Entry) {
    if (entry.attaching || entry.cdp || entry.ended || !entry.page) return;
    entry.attaching = true;
    try {
      const cdp = await entry.page!.context().newCDPSession(entry.page!);
      if (entry.ended || entry.owner.isDestroyed()) { await cdp.detach(); return; }
      entry.cdp = cdp;
      entry.state = { ...entry.state, status: entry.page!.url() === 'about:blank' ? 'loading' : 'live', error: undefined };
      this.send(entry, { type: 'state', state: entry.state });
      cdp.once('close', () => {
        if (entry.ended || entry.cdp !== cdp) return;
        entry.credit?.(); entry.removeFrameListener?.(); entry.removeFrameListener = undefined;
        entry.cdp = undefined; entry.streaming = false;
        entry.state = { ...entry.state, status: 'error', error: 'Live view disconnected. Reconnect to resume observation.' };
        this.send(entry, { type: 'state', state: entry.state });
      });
      const onFrame = (event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
        // CDP credit is always returned, including dropped/oversized frames.
        const ack = () => { void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined); };
        if (!this.visible(entry) || entry.ended || entry.pending !== undefined || Date.now() - entry.lastSent < 83 || event.data.length > 2 * 1024 * 1024) { ack(); return; }
        entry.lastSent = Date.now();
        entry.frame = { conversationId: entry.state.conversationId, generationId: entry.state.generationId, sessionId: entry.state.sessionId, sequence: ++entry.sequence, data: event.data, width: event.metadata.deviceWidth, height: event.metadata.deviceHeight };
        entry.pending = entry.sequence;
        // Renderer acknowledges after decoding/painting. One IPC frame at a time.
        const sequence = entry.sequence;
        entry.credit = () => { if (entry.pending === sequence) { clearTimeout(entry.deadline); entry.pending = undefined; entry.credit = undefined; ack(); } };
        entry.deadline = setTimeout(entry.credit, 1000);
        this.send(entry, { type: 'frame', frame: entry.frame });
      };
      cdp.on('Page.screencastFrame', onFrame);
      entry.removeFrameListener = () => cdp.off('Page.screencastFrame', onFrame);
      this.reconcile(entry);
    } catch (error) { if (!entry.ended) { entry.state = { ...entry.state, status: 'error', error: `Live view unavailable: ${String(error).slice(0, 250)}` }; this.send(entry, { type: 'state', state: entry.state }); } } finally { entry.attaching = false; }
  }
  watch(owner: WebContents, conversationId: unknown, visible: unknown) {
    if ((conversationId !== null && (typeof conversationId !== 'string' || conversationId.length > 256)) || typeof visible !== 'boolean') throw new Error('Invalid Live Browser subscription');
    this.trackOwner(owner);
    this.viewers.set(owner.id, { conversationId, visible });
    for (const entry of this.entries.values()) if (entry.owner === owner) {
      if (visible && !entry.cdp && !entry.ended) void this.attach(entry);
      entry.visibility?.(this.visible(entry));
      this.reconcile(entry);
      if (entry.state.conversationId === conversationId) {
        this.send(entry, { type: 'state', state: entry.state });
        if (visible && entry.frame) this.send(entry, { type: 'frame', frame: entry.frame });
      }
    }
  }
  acknowledge(owner: WebContents, sessionId: unknown, sequence: unknown) {
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(sequence)) return;
    for (const entry of this.entries.values()) if (entry.owner === owner && entry.state.sessionId === sessionId && entry.pending === sequence) entry.credit?.();
  }
  private reconcile(entry: Entry) {
    entry.reconcile = entry.reconcile.then(async () => {
      const shouldStream = this.visible(entry) && !entry.ended;
      if (!entry.cdp || entry.streaming === shouldStream) return;
      entry.streaming = shouldStream;
      entry.credit?.();
      if (shouldStream) await entry.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1280, maxHeight: 900, everyNthFrame: 2 });
      else await entry.cdp.send('Page.stopScreencast');
    }).catch(error => { entry.streaming = false; entry.credit?.(); entry.removeFrameListener?.(); entry.removeFrameListener = undefined; const cdp = entry.cdp; entry.cdp = undefined; void cdp?.detach().catch(() => undefined); if (!entry.ended) { entry.state = { ...entry.state, status: 'error', error: `Live view disconnected: ${String(error).slice(0, 200)}` }; this.send(entry, { type: 'state', state: entry.state }); } });
  }
  async input(owner: WebContents, sessionId: unknown, input: unknown) {
    const entry = this.authorizedEntry(owner, sessionId);
    if (entry.state.ownership !== 'user' || !this.visible(entry) || !entry.controls) throw new Error('Browser is controlled by the agent or unavailable');
    await entry.controls.input(input as BrowserInput); // Session validates every field before Playwright.
  }
  async close(owner: WebContents, sessionId: unknown) { await this.end(this.authorizedEntry(owner, sessionId)); }
  async closeConversation(owner: WebContents, conversationId: string) {
    const entry = this.entries.get(this.key(owner.id, conversationId));
    if (entry) await this.end(entry);
  }
  private authorizedEntry(owner: WebContents, sessionId: unknown) {
    const entry = [...this.entries.values()].find(item => item.owner === owner && !item.ended && item.state.sessionId === sessionId);
    if (typeof sessionId !== 'string' || !entry) throw new Error('Browser session is closed or belongs to another window');
    return entry;
  }
  private async end(entry: Entry) {
    if (entry.ended) return;
    entry.ended = true; entry.visibility?.(false); entry.visibility = undefined; entry.credit?.(); clearTimeout(entry.deadline);
    entry.state = { ...entry.state, ownership: 'closed', status: entry.state.status === 'error' ? 'error' : 'ended' };
    this.send(entry, { type: 'state', state: entry.state });
    await entry.reconcile;
    entry.removeFrameListener?.(); entry.removeFrameListener = undefined;
    const controls = entry.controls; entry.controls = undefined; await controls?.close().catch(() => undefined);
    await entry.cdp?.detach().catch(() => undefined); entry.credit = undefined; entry.cdp = undefined; entry.page = undefined;
  }
}
export const liveBrowsers = new LiveBrowserHub();
