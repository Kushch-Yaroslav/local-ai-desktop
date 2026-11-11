/**
 * Unit tests for URL credential redaction (shared/prompt-url.ts).
 * URLs are included in the agent context, so sensitive values must never
 * reach the model or logs.
 */
import { describe, it, expect } from 'vitest';
import { promptUrl } from '../../../live-browser/shared/prompt-url';

describe('promptUrl', () => {
  it('passes through benign URLs unchanged', () => {
    expect(promptUrl('https://example.com/page?tab=home')).toBe('https://example.com/page?tab=home');
  });

  it('redacts sensitive query parameters', () => {
    const out = promptUrl('https://example.com/api?api_key=SECRET123&token=TOK&user=alice');
    expect(out).toContain('api_key=');
    expect(out).toContain('redacted');
    expect(out).toContain('user=alice');
    expect(out).not.toContain('SECRET123');
    expect(out).not.toContain('TOK');
  });

  it('redacts embedded credentials in the authority', () => {
    const out = promptUrl('https://user:pass123@example.com/x');
    expect(out).toContain('redacted');
    expect(out).not.toContain('pass123');
  });

  it('returns a marker for invalid URLs', () => {
    expect(promptUrl('not a url')).toBe('[invalid-url]');
  });
});
