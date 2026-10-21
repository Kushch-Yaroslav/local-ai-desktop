import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { builtinModelCatalog } from '../models/model-catalog';
import type { RuntimeModelConfiguration } from '../../shared/types';

/** Explicit test-only profiles. A clean production registry must stay empty. */
export function agentFixtureModels(root: string): RuntimeModelConfiguration[] {
  return builtinModelCatalog.map(model => ({
    id: model.id, displayName: model.displayName, modelPath: join(root, model.modelPath),
    mmprojPath: model.mmprojPath ? join(root, model.mmprojPath) : '',
    gpuLayers: 999, supportsTools: model.supportsTools, speculative: 'none', mtpMode: 'off', builtin: true,
  }));
}

export async function seedAgentFixtureModels(root: string): Promise<void> {
  const settings = await import('./runtime-settings');
  const config = settings.loadRuntimeConfiguration();
  const models = agentFixtureModels(root).map(model => ({...model, mmprojPath:''}));
  const u64 = (n: number) => { const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const text = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
  const stringType = Buffer.from([8,0,0,0]);
  for (const model of models) {
    mkdirSync(dirname(model.modelPath),{recursive:true});
    const header=Buffer.alloc(24);header.write('GGUF');header.writeUInt32LE(3,4);header.writeBigUInt64LE(2n,16);
    writeFileSync(model.modelPath,Buffer.concat([header,text('general.architecture'),stringType,text('qwen35'),text('tokenizer.chat_template'),stringType,text('{% if enable_thinking %}thinking{% endif %}{{ reasoning_effort }} xhigh')]));
  }
  settings.saveRuntimeConfiguration({ ...config, models });
}
