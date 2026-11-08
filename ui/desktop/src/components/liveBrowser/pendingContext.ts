/**
 * Pending Live Browser selection context.
 *
 * When the user marks areas for the agent ("include in next message"), the
 * structured context (bounded text + optional crop images) is queued here.
 * BaseChat's submit path consumes the queue exactly once, prepending the text
 * and appending the images to the UserInput.
 *
 * The text is always attached: with Vision Off the model reasons from DOM,
 * geometry, CSS and URL data. With Vision On Goose keeps the images; for
 * models without vision support Goose replaces them with an explicit
 * "[image omitted: model does not support vision]" marker — the context text
 * carries the same limits (e.g. the Canvas/SVG screenshot-only note).
 */
import type { ImageData } from '../../types/message';

export interface PendingSelection {
  /** Bounded structured context (see live-browser/shared/context.ts). */
  text: string;
  /** Region crops (JPEG base64). Goose gates these by model vision support. */
  images: ImageData[];
  /** Names of the areas included (for UI feedback). */
  areaNames: string[];
  createdAt: number;
  conversationId?: string;
}

let pending: PendingSelection | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Queue the selection context to attach to the next user message. */
export function setPendingSelection(selection: PendingSelection | null): void {
  pending = selection;
  emit();
}

/** Take the queued selection (or null). Consumed exactly once. */
export function consumePendingSelection(conversationId?: string): PendingSelection | null {
  if (
    conversationId &&
    pending?.conversationId &&
    pending.conversationId !== conversationId &&
    pending.conversationId !== 'hub'
  )
    return null;
  const current = pending;
  pending = null;
  if (current) emit();
  return current;
}

/** Read-only peek (for UI state like "N areas will be sent with next message"). */
export function peekPendingSelection(): PendingSelection | null {
  return pending;
}

export function onPendingSelectionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
