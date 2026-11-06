// Local AI Desktop: bounded GGUF metadata inspection; never maps tensor weights.
import fs from 'node:fs/promises';
export interface GgufMetadata {
  architecture?: string;
  name?: string;
  layers?: number;
  context?: number;
  experts?: number;
  embedding?: number;
  projectorDimension?: number;
  projectorType?: string;
  toolTemplate?: boolean;
  complete: boolean;
}
export async function inspectGguf(file: string): Promise<GgufMetadata> {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    if (header.toString('ascii', 0, 4) !== 'GGUF' || ![2, 3].includes(header.readUInt32LE(4)))
      throw Error('GGUF:notGguf:' + file);
    const count = Number(header.readBigUInt64LE(16));
    if (!Number.isSafeInteger(count) || count > 10000) throw Error('GGUF:invalidValue:metadata');
    // Read only metadata-sized chunks as parsing advances; no weights are allocated or mapped.
    let offset = 24;
    let budget = 32 * 1024 * 1024;
    const take = async (size: number) => {
      if (!Number.isSafeInteger(size) || size < 0 || size > budget) throw Error('metadata budget');
      const b = Buffer.alloc(size);
      const { bytesRead } = await handle.read(b, 0, size, offset);
      if (bytesRead !== size) throw Error('metadata truncated');
      offset += size;
      budget -= size;
      return b;
    };
    const string = async (capture = true) => {
      const size = Number((await take(8)).readBigUInt64LE());
      if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024)
        throw Error('metadata string');
      if (!capture) {
        offset += size;
        budget -= size;
        if (budget < 0) throw Error('metadata budget');
        return '';
      }
      return (await take(size)).toString('utf8');
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
    const scalar = async (
      type: number,
      capture: boolean
    ): Promise<string | number | boolean | undefined> => {
      if (type === 8) return string(capture);
      if (type === 9) {
        const element = (await take(4)).readUInt32LE();
        const length = Number((await take(8)).readBigUInt64LE());
        if (!Number.isSafeInteger(length) || length > 2000000 || element === 9)
          throw Error('metadata array');
        if (element === 8) {
          for (let j = 0; j < length; j++) await string(false);
        } else {
          const size = length * widths[element];
          if (!Number.isSafeInteger(size)) throw Error('metadata type');
          offset += size;
          budget -= size;
          if (budget < 0) throw Error('metadata budget');
        }
        return undefined;
      }
      const width = widths[type];
      if (!width) throw Error('metadata type');
      if (!capture) {
        offset += width;
        budget -= width;
        return undefined;
      }
      const b = await take(width);
      if (type === 7) return b[0] !== 0;
      if (type === 6) return b.readFloatLE();
      if (type === 12) return b.readDoubleLE();
      if (type === 10) return Number(b.readBigUInt64LE());
      if (type === 11) return Number(b.readBigInt64LE());
      return type % 2 === 0 ? b.readUIntLE(0, width) : b.readIntLE(0, width);
    };
    const values: Record<string, string | number | boolean | undefined> = {};
    let complete = true;
    for (let i = 0; i < count; i++) {
      try {
        const key = await string();
        const type = (await take(4)).readUInt32LE();
        if (key === 'tokenizer.ggml.tokens') {
          complete = false;
          break;
        }
        const wanted =
          /^(general\.(architecture|name)|tokenizer\.chat_template|clip\.projector_type)$|\.(block_count|context_length|expert_count|embedding_length|projection_dim)$/.test(
            key
          );
        values[key] = await scalar(type, wanted);
      } catch {
        complete = false;
        break;
      }
      // All placement information precedes tokenizer vocabularies in standard GGUFs.
      if (values['general.architecture'] && keyAvailable(values)) {
        complete = false;
        break;
      }
    }
    const architecture = values['general.architecture'] as string | undefined;
    return {
      architecture,
      name: values['general.name'] as string | undefined,
      layers: values[`${architecture}.block_count`] as number | undefined,
      context: values[`${architecture}.context_length`] as number | undefined,
      embedding: values[`${architecture}.embedding_length`] as number | undefined,
      projectorDimension: values['clip.vision.projection_dim'] as number | undefined,
      projectorType: values['clip.projector_type'] as string | undefined,
      experts: values[`${architecture}.expert_count`] as number | undefined,
      toolTemplate:
        typeof values['tokenizer.chat_template'] === 'string'
          ? /\btools\b/.test(values['tokenizer.chat_template'])
          : undefined,
      complete,
    };
  } finally {
    await handle.close();
  }
}
function keyAvailable(values: Record<string, unknown>) {
  const arch = values['general.architecture'];
  return (
    typeof arch === 'string' &&
    values[`${arch}.expert_count`] !== undefined &&
    values[`${arch}.block_count`] !== undefined &&
    values[`${arch}.context_length`] !== undefined
  );
}
