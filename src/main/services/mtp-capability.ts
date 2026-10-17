import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import type { MtpCapability, MtpMode } from '../../shared/types';
import { readGgufSpeculativeMetadata } from './gguf-speculative';
import { ggufArtifactPaths } from './gguf-artifacts';
import { executablePath } from './runtime-settings';

/** Only graph families inspected/tested for embedded MTP, not ordinary draft models. */
export function embeddedMtpCapability(path: string): MtpCapability {
  try {
    const metadata = readGgufSpeculativeMetadata(path);
    const architecture = String(metadata.values['general.architecture'] ?? '');
    if (!['qwen35', 'qwen35moe'].includes(architecture)) return { supported: false, status: 'unsupported', architecture, reason: `Embedded MTP is not validated for architecture ${architecture || 'unknown'}.` };
    const heads = Number(metadata.values[`${architecture}.nextn_predict_layers`] ?? 0);
    if (heads !== 1) return { supported: false, status: heads === 0 ? 'requires-weights' : 'unsupported', architecture, heads, reason: heads === 0 ? 'This GGUF has no embedded MTP head. Compatible additional weights would be required; automatic downloads are disabled.' : 'This backend integration supports one Qwen MTP head.' };
    const block = Number(metadata.values[`${architecture}.block_count`]) - 1;
    const embedding = Number(metadata.values[`${architecture}.embedding_length`]);
    const tensors = Object.assign({}, ...ggufArtifactPaths(path).map(file => readGgufSpeculativeMetadata(file).tensors ?? {})) as Record<string, number[]>;
    const prefix = `blk.${block}.nextn.`;
    const projection = tensors[prefix + 'eh_proj.weight'];
    if (!tensors['blk.0.attn_norm.weight'] || !projection || projection[0] !== embedding * 2 || projection[1] !== embedding || !['enorm.weight', 'hnorm.weight'].every(name => tensors[prefix + name]?.[0] === embedding)) {
      return { supported: false, status: 'requires-weights', architecture, heads, reason: 'GGUF metadata declares MTP but the full target/embedded head tensors are missing or incompatible.' };
    }
    return { supported: true, status: 'available', architecture, heads, reason: 'Embedded Qwen MTP tensors verified. Activation still requires successful backend initialization.' };
  } catch (error) { return { supported: false, status: 'error', reason: `Cannot inspect MTP weights: ${error instanceof Error ? error.message : String(error)}` }; }
}
const probes = new Map<string, Promise<boolean>>();
export function backendMtpCapability(input: string | null): Promise<boolean> {
  if (!input) return Promise.resolve(false);
  try {
    const path = executablePath(input), file = statSync(path);
    const key = `${path}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
    let result = probes.get(key);
    if (!result) {
      result = new Promise<boolean>(resolve => execFile(path, ['--help'], { timeout: 3000, maxBuffer: 256 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => resolve(!error && /--spec-type\s[^\n]*\bdraft-mtp\b/.test(stdout + stderr))));
      probes.set(key, result); if (probes.size > 16) probes.delete(probes.keys().next().value!);
    }
    return result;
  } catch { return Promise.resolve(false); }
}
export async function mtpCapability(path: string, server: string | null): Promise<MtpCapability> {
  const model = embeddedMtpCapability(path), backendSupported = await backendMtpCapability(server);
  if (!model.supported) return { ...model, backendSupported };
  return backendSupported ? { ...model, backendSupported } : { ...model, supported: false, backendSupported, status: 'unsupported', reason: 'Configured llama-server does not advertise draft-mtp support.' };
}
export async function resolveMtpMode(mode: MtpMode, path: string, server: string | null): Promise<'mtp' | 'none'> {
  if (mode === 'off') return 'none';
  const capability = await mtpCapability(path, server);
  if (mode === 'on' && !capability.supported) throw new Error(`MTP On unavailable: ${capability.reason}`);
  return capability.supported ? 'mtp' : 'none';
}
