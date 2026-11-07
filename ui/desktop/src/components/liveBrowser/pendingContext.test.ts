/**
 * Unit tests for the pending selection queue (pendingContext.ts).
 *
 * Guarantees the consume-once contract between the Live Browser panel
 * (producer) and the chat submit path (consumer), plus the change listeners
 * the UI uses to show "N areas will be sent with the next message".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setPendingSelection,
  consumePendingSelection,
  peekPendingSelection,
  onPendingSelectionChange,
  type PendingSelection,
} from './pendingContext';

const selection = (): PendingSelection => ({
  text: '[Local AI Desktop — Live Browser selection]\nArea 1 — "Header" [Detected]',
  images: [{ data: 'base64jpeg', mimeType: 'image/jpeg' }],
  areaNames: ['Header'],
  createdAt: Date.now(),
});

beforeEach(() => {
  setPendingSelection(null);
});
afterEach(() => {
  setPendingSelection(null);
});

describe('pendingContext', () => {
  it('queues and peeks without consuming', () => {
    const s = selection();
    setPendingSelection(s);
    expect(peekPendingSelection()).toBe(s);
    expect(peekPendingSelection()).toBe(s); // peek is non-destructive
  });

  it('consumes exactly once', () => {
    const s = selection();
    setPendingSelection(s);
    expect(consumePendingSelection()).toBe(s);
    expect(consumePendingSelection()).toBeNull();
  });

  it('returns null when nothing is queued', () => {
    expect(consumePendingSelection()).toBeNull();
  });

  it('notifies listeners on set and on consume, and allows unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onPendingSelectionChange(listener);
    setPendingSelection(selection());
    expect(listener).toHaveBeenCalledTimes(1);
    consumePendingSelection();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setPendingSelection(selection());
    expect(listener).toHaveBeenCalledTimes(2); // no more calls after unsubscribe
  });

  it('replaces an existing queued selection', () => {
    const first = selection();
    const second = selection();
    setPendingSelection(first);
    setPendingSelection(second);
    expect(peekPendingSelection()).toBe(second);
  });
});
