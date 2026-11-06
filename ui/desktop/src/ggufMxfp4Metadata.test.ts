import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSpeculativeMetadata } from './ggufSpeculativeMetadata';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const string = (value: string) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);

async function writeMxfp4Gguf(file: string, firstDimension: number) {
  const header = Buffer.concat([
    Buffer.from('GGUF'),
    u32(3),
    u64(1),
    u64(0),
    string('blk.0.ffn_gate_exps.weight'),
    u32(3),
    u64(firstDimension),
    u64(32),
    u64(128),
    u32(39),
    u64(0),
  ]);
  const dataStart = Math.ceil(header.length / 32) * 32;
  const elements = firstDimension * 32 * 128;
  const dataBytes = Math.ceil(elements / 32) * 17;
  await writeFile(file, Buffer.concat([header, Buffer.alloc(dataStart - header.length), Buffer.alloc(dataBytes)]));
}

describe('GGUF MXFP4 tensor metadata', () => {
  it('accounts for 32-value, 17-byte MXFP4 blocks used by GPT-OSS weights', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gguf-mxfp4-'));
    try {
      const file = join(directory, 'mxfp4.gguf');
      await writeMxfp4Gguf(file, 32);
      const metadata = await readSpeculativeMetadata(file);
      const tensor = metadata.tensors['blk.0.ffn_gate_exps.weight'];
      expect(tensor).toMatchObject({ type: 39, shape: [32, 32, 128], bytes: 69632, valid: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not certify MXFP4 rows whose first dimension is not block aligned', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gguf-mxfp4-row-'));
    try {
      const file = join(directory, 'invalid.gguf');
      await writeMxfp4Gguf(file, 31);
      const metadata = await readSpeculativeMetadata(file);
      expect(metadata.tensors['blk.0.ffn_gate_exps.weight'].valid).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
