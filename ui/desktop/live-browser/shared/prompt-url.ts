/**
 * Credential redaction for URLs that leave the process.
 * (Shared between runtime and renderer; kept dependency-free.)
 */
const SENSITIVE = new Set([
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'passwd',
  'auth',
  'authorization',
  'session',
  'sessionid',
  'sid',
  'cookie',
]);

export function promptUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const [name] of url.searchParams) {
      if (SENSITIVE.has(name.toLowerCase()) || /secret|token|key|pass/i.test(name)) {
        url.searchParams.set(name, '[redacted]');
      }
    }
    if (url.password) url.password = '[redacted]';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}
