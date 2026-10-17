import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export type GgufSpeculativeMetadata = { values: Record<string, string | number | boolean>; tokenizer: Record<string, string>; tensors?: Record<string, number[]> };

const metadataCache = new Map<string, { identity: string; metadata?: GgufSpeculativeMetadata; error?: string }>();
const metadataCacheLimit = 32;

function fileIdentity(path: string): string | undefined {
  try {
    const file = statSync(path, { bigint: true });
    if (!file.isFile()) return undefined;
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
  } catch { return undefined; }
}

function cacheMetadata(path: string, identity: string, result: { metadata?: GgufSpeculativeMetadata; error?: string }): void {
  const key = resolve(path);
  metadataCache.delete(key);
  metadataCache.set(key, { identity, ...result });
  if (metadataCache.size > metadataCacheLimit) metadataCache.delete(metadataCache.keys().next().value!);
}

/** Bounded, buffered metadata inspection. No model tensors are interpreted or loaded for inference. */
export function readGgufSpeculativeMetadata(path: string): GgufSpeculativeMetadata {
  const key = resolve(path);
  const before = fileIdentity(path);
  const cached = metadataCache.get(key);
  if (before && cached?.identity === before) {
    // Reads are shared by readiness checks and launch configuration. The
    // returned records are immutable so one caller cannot poison the cache.
    metadataCache.delete(key);
    metadataCache.set(key, cached);
    if (cached.error) throw new Error(cached.error);
    return cached.metadata!;
  }
  try {
    const metadata = parseGgufSpeculativeMetadata(path);
    const after = fileIdentity(path);
    if (before && before === after) {
      Object.freeze(metadata.values);
      Object.freeze(metadata.tokenizer);
      Object.freeze(metadata);
      cacheMetadata(path, before, { metadata });
    }
    return metadata;
  } catch (error) {
    const after = fileIdentity(path);
    const message = error instanceof Error ? error.message : String(error);
    if (before && before === after) cacheMetadata(path, before, { error: message });
    throw error;
  }
}

function parseGgufSpeculativeMetadata(path: string): GgufSpeculativeMetadata {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const window = Buffer.alloc(64 * 1024);
    let position = 0, windowStart = -1, windowLength = 0;
    const bytes = (length: number): Buffer => {
      if (!Number.isSafeInteger(length) || length < 0 || position + length > Math.min(size, 64 * 1024 ** 2)) throw new Error('Некорректные или обрезанные метаданные draft GGUF.');
      const result = Buffer.alloc(length);
      for (let copied = 0; copied < length;) {
        if (position < windowStart || position >= windowStart + windowLength) {
          windowStart = position;
          windowLength = readSync(fd, window, 0, Math.min(window.length, size - position), position);
          if (!windowLength) throw new Error('Метаданные draft GGUF обрезаны.');
        }
        const count = Math.min(length - copied, windowStart + windowLength - position);
        window.copy(result, copied, position - windowStart, position - windowStart + count);
        position += count; copied += count;
      }
      return result;
    };
    const u32 = () => bytes(4).readUInt32LE();
    const u64 = () => { const n = bytes(8).readBigUInt64LE(); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Слишком большие метаданные GGUF.'); return Number(n); };
    const text = () => { const n = u64(); if (n > 4 * 1024 ** 2) throw new Error('Слишком длинная строка GGUF.'); return bytes(n).toString('utf8'); };
    const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const value = (type: number, digest?: ReturnType<typeof createHash>, depth = 0): string | number | boolean | undefined => {
      if (depth > 1) throw new Error('Вложенный массив GGUF не поддерживается.');
      if (type === 8) { const length = bytes(8); const n = Number(length.readBigUInt64LE()); if (n > 4 * 1024 ** 2) throw new Error('Слишком длинная строка GGUF.'); const b = bytes(n); digest?.update(length).update(b); return b.toString('utf8'); }
      if (type === 9) {
        const header = bytes(12), element = header.readUInt32LE(), count = Number(header.readBigUInt64LE(4));
        if (!Number.isSafeInteger(count) || count > 1_000_000) throw new Error('Слишком большой массив GGUF.');
        digest?.update(header);
        for (let i = 0; i < count; i += 1) value(element, digest, depth + 1);
        return undefined;
      }
      if (!sizes[type]) throw new Error(`Неизвестный тип GGUF: ${type}.`);
      const b = bytes(sizes[type]); digest?.update(b);
      if (type === 4) return b.readUInt32LE();
      if (type === 10) return Number(b.readBigUInt64LE());
      if (type === 7) return Boolean(b[0]);
      return undefined;
    };
    if (bytes(4).toString('ascii') !== 'GGUF' || ![2, 3].includes(u32())) throw new Error('Draft должен быть корректным GGUF v2/v3.');
    const tensorCount = u64(); const count = u64();
    if (count > 1_000_000) throw new Error('Слишком много полей GGUF.');
    const metadata: GgufSpeculativeMetadata = { values: {}, tokenizer: {} };
    for (let i = 0; i < count; i += 1) {
      const key = text(), type = u32();
      const digest = key.startsWith('tokenizer.ggml.') ? createHash('sha256').update(String(type)) : undefined;
      const item = value(type, digest);
      if (item !== undefined) metadata.values[key] = item;
      if (digest) metadata.tokenizer[key] = digest.digest('hex');
    }
    if (tensorCount > 100_000) throw new Error('Слишком много тензоров GGUF.');
    metadata.tensors = {};
    const locations: Array<{ name: string; shape: number[]; type: number; offset: number }> = [];
    for (let i = 0; i < tensorCount; i++) {
      const name = text(), dimensions = u32();
      if (dimensions < 1 || dimensions > 4) throw new Error('Некорректные размеры тензора GGUF.');
      const shape = Array.from({ length: dimensions }, u64);
      const type = u32(); const offset = u64();
      if (shape.some(n => n < 1) || offset >= size) throw new Error('Некорректный тензор GGUF.');
      locations.push({ name, shape, type, offset });
    }
    const alignment = Number(metadata.values['general.alignment'] ?? 32);
    if (!Number.isSafeInteger(alignment) || alignment < 1 || alignment > 4096) throw new Error('Некорректное выравнивание GGUF.');
    const dataStart = Math.ceil(position / alignment) * alignment;
    const layouts: Record<number, [number, number]> = { 0: [1, 4], 1: [1, 2], 2: [32, 18], 3: [32, 20], 6: [32, 22], 7: [32, 24], 8: [32, 34], 12: [256, 144], 13: [256, 176], 14: [256, 210], 15: [256, 292], 30: [1, 2] };
    for (const tensor of locations) {
      const layout = layouts[tensor.type];
      if (!layout) continue; // Unknown quantizations cannot certify MTP weights.
      const elements = tensor.shape.reduce((a, b) => a * b, 1);
      const extent = dataStart + tensor.offset + elements / layout[0] * layout[1];
      if (Number.isSafeInteger(elements) && Number.isInteger(elements / layout[0]) && extent <= size) metadata.tensors[tensor.name] = Object.freeze(tensor.shape) as number[];
    }
    Object.freeze(metadata.tensors);
    return metadata;
  } finally { closeSync(fd); }
}
