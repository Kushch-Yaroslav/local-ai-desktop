import type { LadRectBody } from '../shared/api';

/**
 * URL / protocol policy for the browser runtime.
 *
 * - Only http(s) page navigation is allowed.
 * - Non-http(s) resource requests (file:, data:, about:, chrome:, ...) are aborted.
 * - Loopback/file exfiltration via the page is still possible in general (web pages
 *   can fetch anything they can reach); the runtime itself never grants filesystem
 *   access. Goose permission rules still govern what the agent may read on disk.
 */

const ALLOWED_PAGE_PROTOCOLS = new Set(['http:', 'https:']);

const BLOCKED_RESOURCE_PROTOCOLS = new Set([
  'file:',
  'data:',
  'blob:',
  'about:',
  'chrome:',
  'chrome-extension:',
  'view-source:',
  'javascript:',
  'sftp:',
  'ftp:',
  'ws:',
  'wss:',
]);

export function isAllowedPageUrl(rawUrl: string): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (!ALLOWED_PAGE_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `protocol-not-allowed (${url.protocol.replace(':', '')})` };
  }
  return { ok: true, url: url.toString() };
}

export function isBlockedResourceUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (BLOCKED_RESOURCE_PROTOCOLS.has(url.protocol)) return true;
    if (url.protocol === 'data:') return true;
    return false;
  } catch {
    // Unparseable URLs: let Playwright handle them; they will fail anyway.
    return /(^|[^.a-z])(file|data|about|view-source|chrome|javascript):/i.test(rawUrl);
  }
}

export function validateRect(rect: LadRectBody): { ok: true; rect: LadRectBody } | { ok: false; reason: string } {
  const check = (n: unknown): number | null => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    if (n < 0 || n > 100000) return null;
    return n;
  };
  const x = check(rect.x);
  const y = check(rect.y);
  const width = check(rect.width);
  const height = check(rect.height);
  if (x === null || y === null || width === null || height === null) {
    return { ok: false, reason: 'invalid-rect' };
  }
  if (width < 1 || height < 1) return { ok: false, reason: 'rect-too-small' };
  return { ok: true, rect: { x, y, width, height } };
}

/** Bounded string for DOM text/html returned to the agent. */
export function boundText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
