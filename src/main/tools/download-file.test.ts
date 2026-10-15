import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, readFile, readdir, mkdir, symlink, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileDownloader } from './download-file';
import type { ConfirmAction } from './project-tools';

const allow: ConfirmAction = async () => ({ approved: true, reason: 'once' });
const response = (body: AsyncIterable<Buffer> | Buffer[], status = 200, headers = {}) => Object.assign(Readable.from(body), { statusCode: status, headers }) as unknown as IncomingMessage;
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'agent-download-'));
  try {
    const signal = new AbortController().signal; const data = Buffer.from('verified weights fixture');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const downloader = new FileDownloader(async url => url.endsWith('/redirect') ? response([], 302, { location: '/weights' }) : response([data], 200, { 'content-length': String(data.length) }));
    const args = { url: 'https://downloads.example/redirect', path: 'models/weights.bin', sha256 };
    const result = await downloader.execute(root, args, signal, allow, 'success');
    assert.equal(result.sha256, sha256); assert.equal(result.installed, false);
    assert.deepEqual(await readFile(join(root, args.path)), data);
    const denied = await downloader.execute(root, { ...args, path: 'denied' }, signal, async () => ({ approved: false, reason: 'user_rejected' }), 'denied');
    assert.equal(denied.code, 'PERMISSION_DENIED'); assert(! (await readdir(root)).includes('denied'));
    for (const [status, code] of [[404, 'HTTP_NOT_FOUND'], [401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [503, 'HTTP_ERROR']] as const) {
      const failure = await new FileDownloader(async () => response([], status)).execute(root, { ...args, path: 'failure' }, signal, allow, 'http');
      assert.equal(failure.code, code); assert.equal(failure.status, status); assert.equal(failure.retrySameArguments, status === 503);
    }
    await mkdir(join(root, '.git')); await symlink(join(root, '.git'), join(root, 'alias'));
    for (const path of ['../escaped', '.git/HEAD', 'alias/HEAD']) assert.equal((await downloader.execute(root, { ...args, path }, signal, allow, 'unsafe')).code, 'PERMISSION_DENIED');
    for (const url of ['file:///etc/passwd', 'https://user:password@example.com/file']) assert.equal((await downloader.execute(root, { ...args, url }, signal, allow, 'url')).code, 'UNSAFE_URL');
    const publicOnly = new FileDownloader();
    for (const url of ['http://127.0.0.1/file', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/file']) assert.equal((await publicOnly.execute(root, { ...args, url }, signal, allow, 'ssrf')).code, 'UNSAFE_URL');
    // Redirects use the production transport after the first fixture response.
    let first = true;
    const redirect = new FileDownloader(async (url, signal, timeout) => {
      if (first) { first = false; return response([], 302, { location: 'http://127.0.0.1/private' }); }
      const { openPublicResource } = await import('../web/public-network'); return openPublicResource(url, signal, timeout);
    });
    assert.equal((await redirect.execute(root, { ...args, url: 'http://downloads.example/start' }, signal, allow, 'redirect')).code, 'UNSAFE_URL');
    await writeFile(join(root, 'existing'), 'working');
    const mismatch = await downloader.execute(root, { ...args, path: 'existing', sha256: '0'.repeat(64) }, signal, allow, 'checksum');
    assert.equal(mismatch.code, 'CHECKSUM_MISMATCH'); assert.equal(await readFile(join(root, 'existing'), 'utf8'), 'working');
    const tooLarge = await downloader.execute(root, { ...args, max_bytes: 2 }, signal, allow, 'large'); assert.equal(tooLarge.code, 'SIZE_LIMIT');
    const withoutLength = new FileDownloader(async () => response([data]));
    assert.equal((await withoutLength.execute(root, { ...args, max_bytes: 2 }, signal, allow, 'stream-limit')).code, 'SIZE_LIMIT');
    const controller = new AbortController();
    const slow = new FileDownloader(async () => response((async function* () {
      yield Buffer.alloc(1024); controller.abort(); yield Buffer.alloc(1024);
    })()));
    assert.equal((await slow.execute(root, { ...args, path: 'partial', sha256: undefined }, controller.signal, allow, 'cancel')).code, 'CANCELLED');
    assert(! (await readdir(root)).includes('partial'));
    const timeout = new FileDownloader(async (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('interrupted transport')), { once: true });
    }));
    assert.equal((await timeout.execute(root, { ...args, path: 'timed-out', timeout_ms: 1000 }, signal, allow, 'timeout')).code, 'NETWORK_TIMEOUT');
    for (const [error, code] of [[new Error('Download connection timed out'), 'NETWORK_TIMEOUT'], [Object.assign(new Error('disk full'), { code: 'ENOSPC' }), 'FILE_IO_ERROR']] as const) {
      const failure = await new FileDownloader(async () => { throw error; }).execute(root, args, signal, allow, 'classified');
      assert.equal(failure.code, code);
    }
    // Many chunks: no accumulating response body or Buffer.concat; assert real
    // output length, progress and checksum against independently streamed data.
    const chunks = 128; const chunk = Buffer.alloc(256 * 1024, 7);
    const expected = createHash('sha256'); for (let i = 0; i < chunks; i++) expected.update(chunk);
    let progress = 0;
    const streaming = new FileDownloader(async () => response((async function* () { for (let i = 0; i < chunks; i++) yield chunk; })()));
    const large = await streaming.execute(root, { ...args, path: 'large.bin', sha256: expected.digest('hex'), max_bytes: chunks * chunk.length }, signal, allow, 'stream', bytes => { progress = bytes; });
    assert.equal(large.bytes, 32 * 1024 * 1024); assert.equal(progress, large.bytes);
    assert.equal((await stat(join(root, 'large.bin'))).size, large.bytes);
    assert((await readdir(root)).every(path => !path.startsWith('.local-ai-download-')));
    console.log('Downloads: redirect/success/hash, denial, HTTP auth/404/503, SSRF, symlink/traversal, preserved destination, bounded 32 MiB streaming/progress and cancellation cleanup passed.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main();
