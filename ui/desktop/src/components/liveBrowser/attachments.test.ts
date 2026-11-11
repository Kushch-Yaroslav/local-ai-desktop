import { describe, it, expect, beforeEach } from 'vitest';
import { attachmentBlock, readBrowserAttachment, browserPayloads } from './attachments';
import {
  setPendingSelection,
  consumePendingSelection,
  peekPendingSelection,
} from './pendingContext';
import { createUserMessage, getTextAndImageContent } from '../../types/message';
beforeEach(() => setPendingSelection(null));
describe('typed visual attachments', () => {
  it('keeps prose clean and separates payload from the persisted visible reference', () => {
    const value = {
      id: globalThis.crypto.randomUUID(),
      name: 'Area 1',
      description: 'The button needs more padding',
      regionCount: 1,
      vision: false,
      text: 'URL /products DOM #card',
      images: [],
    };
    const message = createUserMessage('Fix this', []);
    message.content.push(attachmentBlock(value));
    expect(getTextAndImageContent(message).textContent).toBe('Fix this');
    expect(readBrowserAttachment(message.content[1])?.name).toBe('Area 1');
    expect(message.content[1]).not.toHaveProperty('text', expect.stringContaining('DOM #card'));
    expect(browserPayloads(message)[0].text).toContain('DOM #card');
    expect(browserPayloads(message)[0].description).toBe('The button needs more padding');
    expect(readBrowserAttachment(message.content[1])?.description).toBe(
      'The button needs more padding'
    );
  });
  it('does not consume a hub draft from an unrelated existing chat', () => {
    setPendingSelection({
      text: '',
      images: [],
      areaNames: ['Hub'],
      createdAt: 1,
      conversationId: 'hub',
    });
    expect(consumePendingSelection('other')).toBeNull();
    expect(peekPendingSelection('hub')).not.toBeNull();
  });
});
