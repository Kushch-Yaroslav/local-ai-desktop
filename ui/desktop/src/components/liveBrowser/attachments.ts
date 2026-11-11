/** Typed visible reference; payload lives in the Goose session's durable registry. */
import type { MessageContent, Message } from '../../types/message';
export const BROWSER_CARD_PREFIX = 'lad-browser-attachment:v1:';
export interface BrowserAttachment {
  id: string;
  name: string;
  /** Immutable area description captured with the selected regions. */
  description?: string;
  regionCount: number;
  url?: string;
  vision: boolean;
  projectRoot?: string;
  projectBound?: boolean;
  text?: string;
  images?: { data: string; mimeType: string }[];
}
export function attachmentBlock(value: BrowserAttachment): MessageContent {
  const { text: _text, images: _images, ...card } = value;
  void _text;
  void _images;
  return {
    type: 'text',
    text: BROWSER_CARD_PREFIX + JSON.stringify(card),
    annotations: { audience: ['user'] },
    _meta: { liveBrowserPayload: value },
  };
}
export function readBrowserAttachment(block: MessageContent): BrowserAttachment | null {
  if (block.type !== 'text' || !block.text.startsWith(BROWSER_CARD_PREFIX)) return null;
  try {
    const value = JSON.parse(block.text.slice(BROWSER_CARD_PREFIX.length));
    return typeof value.id === 'string' && typeof value.name === 'string' ? value : null;
  } catch {
    return null;
  }
}
export function browserPayloads(message: Message): BrowserAttachment[] {
  return message.content.flatMap((block) =>
    block.type === 'text' && block._meta?.liveBrowserPayload
      ? [block._meta.liveBrowserPayload as BrowserAttachment]
      : []
  );
}

export function browserPageLabel(url?: string): string {
  try {
    const parsed = new URL(url ?? '');
    return (
      (parsed.hash.startsWith('#/') ? parsed.hash.slice(1) : parsed.pathname)
        .split(/[?#]/)[0]
        .split('/')
        .filter(Boolean)
        .at(-1) ?? parsed.hostname
    );
  } catch {
    return '';
  }
}
