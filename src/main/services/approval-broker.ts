import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, StreamEvent } from '../../shared/types';
import type { ApprovalResult, ConfirmationRequest, ConfirmAction } from '../tools/project-tools';

type Sender = { id: number; isDestroyed(): boolean; send(channel: string, payload: unknown): void; once?(event: string, listener: () => void): unknown; removeListener?(event: string, listener: () => void): unknown };
type Pending = { senderId: number; conversationId: string; runId: string; key: string; finish(result: ApprovalResult): void };

/** Run-local grants bind the category, canonical root and exact operation.
 * Approval for a command never grants arbitrary scripts, commits or downloads. */
export class ApprovalBroker {
  private readonly pausing = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly grants = new Map<string, Set<string>>();
  constructor(private readonly timeoutMs = 300_000) {}

  forRun(sender: Sender, conversationId: string, runId: string): ConfirmAction {
    return async (request: ConfirmationRequest, signal: AbortSignal) => {
      if (signal.aborted || this.pausing.has(runId)) return { approved: false, reason: 'cancelled' };
      if (sender.isDestroyed()) return { approved: false, reason: 'ui_unavailable' };
      const key = JSON.stringify([request.category, request.root, request.detail]);
      if (this.grants.get(runId)?.has(key)) return { approved: true, reason: 'session' };
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

  reply(senderId: number, request: { conversationId: string; generationId: string; approvalId: string; decision: ApprovalDecision }): boolean {
    const pending = this.pending.get(request.approvalId);
    if (!pending || senderId !== pending.senderId || request.conversationId !== pending.conversationId || request.generationId !== pending.runId || !['once', 'session', 'reject'].includes(request.decision)) return false;
    if (request.decision === 'session') {
      const scopes = this.grants.get(pending.runId) ?? new Set<string>(); scopes.add(pending.key); this.grants.set(pending.runId, scopes);
    }
    pending.finish(request.decision === 'reject' ? { approved: false, reason: 'user_rejected' } : { approved: true, reason: request.decision });
    return true;
  }
  list(runId: string): import('../../shared/autonomy').SessionGrant[] {
    return [...this.grants.get(runId) ?? []].map(id => { const [category, root, detail] = JSON.parse(id) as [string, string | undefined, string]; return { id, category, root, detail }; });
  }
  revoke(runId: string, grantId?: string): void { if (grantId) this.grants.get(runId)?.delete(grantId); else this.grants.delete(runId); }
  /** Graceful pause never authorizes an outstanding command. Future approvals
   * for this ending run are cancelled too; checkpoint tools need no approval. */
  pauseRun(runId: string): void {
    this.pausing.add(runId);
    for (const pending of this.pending.values()) if (pending.runId === runId) pending.finish({ approved: false, reason: 'cancelled' });
  }

  endRun(runId: string): void {
    this.pausing.delete(runId);
    this.revoke(runId);
    for (const pending of this.pending.values()) if (pending.runId === runId) pending.finish({ approved: false, reason: 'cancelled' });
  }
}
