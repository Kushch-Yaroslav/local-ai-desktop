// Synthetic GGUF directories and tiny placeholder tensor storage. Never real model weights.
function u32(v: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}
function u64(v: number) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}
function str(v: string) {
  const b = Buffer.from(v);
  return Buffer.concat([u64(b.length), b]);
}
export function speculativeFixture({
  architecture = 'qwen35',
  head = true,
  tokens = ['a', 'b'],
  embedding = 8,
  context = 8192,
  badHead = false,
  truncated = false,
  attentionHeads,
  chatTemplate,
}: {
  architecture?: string;
  head?: boolean;
  tokens?: readonly string[];
  embedding?: number;
  context?: number;
  badHead?: boolean;
  truncated?: boolean;
  attentionHeads?: number;
  chatTemplate?: string;
} = {}) {
  const fields = [
    ...(chatTemplate ? [Buffer.concat([str('tokenizer.chat_template'), u32(8), str(chatTemplate)])] : []),
    Buffer.concat([str('general.architecture'), u32(8), str(architecture)]),
    ...Object.entries({
      [architecture + '.block_count']: head ? 2 : 1,
      [architecture + '.context_length']: context,
      [architecture + '.embedding_length']: embedding,
      [architecture + '.nextn_predict_layers']: head ? 1 : 0,
      ...(attentionHeads ? { [architecture + '.attention.head_count']: attentionHeads } : {}),
    }).map(([key, value]) => Buffer.concat([str(key), u32(4), u32(value)])),
    Buffer.concat([str('tokenizer.ggml.model'), u32(8), str('gpt2')]),
    Buffer.concat([
      str('tokenizer.ggml.tokens'),
      u32(9),
      u32(8),
      u64(tokens.length),
      ...tokens.map(str),
    ]),
  ];
  const tensors = [
    { name: 'blk.0.attn_norm.weight', shape: [embedding] },
    ...(head
      ? [
          { name: 'blk.1.nextn.eh_proj.weight', shape: [embedding * (badHead ? 3 : 2), embedding] },
          { name: 'blk.1.nextn.enorm.weight', shape: [embedding] },
          { name: 'blk.1.nextn.hnorm.weight', shape: [embedding] },
        ]
      : []),
  ];
  let offset = 0;
  const entries = tensors.map((t) => {
    offset = Math.ceil(offset / 32) * 32;
    const start = offset;
    offset += t.shape.reduce((a, b) => a * b, 1) * 4;
    return Buffer.concat([
      str(t.name),
      u32(t.shape.length),
      ...t.shape.map(u64),
      u32(0),
      u64(start),
    ]);
  });
  const directory = Buffer.concat([
    Buffer.from('GGUF'),
    u32(3),
    u64(tensors.length),
    u64(fields.length),
    ...fields,
    ...entries,
  ]);
  return Buffer.concat([
    directory,
    Buffer.alloc(Math.ceil(directory.length / 32) * 32 - directory.length),
    Buffer.alloc(truncated ? 0 : offset),
  ]);
}
