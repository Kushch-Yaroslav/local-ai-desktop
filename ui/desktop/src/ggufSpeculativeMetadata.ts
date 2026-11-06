// Local AI Desktop addition: bounded metadata/tensor-directory validation; no weight mapping/allocation, only bounded directory lookahead.
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export interface SpeculativeMetadata {
  values: Record<string, string | number | boolean>;
  thinkingToggle?: boolean;
  nativeQwenEfforts?: boolean;
  reasoningControlsPresent?: boolean;
  tokenizer: Record<string, string>;
  tensors: Record<string, { shape: number[]; type: number; bytes?: number; valid: boolean }>;
  identity: string;
}
const cache = new Map<string, SpeculativeMetadata>();
export async function readSpeculativeMetadata(file: string): Promise<SpeculativeMetadata> {
  const resolved = await realpath(file).catch(() => {
    throw Error('GGUF:missingFile:' + file);
  });
  const fd = await open(resolved, 'r');
  try {
    const stat = await fd.stat({ bigint: true });
    if (!stat.isFile()) throw Error('not a file');
    const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const existing = cache.get(resolved);
    if (existing?.identity === identity) return existing;
    const fileSize = Number(stat.size);
    let position = 0;
    let cachedStart = -1;
    let chunk = Buffer.alloc(0);
    const maxDirectory = 128 * 1024 * 1024;
    const bytes = async (size: number): Promise<Buffer> => {
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        position + size > fileSize ||
        position + size > maxDirectory
      )
        throw Error('directory bounds');
      if (position < cachedStart || position + size > cachedStart + chunk.length) {
        const count = Math.min(Math.max(65536, size), fileSize - position, maxDirectory - position);
        chunk = Buffer.alloc(count);
        const read = await fd.read(chunk, 0, count, position);
        chunk = chunk.subarray(0, read.bytesRead);
        cachedStart = position;
      }
      if (position + size > cachedStart + chunk.length) throw Error('truncated directory');
      const result = chunk.subarray(position - cachedStart, position - cachedStart + size);
      position += size;
      return result;
    };
    const u32 = async () => (await bytes(4)).readUInt32LE();
    const u64 = async () => {
      const n = Number((await bytes(8)).readBigUInt64LE());
      if (!Number.isSafeInteger(n)) throw Error('integer overflow');
      return n;
    };
    const text = async () => {
      const size = await u64();
      if (size > 16 * 1024 * 1024) throw Error('oversized string');
      return (await bytes(size)).toString('utf8');
    };
    const widths: Record<number, number> = {
      0: 1,
      1: 1,
      2: 2,
      3: 2,
      4: 4,
      5: 4,
      6: 4,
      7: 1,
      10: 8,
      11: 8,
      12: 8,
    };
    const value = async (
      type: number,
      digest?: ReturnType<typeof createHash>,
      depth = 0
    ): Promise<string | number | boolean | undefined> => {
      if (depth > 2) throw Error('nested metadata');
      if (type === 8) {
        const size = await u64();
        digest?.update(String(size) + ':');
        const data = await bytes(size);
        digest?.update(data);
        return digest ? undefined : data.toString('utf8');
      }
      if (type === 9) {
        const element = await u32(),
          count = await u64();
        if (count > 2000000 || element === 9) throw Error('oversized array');
        digest?.update(`${element}:${count}:`);
        if (element !== 8) {
          const width = widths[element];
          if (!width) throw Error('unknown array type');
          const data = await bytes(width * count);
          digest?.update(data);
        } else for (let i = 0; i < count; i++) await value(element, digest, depth + 1);
        return;
      }
      const width = widths[type];
      if (!width) throw Error('unknown metadata type');
      const b = await bytes(width);
      digest?.update(b);
      if (type === 7) return b[0] !== 0;
      if (type === 10) return Number(b.readBigUInt64LE());
      if (type === 11) return Number(b.readBigInt64LE());
      if (type === 6) return b.readFloatLE();
      if (type === 12) return b.readDoubleLE();
      return type % 2 === 0 ? b.readUIntLE(0, width) : b.readIntLE(0, width);
    };
    if ((await bytes(4)).toString('ascii') !== 'GGUF' || ![2, 3].includes(await u32()))
      throw Error('GGUF version');
    const tensorCount = await u64(),
      count = await u64();
    if (count > 10000 || tensorCount > 200000) throw Error('oversized directory');
    const result: SpeculativeMetadata = { identity, values: {}, tokenizer: {}, tensors: {} };
    for (let i = 0; i < count; i++) {
      const key = await text(),
        type = await u32();
      const digest = key.startsWith('tokenizer.ggml.')
        ? createHash('sha256').update(`${type}:`)
        : undefined;
      const item = await value(type, digest);
      if (digest) result.tokenizer[key] = digest.digest('hex');
      if (key === 'tokenizer.chat_template' && typeof item === 'string') {
        result.reasoningControlsPresent = /\b(?:enable_thinking|reasoning_effort)\b/.test(item);
        result.thinkingToggle = /\bif\s+(?:not\s+)?enable_thinking\b|\benable_thinking\s+is\s+(?:not\s+)?defined\b/.test(item);
        const guard = /resolved_reasoning_effort\s+not\s+in\s*\(([^)]*)\)/.exec(item)?.[1] ?? '';
        const levels = [...guard.matchAll(/'([^']+)'/g)].map(match => match[1]);
        result.nativeQwenEfforts = levels.length === 3 && ['low','medium','xhigh'].every(level => levels.includes(level));
      }
      if (
        item !== undefined &&
        /^(general\.(architecture|alignment|name|file_type))$|\.(context_length|embedding_length|embedding_length_out|block_count|nextn_predict_layers|expert_count|head_count|head_count_kv|key_length|value_length|full_attention_interval|count)$/.test(
          key
        )
      )
        result.values[key] = item;
    }
    const tensors: Array<{ name: string; shape: number[]; type: number; offset: number }> = [];
    for (let i = 0; i < tensorCount; i++) {
      const name = await text(),
        dimensions = await u32();
      if (dimensions < 1 || dimensions > 4) throw Error('tensor dimensions');
      const shape = [];
      for (let d = 0; d < dimensions; d++) shape.push(await u64());
      const type = await u32(),
        offset = await u64();
      if (shape.some((n) => n < 1)) throw Error('tensor shape');
      tensors.push({ name, shape, type, offset });
    }
    const alignment = Number(result.values['general.alignment'] ?? 32);
    if (!Number.isInteger(alignment) || alignment < 1 || alignment > 4096) throw Error('alignment');
    const start = Math.ceil(position / alignment) * alignment;
    const layouts: Record<number, [number, number]> = {
      0: [1, 4],
      1: [1, 2],
      2: [32, 18],
      3: [32, 20],
      6: [32, 22],
      7: [32, 24],
      8: [32, 34],
      12: [256, 144],
      13: [256, 176],
      14: [256, 210],
      15: [256, 292],
      // MXFP4: one E8M0 scale byte and sixteen packed 4-bit values per 32 values.
      39: [32, 17],
      30: [1, 2],
    };
    for (const tensor of tensors) {
      const layout = layouts[tensor.type],
        elements = tensor.shape.reduce((a, b) => a * b, 1);
      const length = layout ? (elements / layout[0]) * layout[1] : NaN;
      result.tensors[tensor.name] = {
        shape: tensor.shape,
        type: tensor.type,
        bytes: Number.isSafeInteger(length) ? length : undefined,
        valid:
          Number.isSafeInteger(elements) &&
          Number.isSafeInteger(length) &&
          length > 0 &&
          (tensor.type !== 39 || tensor.shape[0] % 32 === 0) &&
          start + tensor.offset + length <= fileSize,
      };
    }
    const after = await fd.stat({ bigint: true });
    if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== identity)
      throw Error('file changed during inspection');
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(resolved, result);
    return result;
  } catch {
    throw Error('GGUF:specMetadata:');
  } finally {
    await fd.close();
  }
}
