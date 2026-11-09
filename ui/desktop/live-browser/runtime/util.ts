import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Runtime connection failures may include private CDP URLs in Playwright call logs. */
export function redactRuntimeText(
  text: string,
  token: string | undefined = process.env.LAD_LB_TOKEN
): string {
  for (const secret of [token, process.env.LLAMA_API_KEY])
    if (secret && secret.length >= 8) text = text.split(secret).join('[redacted]');
  return text
    .replace(
      /([?&](?:token|access_token|refresh_token|api[_-]?key|authorization|secret|password)=)[^&\s#"'<>]+/gi,
      '$1[redacted]'
    )
    .replace(/([a-z]+:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [redacted]');
}

export function log(...args: unknown[]): void {
  const line = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ');
  process.stdout.write(`[live-browser] ${new Date().toISOString()} ${redactRuntimeText(line)}\n`);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Redact credential-looking URL parameters for anything that leaves the
 * process (prompts, logs, MCP results). Mirrors the original visualPromptUrl.
 */
export function promptUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const sensitive = new Set([
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
    for (const [name, value] of url.searchParams) {
      if (sensitive.has(name.toLowerCase()) || /secret|token|key|pass/i.test(name)) {
        url.searchParams.set(name, value ? '[redacted]' : '');
      }
    }
    if (url.password) url.password = '[redacted]';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

export async function rmSafe(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function joinData(root: string, ...parts: string[]): string {
  return join(root, ...parts);
}
