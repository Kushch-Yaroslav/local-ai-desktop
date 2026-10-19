import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
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
export type BackendMtpProbe = { status: 'supported' | 'unsupported' | 'error'; path?: string; reason: string };
const probes = new Map<string, Promise<BackendMtpProbe>>();
/** Read the option's entire help block, including wrapped enum values. */
export function advertisesMtp(help: string): boolean {
  const block = /(?:^|\s)--spec-type\b([\s\S]*?)(?=\n\S|$)/.exec(help);
  return Boolean(block && /\bdraft-mtp\b/.test(block[1]));
}
export async function probeBackendMtp(input: string | null): Promise<BackendMtpProbe> {
  try {
    // Match runtimeSetup's PATH fallback rather than treating an unset override
    // as proof that the launcher cannot support MTP.
    const path = realpathSync(executablePath(input ?? 'llama-server')), file = statSync(path);
    const key = `${path}:${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}:${Math.floor(Date.now() / 60_000)}`;
    let result = probes.get(key);
    if (!result) {
      result = new Promise<BackendMtpProbe>(resolve => execFile(path, ['--help'], { timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
        if (error) {
          resolve({ status: 'error', path, reason: `Cannot probe llama-server ${path}: ${error.message}. ${stderr.trim().slice(-1500)}` });
        } else {
          const supported = advertisesMtp(stdout + '\n' + stderr);
          resolve({ status: supported ? 'supported' : 'unsupported', path, reason: supported ? `llama-server ${path} advertises --spec-type draft-mtp.` : `llama-server ${path} --help does not advertise --spec-type draft-mtp.` });
        }
      }));
      probes.set(key, result);
      if (probes.size > 16) probes.delete(probes.keys().next().value!);
      // A transient timeout/exec failure is unknown capability, never a cached
      // negative. Share concurrent probes, allow the next request to recover.
      void result.then(value => { if (value.status === 'error' && probes.get(key) === result) probes.delete(key); });
    }
    return await result;
  } catch (error) { return { status: 'error', reason: `Cannot resolve llama-server: ${error instanceof Error ? error.message : String(error)}` }; }
}
export async function backendMtpCapability(input: string | null): Promise<boolean> {
  return (await probeBackendMtp(input)).status === 'supported';
}
export async function mtpCapability(path: string, server: string | null): Promise<MtpCapability> {
  const model = embeddedMtpCapability(path), backend = await probeBackendMtp(server);
  const backendSupported = backend.status === 'error' ? undefined : backend.status === 'supported';
  if (!model.supported) return { ...model, backendSupported };
  return backend.status === 'supported' ? { ...model, backendSupported }
    : { ...model, supported: false, backendSupported, status: backend.status === 'error' ? 'error' : 'unsupported', reason: backend.reason };
}
export async function resolveMtpMode(mode: MtpMode, path: string, server: string | null): Promise<'mtp' | 'none'> {
  if (mode === 'off') return 'none';
  const capability = await mtpCapability(path, server);
  if (mode === 'on' && !capability.supported) throw new Error(`MTP On unavailable: ${capability.reason}`);
  return capability.supported ? 'mtp' : 'none';
}
