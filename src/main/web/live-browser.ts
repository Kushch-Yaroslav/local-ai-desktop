import {validateBrowserWorkspace,type BrowserWorkspaceSettings} from '../../shared/live-browser';
import { randomUUID } from 'node:crypto';
import type { WebContents, Rectangle } from 'electron';
import type { Page } from 'playwright-core';
import type { BrowserAction, BrowserStatus, LiveBrowserEvent, LiveBrowserState, BrowserInput, BrowserOwnership } from '../../shared/live-browser';
import type { NativeProjectPage } from './native-project-page';

export interface ProjectBrowserObserver {
  readonly ownerId?: number;
  renew?():ProjectBrowserObserver;
  createPage?(origin: string): Promise<NativeProjectPage>;
  createQaPage?(origin: string): Promise<NativeProjectPage>;
  ready(page: Page, visibility?: (visible: boolean) => void, controls?: { input(input: BrowserInput): Promise<void>; suspend?(): Promise<void>; policyChanged?(): Promise<void>; close(reason?:string): Promise<void> }): void;
  visual?(feedback:import('../../shared/visual-debugging').VisualSelectionFeedback):void;
  ownership?(ownership: BrowserOwnership): void;
  state(status: BrowserStatus, url?: string, error?: string): void;
  action(action: BrowserAction): void;
  closed(reason?:string): void;
}
interface Entry {
  controls?: { input(input: BrowserInput): Promise<void>; suspend?(): Promise<void>; policyChanged?(): Promise<void>; close(reason?:string): Promise<void> };
  owner: WebContents; state: LiveBrowserState; page?: Page; native?: NativeProjectPage;
  ended: boolean; visibility?: (visible: boolean) => void;
}
/** Owns the native surface for the SAME Playwright Page. No frame transport. */
export class LiveBrowserHub {
  private readonly entries = new Map<string, Entry>();
  private readonly viewers = new Map<number, { conversationId: string | null; visible: boolean; bounds?: Rectangle }>();
  private readonly preferences = new Map<string,BrowserWorkspaceSettings>();
  private readonly owners = new Set<number>();
  private key(owner: number, conversation: string) { return `${owner}:${conversation}`; }
  private send(entry: Entry, event: LiveBrowserEvent) {
    if (!entry.owner.isDestroyed() && this.viewers.get(entry.owner.id)?.conversationId === entry.state.conversationId) entry.owner.send('live-browser:event', event);
  }
  private visible(entry: Entry) {
    const viewer = this.viewers.get(entry.owner.id);
    return !entry.owner.isDestroyed() && viewer?.conversationId === entry.state.conversationId && viewer.visible;
  }
  private reconcile(entry: Entry) {
    const visible = this.visible(entry) && !entry.ended;
    entry.visibility?.(visible);
    entry.native?.layout(visible ? this.viewers.get(entry.owner.id)?.bounds : undefined);
  }
  private trackOwner(owner: WebContents) {
    if (this.owners.has(owner.id)) return;
    this.owners.add(owner.id);
    owner.once('destroyed', () => { this.viewers.delete(owner.id); this.owners.delete(owner.id);for(const key of this.preferences.keys())if(key.startsWith(`${owner.id}:`))this.preferences.delete(key); for (const [id, item] of this.entries) if (item.owner === owner) { void this.end(item); this.entries.delete(id); } });
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { this.viewers.delete(owner.id); for (const item of this.entries.values()) if (item.owner === owner) { void item.controls?.suspend?.(); this.reconcile(item); } } });
  }
  observer(owner: WebContents, conversationId: string, generationId: string): ProjectBrowserObserver {
    let entry: Entry | undefined;
    const ensure = () => {
      if (entry) return entry;
      const key = this.key(owner.id, conversationId), previous = this.entries.get(key);
      if (previous && !previous.ended && previous.page && !previous.page.isClosed()) {
        entry = previous; entry.state = { ...entry.state, generationId, ownership: 'agent', action: undefined, error: undefined };
        entry.native?.ownership('agent'); this.send(entry, { type: 'state', state: entry.state }); return entry;
      }
      if (previous) void this.end(previous);
      entry = { owner, state: { conversationId, generationId, sessionId: randomUUID(), ownership: 'agent', status: 'loading', url: '' }, ended: false };
      this.entries.delete(key); this.entries.set(key, entry); this.trackOwner(owner);
      const older = [...this.entries.entries()].filter(([, item]) => item.owner === owner && item.ended);
      for (const [oldKey] of older.slice(0, Math.max(0, older.length - 7))) this.entries.delete(oldKey);
      return entry;
    };
    const current=()=>!entry||entry.state.generationId===generationId;
    return {
      ownerId: owner.id,
      renew:()=>this.observer(owner,conversationId,generationId),
      ...(process.versions.electron ? { createPage: async (origin: string) => {
        const item = ensure();
        const { createNativeProjectPage } = await import('./native-project-page');
        const native = await createNativeProjectPage(owner, origin, error => {
          if (!item.ended) { item.state = {...item.state,status:'error',ownership:'unavailable',error}; this.send(item,{type:'state',state:item.state}); }
        });
        if (item.ended) { await native.close(); throw new Error('Browser closed during creation'); }
        item.native = native;native.onWorkspace?.(workspace=>{this.preferences.set(this.key(owner.id,conversationId),workspace.settings);item.state={...item.state,workspace};this.send(item,{type:'state',state:item.state});});const saved=this.preferences.get(this.key(owner.id,conversationId));if(saved)await native.workspace(saved);this.reconcile(item); return native;
      }, createQaPage: async (origin:string) => {
        const {createNativeProjectPage}=await import('./native-project-page');
        // Hidden, scoped to this owner; never registered as the user's Live Browser.
        return createNativeProjectPage(owner,origin);
      } } : {}),
      visual:visualFeedback=>{const item=ensure();if(!item.ended){item.state={...item.state,visualFeedback};this.send(item,{type:'state',state:item.state});}},
      ownership: ownership => { if(!current())return;const item = ensure(); if (!item.ended) { item.state = { ...item.state, ownership }; item.native?.ownership(ownership); this.send(item, { type: 'state', state: item.state }); } },
      ready: (page, visibility, controls) => {
        if(!current())return;
        const item = ensure(), changed = item.page !== page;
        item.controls = controls; item.page = page; item.visibility = visibility;
        if (changed) page.once('close', () => { if(item.page===page)void this.end(item,'page_closed'); });
        item.state = { ...item.state, status: page.url() === 'about:blank' ? 'loading' : page.url().startsWith('chrome-error:')?'error':'live' };
        this.reconcile(item); this.send(item, { type: 'state', state: item.state });
      },
      state: (status, url, error) => { if(!current())return;const item = ensure(); if (!item.ended) { item.state = { ...item.state, status, ...(url === undefined ? {} : { url }), error }; this.send(item, { type: 'state', state: item.state }); } },
      action: action => { if(!current())return;const item = ensure(); if (!item.ended) { item.state = { ...item.state, action }; this.send(item, { type: 'state', state: item.state }); } },
      closed: (reason) => { if (entry&&current()) void this.end(entry,reason??'page_closed'); },
    };
  }
  watch(owner: WebContents, conversationId: unknown, visible: unknown) {
    if ((conversationId !== null && (typeof conversationId !== 'string' || conversationId.length > 256)) || typeof visible !== 'boolean') throw new Error('Invalid Live Browser subscription');
    this.trackOwner(owner);
    const previous = this.viewers.get(owner.id);
    this.viewers.set(owner.id, { conversationId, visible, ...(previous?.conversationId === conversationId ? { bounds: previous.bounds } : {}) });
    for (const item of this.entries.values()) if (item.owner === owner) { if(previous?.conversationId!==conversationId&&item.state.conversationId!==conversationId)void item.controls?.suspend?.(); this.reconcile(item); if (item.state.conversationId === conversationId) this.send(item, { type: 'state', state: item.state }); }
  }
  layout(owner: WebContents, sessionId: unknown, bounds: unknown) {
    if (bounds === null && ![...this.entries.values()].some(item => item.owner === owner && !item.ended && item.state.sessionId === sessionId)) return;
    const item = this.authorizedEntry(owner, sessionId), viewer = this.viewers.get(owner.id);
    if (viewer?.conversationId !== item.state.conversationId) return;
    if (bounds !== null && (!bounds || typeof bounds !== 'object' || !['x','y','width','height'].every(key => typeof (bounds as Record<string, unknown>)[key] === 'number' && Number.isFinite((bounds as Record<string, number>)[key]) && Math.abs((bounds as Record<string, number>)[key]) <= 16384))) throw new Error('Invalid native browser bounds');
    viewer.bounds = bounds === null ? undefined : bounds as Rectangle;
    this.reconcile(item);
  }
  restore(owner:WebContents,conversationId:string,settings?:BrowserWorkspaceSettings){
    const key=this.key(owner.id,conversationId);if(settings&&!this.preferences.has(key))this.preferences.set(key,validateBrowserWorkspace(settings));
  }
  async workspace(owner:WebContents,sessionId:unknown,settings:unknown){
    const item=this.authorizedEntry(owner,sessionId);
    if(item.state.ownership!=='user'||!item.native)throw new Error('Browser viewport requires user ownership');
    const value=validateBrowserWorkspace(settings);
    await item.native.workspace(value);const applied=item.native.workspaceState?.()?.settings??value;this.preferences.set(this.key(owner.id,item.state.conversationId),applied);
    return {conversationId:item.state.conversationId,settings:applied};
  }
  async input(owner: WebContents, sessionId: unknown, input: unknown) {
    const entry = this.authorizedEntry(owner, sessionId);
    if (entry.state.ownership !== 'user' || !this.visible(entry) || !entry.controls) throw new Error('Browser is controlled by the agent or unavailable');
    if (entry.native && (!input || !['back','forward','reload','release','focus'].includes((input as BrowserInput).kind))) throw new Error('Use native page input');
    if (entry.native && (input as BrowserInput).kind === 'focus') { entry.native.contents.focus(); return; }
    await entry.controls.input(input as BrowserInput);
  }
  async close(owner: WebContents, sessionId: unknown) { await this.end(this.authorizedEntry(owner, sessionId)); }
  async policyChanged(owner: WebContents, conversationId: string) {
    const entry=this.entries.get(this.key(owner.id,conversationId));
    if(entry&&!entry.ended)await entry.controls?.policyChanged?.();
  }
  async closeConversation(owner: WebContents, conversationId: string, reason='policy_changed') { const entry = this.entries.get(this.key(owner.id, conversationId)); if (entry) await this.end(entry,reason); }
  private authorizedEntry(owner: WebContents, sessionId: unknown) {
    const entry = [...this.entries.values()].find(item => item.owner === owner && !item.ended && item.state.sessionId === sessionId);
    if (typeof sessionId !== 'string' || !entry) throw new Error('Browser session is closed or belongs to another window');
    return entry;
  }
  private async end(entry: Entry, reason='user_closed') {
    if (entry.ended) return;
    entry.ended = true; this.reconcile(entry); entry.visibility = undefined;
    entry.state = { ...entry.state, ownership: 'closed', status: entry.state.status === 'error' ? 'error' : 'ended' };
    this.send(entry, { type: 'state', state: entry.state });
    const controls = entry.controls; entry.controls = undefined;
    await controls?.close(reason).catch(() => undefined); await entry.native?.close();
    entry.native = undefined; entry.page = undefined;
  }
}
export const liveBrowsers = new LiveBrowserHub();
