/** Local AI Desktop: independent per-chat attachment drafts, consumed once. */
import type { ImageData } from '../../types/message';
import type { BrowserAttachment } from './attachments';
export interface PendingSelection {
  text: string;
  images: ImageData[];
  areaNames: string[];
  createdAt: number;
  conversationId?: string;
  attachments?: BrowserAttachment[];
}
const drafts = new Map<string, PendingSelection>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
export function setPendingSelection(value: PendingSelection | null, conversationId?: string): void {
  if (!value) {
    if (conversationId) drafts.delete(conversationId);
    else drafts.clear();
  } else {
    const key = value.conversationId ?? conversationId ?? 'hub';
    const previous = drafts.get(key);
    if (value.attachments?.length && previous?.attachments?.length) {
      const attachments = [
        ...previous.attachments.filter(
          (old) => !value.attachments!.some((item) => item.id === old.id)
        ),
        ...value.attachments,
      ].slice(-8);
      drafts.set(key, { ...value, attachments, areaNames: attachments.map((a) => a.name) });
    } else drafts.set(key, value);
  }
  emit();
}
export function peekPendingSelection(conversationId?: string): PendingSelection | null {
  return drafts.get(conversationId ?? 'hub') ?? null;
}
export function consumePendingSelection(conversationId?: string): PendingSelection | null {
  const key = conversationId ?? 'hub';
  const current = drafts.get(key) ?? null;
  drafts.delete(key);
  if (current) emit();
  return current;
}
export function onPendingSelectionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for composer validation; no page prose is treated as a task. */
export function pendingDescription(conversationId?: string): string {
  const attachments = (peekPendingSelection(conversationId)?.attachments ?? []).filter(
    (attachment) => Boolean(attachment.description?.trim())
  );
  return attachments
    .map((attachment) =>
      attachments.length === 1
        ? attachment.description!.trim()
        : `${attachment.name}: ${attachment.description!.trim()}`
    )
    .join('\n\n');
}
