import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { paths } from './paths';

export function attachmentStoragePath(path: string): string {
  const root = resolve(paths.attachments), absolute = resolve(path), rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Attachment path is outside managed storage.');
  return absolute;
}

/** Reject symlinks in every component, including the managed root itself. */
export async function validateAttachmentPath(path: string): Promise<string> {
  const absolute = attachmentStoragePath(path), root = resolve(paths.attachments);
  for (let current = absolute; ; current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Symlinks are not permitted in attachment storage.');
    if (current === root) break;
  }
  return absolute;
}

/** Open once, check the opened descriptor, and bound bytes before reading. */
export async function readManagedAttachment(path: string, maximumBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const absolute = await validateAttachmentPath(path);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error('Attachment is not a bounded regular file.');
    if (process.platform === 'linux') attachmentStoragePath(await realpath(`/proc/self/fd/${handle.fd}`));
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > info.size) throw new Error('Attachment changed while reading.');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
