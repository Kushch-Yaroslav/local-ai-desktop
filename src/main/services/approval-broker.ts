import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, StreamEvent } from '../../shared/types';
import type { ApprovalResult, ConfirmationRequest, ConfirmAction } from '../tools/project-tools';

type Sender = { id: number; isDestroyed(): boolean; send(channel: string, payload: unknown): void; once?(event: string, listener: () => void): unknown; removeListener?(event: string, listener: () => void): unknown };
type Pending = { senderId: number; conversationId: string; runId: string; key: string; finish(result: ApprovalResult): void };

/** In-memory conversation grants bind the category, canonical root and exact operation.
 * Approval for a command never grants arbitrary scripts, commits or downloads. */
export class ApprovalBroker {
  private readonly pausing = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly grants = new Map<string, Set<string>>();
  private readonly runs=new Map<string,{session:string;conversationId:string}>();
  private readonly owners=new Set<number>();
  private readonly contexts=new Map<string,string>();
  constructor(private readonly timeoutMs = 300_000) {}

  forRun(sender: Sender, conversationId: string, runId: string, context?: {mode:string;roots:string[]}): ConfirmAction {
    if(!this.owners.has(sender.id)){this.owners.add(sender.id);sender.once?.('destroyed',()=>{this.owners.delete(sender.id);for(const key of this.grants.keys())if(JSON.parse(key)[0]===sender.id)this.grants.delete(key);for(const pending of this.pending.values())if(pending.senderId===sender.id)pending.finish({approved:false,reason:'ui_unavailable'});});}
    const signature=JSON.stringify(context??{mode:'strict',roots:[]});
    if(this.contexts.has(conversationId)&&this.contexts.get(conversationId)!==signature)this.revoke(conversationId);
    this.contexts.set(conversationId,signature);
    const session=JSON.stringify([sender.id,conversationId,signature]);this.runs.set(runId,{session,conversationId});
    return async (request: ConfirmationRequest, signal: AbortSignal) => {
      const binding=this.runs.get(runId);
      const session=JSON.stringify([sender.id,conversationId,this.contexts.get(conversationId)]);if(binding)binding.session=session;
      if (signal.aborted || this.pausing.has(runId) || !binding) return { approved: false, reason: 'cancelled' };
      if (sender.isDestroyed()) return { approved: false, reason: 'ui_unavailable' };
      const key = JSON.stringify([request.category, request.root, request.detail, request.preview]);
      if (this.grants.get(session)?.has(key)) return { approved: true, reason: 'session' };
      return new Promise<ApprovalResult>((resolve) => {
        const approvalId = randomUUID();
        let settled = false;
        const emit = (event: StreamEvent) => sender.send('chat:stream', { ...event, conversationId, generationId: runId });
        const finish = (result: ApprovalResult) => {
          if (settled) return; settled = true;
          clearTimeout(timer); signal.removeEventListener('abort', abort); sender.removeListener?.('destroyed', unavailable); sender.removeListener?.('render-process-gone', unavailable); sender.removeListener?.('did-start-navigation', unavailable);
          this.pending.delete(approvalId);
          if (!sender.isDestroyed()) {
            try { emit({ type: 'approval-resolved', actionId: request.actionId, approvalId, status: result.approved ? result.reason === 'session' ? 'session-approved' : 'approved' : 'rejected' }); } catch { /* disconnected renderer */ }
          }
          resolve(result);
        };
        const abort = () => finish({ approved: false, reason: 'cancelled' });
        const unavailable = () => finish({ approved: false, reason: 'ui_unavailable' });
        const timer = setTimeout(() => finish({ approved: false, reason: 'timeout' }), this.timeoutMs);
        this.pending.set(approvalId, { senderId: sender.id, conversationId, runId, key, finish });
        signal.addEventListener('abort', abort, { once: true }); sender.once?.('destroyed', unavailable); sender.once?.('render-process-gone', unavailable); sender.once?.('did-start-navigation', unavailable);
        try { emit({ type: 'approval-request', actionId: request.actionId, approval: { approvalId, category: request.category, status: 'pending', title: request.title, detail: request.detail, root: request.root } }); }
        catch { unavailable(); }
        if (signal.aborted) abort();
      });
    };
  }

  context(conversationId:string,context:{mode:string;roots:string[]}):void {
    const signature=JSON.stringify(context);if(this.contexts.get(conversationId)!==signature)this.revoke(conversationId);this.contexts.set(conversationId,signature);
  }
  reply(senderId: number, request: { conversationId: string; generationId: string; approvalId: string; decision: ApprovalDecision }): boolean {
    const pending = this.pending.get(request.approvalId);
    if (!pending || senderId !== pending.senderId || request.conversationId !== pending.conversationId || request.generationId !== pending.runId || !['once', 'session', 'reject'].includes(request.decision)) return false;
    if (request.decision === 'session') {
      const session=this.runs.get(pending.runId)?.session;if(!session)return false;
      const scopes = this.grants.get(session) ?? new Set<string>(); scopes.add(pending.key); this.grants.set(session, scopes);
    }
    pending.finish(request.decision === 'reject' ? { approved: false, reason: 'user_rejected' } : { approved: true, reason: request.decision });
    return true;
  }
  list(id: string, senderId?:number): import('../../shared/autonomy').SessionGrant[] {
    const session=this.runs.get(id)?.session;
    return [...this.grants].filter(([key])=>(key===session||JSON.parse(key)[1]===id)&&(senderId===undefined||JSON.parse(key)[0]===senderId)).flatMap(([,grants])=>[...grants]).map(id=>{const [category,root,detail]=JSON.parse(id);return{id,category,root,detail};});
  }
  revoke(id:string,grantId?:string):void {
    const session=this.runs.get(id)?.session;
    for(const [key,grants] of this.grants)if(key===session||JSON.parse(key)[1]===id){if(grantId)grants.delete(grantId);else this.grants.delete(key);}
    for(const pending of this.pending.values())if((pending.runId===id||pending.conversationId===id)&&(!grantId||pending.key===grantId))pending.finish({approved:false,reason:'cancelled'});
  }
  /** Graceful pause never authorizes an outstanding command. Future approvals
   * for this ending run are cancelled too; checkpoint tools need no approval. */
  pauseRun(runId: string): void {
    this.pausing.add(runId);
    for (const pending of this.pending.values()) if (pending.runId === runId) pending.finish({ approved: false, reason: 'cancelled' });
  }

  endRun(runId: string): void {
    this.pausing.delete(runId);
    this.runs.delete(runId);
    for (const pending of this.pending.values()) if (pending.runId === runId) pending.finish({ approved: false, reason: 'cancelled' });
  }
}
