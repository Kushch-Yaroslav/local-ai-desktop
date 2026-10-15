import { createWriteStream } from 'node:fs';
import { mkdir, lstat, rename, unlink, link, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';
import { openPublicResource } from '../web/public-network';
import { projectPath, snapshotFile, PathPolicyError } from './project-path';
import type { ConfirmAction } from './project-tools';

export const downloadFileTool = { type: 'function', function: { name: 'download_file', description: 'Download a public HTTP/HTTPS file into a selected project. Streams atomically, requires scoped approval, validates paths and optional SHA-256. Does not extract, execute or prove installation. Gated sources need user-authorized authentication through a separately approved workflow.', parameters: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string' }, project: { type: 'integer', enum: [1, 2] }, max_bytes: { type: 'integer', minimum: 1, maximum: 68719476736 }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 3600000 }, sha256: { type: 'string' } }, required: ['url', 'path'] } } };

class DownloadError extends Error {
  constructor(readonly code: string, message: string, readonly retrySameArguments = false, readonly status?: number) { super(message); }
}
type Transport = (url: string, signal: AbortSignal, timeoutMs: number) => Promise<IncomingMessage>;
export class FileDownloader {
  constructor(private readonly transport: Transport = openPublicResource) {}
  async execute(root: string, args: Record<string, unknown>, signal: AbortSignal, confirm: ConfirmAction | undefined, actionId: string, progress?: (bytes: number, total?: number) => void): Promise<Record<string, unknown>> {
    let temporary: string | undefined;
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      root = await realpath(root);
      if (typeof args.url !== 'string' || typeof args.path !== 'string' || !args.path.trim()) throw new DownloadError('INVALID_ARGUMENT', 'url and destination path are required');
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new DownloadError('UNSAFE_URL', 'Only public HTTP/HTTPS URLs without credentials are supported');
      const maxBytes = args.max_bytes ?? 256 * 1024 * 1024;
      const timeoutMs = args.timeout_ms ?? 300_000;
      if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1 || Number(maxBytes) > 64 * 1024 ** 3 || !Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 3600_000) throw new DownloadError('INVALID_ARGUMENT', 'Invalid size or timeout limit; maximum is 64 GiB and one hour');
      if (args.sha256 !== undefined && (typeof args.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(args.sha256))) throw new DownloadError('INVALID_CHECKSUM', 'sha256 must contain 64 hexadecimal characters');
      const destinationRoot = args._allow_outside === true ? '/' : root;
      const destination = args._allow_outside === true && typeof args.path === 'string' ? resolve(root, args.path) : args.path;
      const target = await projectPath(destinationRoot, destination, true);
      const decision = args._authorized === true ? { approved: true, reason: 'once' as const } : confirm ? await confirm({ title: 'Download project file', detail: `${url.href}\nDestination: ${target}\nMaximum bytes: ${maxBytes}\nTimeout: ${timeoutMs} ms\nSHA-256: ${args.sha256 ?? 'not provided'}`, root, category: 'file_download', actionId }, signal) : { approved: false, reason: 'ui_unavailable' };
      if (!decision.approved) return { error: decision.reason === 'ui_unavailable' ? 'Approval UI unavailable. Open the application window and retry.' : `Download not authorized: ${decision.reason}`, code: 'PERMISSION_DENIED', approved: false, reason: decision.reason, retrySameArguments: false };
      if (controller.signal.aborted) throw new DownloadError('CANCELLED', 'Download cancelled');
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, Number(timeoutMs));
      let current = url.href; let response: IncomingMessage | undefined;
      for (let redirects = 0; redirects <= 10; redirects += 1) {
        response = await this.transport(current, controller.signal, Number(timeoutMs));
        if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) break;
        const location = response.headers.location; response.destroy();
        if (!location || redirects === 10) throw new DownloadError('REDIRECT_LIMIT', 'Missing redirect location or too many redirects');
        const next = new URL(location, current);
        if (new URL(current).protocol === 'https:' && next.protocol === 'http:') throw new DownloadError('UNSAFE_URL', 'HTTPS to HTTP redirect is blocked');
        current = next.href;
        // The production transport validates and pins each redirect destination.
      }
      if (!response) throw new DownloadError('NETWORK_ERROR', 'Download response missing', true);
      const status = response.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        response.destroy();
        const auth = status === 401 || status === 403;
        throw new DownloadError(auth ? 'AUTH_REQUIRED' : status === 404 ? 'HTTP_NOT_FOUND' : 'HTTP_ERROR', auth ? `HTTP ${status}: authentication or repository access/license acceptance required. Do not bypass gated access.` : `HTTP ${status}: ${response.statusMessage ?? 'download failed'}`, status === 408 || status === 429 || status >= 500, status);
      }
      const length = Number(response.headers['content-length']);
      if (Number.isFinite(length) && length > Number(maxBytes)) { response.destroy(); throw new DownloadError('SIZE_LIMIT', 'Content-Length exceeds the approved maximum. Request a larger explicit limit.'); }
      try {
        await mkdir(dirname(target), { recursive: true });
        if (await projectPath(destinationRoot, destination, true) !== target) throw new PathPolicyError('Destination changed during download setup');
        const before = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
        if (before && !before.isFile()) throw new PathPolicyError('Destination must be a regular file');
        temporary = resolve(dirname(target), `.local-ai-download-${randomUUID()}`);
        const report = (bytes: number, total?: number) => { try { progress?.(bytes, total); } catch { /* a disconnected progress observer cannot corrupt a download */ } };
        const hash = createHash('sha256'); let bytes = 0; let notified = 0;
        const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (bytes > Number(maxBytes)) { done(new DownloadError('SIZE_LIMIT', 'Streaming body exceeds the approved maximum')); return; }
          hash.update(chunk);
          if (bytes - notified >= 1024 * 1024) { notified = bytes; report(bytes, Number.isFinite(length) && length > 0 ? length : undefined); }
          done(null, chunk);
        } });
        await pipeline(response, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
        const checksum = hash.digest('hex');
        if (args.sha256 && checksum !== String(args.sha256).toLowerCase()) throw new DownloadError('CHECKSUM_MISMATCH', 'Downloaded SHA-256 differs from expected checksum; destination preserved');
        if (await projectPath(destinationRoot, destination, true) !== target) throw new PathPolicyError('Destination changed before completion');
        const now = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
        if (before ? !now || before.ino !== now.ino || before.size !== now.size || before.mtimeMs !== now.mtimeMs : now) throw new DownloadError('STALE_DESTINATION', 'Destination changed during download; retry after reading its latest state');
        if (controller.signal.aborted) throw new DownloadError('CANCELLED', 'Download cancelled before completion');
        const backup = await snapshotFile(target);
        const file = await open(temporary, 'r'); try { await file.sync(); } finally { await file.close(); }
        if (controller.signal.aborted) throw new DownloadError('CANCELLED', 'Download cancelled before completion');
        if (before) await rename(temporary, target); else await link(temporary, target);
        report(bytes, bytes);
        return { path: target, bytes, sha256: checksum, backup, replaced: Boolean(before), installed: false, message: 'File downloaded and verified. Installation/integration and execution are separate steps.' };
      } finally { response.destroy(); }
    } catch (error) {
      if (controller.signal.aborted) return { error: timedOut ? 'Download timed out' : 'Download cancelled', code: timedOut ? 'NETWORK_TIMEOUT' : 'CANCELLED', retrySameArguments: timedOut };
      if (error instanceof DownloadError) return { error: error.message, code: error.code, status: error.status, retrySameArguments: error.retrySameArguments };
      if (error instanceof PathPolicyError) return { error: error.message, code: error.code, retrySameArguments: false };
      const message = error instanceof Error ? error.message : String(error);
      const errno = (error as NodeJS.ErrnoException)?.code;
      if (['EACCES', 'EPERM'].includes(errno ?? '')) return { error: message, code: 'PERMISSION_DENIED', retrySameArguments: false };
      if (['ENOSPC', 'EIO', 'EROFS', 'ENOTDIR', 'EISDIR'].includes(errno ?? '')) return { error: message, code: 'FILE_IO_ERROR', retrySameArguments: false };
      if (errno === 'EEXIST') return { error: message, code: 'STALE_DESTINATION', retrySameArguments: false };
      if (/timed out|timeout/i.test(message)) return { error: message, code: 'NETWORK_TIMEOUT', retrySameArguments: true };
      const unsafe = /blocked|public HTTP|credentials|Invalid URL/i.test(message);
      return { error: message, code: unsafe ? 'UNSAFE_URL' : 'NETWORK_ERROR', retrySameArguments: !unsafe };
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }
}
