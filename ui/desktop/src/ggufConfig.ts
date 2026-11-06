import { compatibleFlashAttentionDefault } from './ggufFlashAttention';
import { speculationModes, validateSpeculation, speculativeArguments } from './ggufSpeculation';
import { inspectGguf } from './ggufMetadata';
import { cacheMode, effectiveCpuMoe, usesMoeExpertCache } from './moe/config';
import { assertPlacementIdentity } from './moe/placementIdentity';
// Local AI Desktop: selected-executable validation. No arbitrary extra-arguments field.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GgufProfile, RuntimeProbe } from './ggufTypes';
const execute = promisify(execFile);
// Resolve missing legacy values in memory; explicit CPU placement (0) is preserved.
export function withGpuLayerDefault(profile: GgufProfile): GgufProfile {
  return { ...profile, gpuLayers: profile.gpuLayers ?? (profile.backend === 'native' ? 0 : 999) };
}
export function runtimeError(code: string, detail = '') {
  return new Error(`GGUF:${code}:${detail}`);
}
export async function probeRuntime(executable: string): Promise<RuntimeProbe> {
  if (!path.isAbsolute(executable)) throw runtimeError('absolutePath', executable);
  try {
    await fs.access(executable, 1);
  } catch {
    throw runtimeError('missingFile', executable);
  }
  try {
    const help = await execute(executable, ['--help'], { timeout: 10000, maxBuffer: 2 ** 20 });
    const text = help.stdout + help.stderr;
    const flags = [...new Set(text.match(/--[a-z][a-z0-9-]+/g) ?? [])];
    const cacheTypes = flags.includes('--cache-type-k') && flags.includes('--cache-type-v')
      ? ['f16', ...new Set(text.match(/\b(?:q8_0|q4_0|q5_0|q5_1|q5_k|q6_k|q4_k|q3_k|q2_k|bf16|f32)\b/g) ?? [])]
      : [];
    const version = await execute(executable, ['--version'], { timeout: 10000 });
    let devices = '';
    if (flags.includes('--list-devices')) {
      try {
        const result = await execute(executable, ['--list-devices'], { timeout: 10000 });
        devices = result.stdout + result.stderr;
      } catch (error) {
        devices = String(error);
      }
    }
    const gpuAvailable = /^\s*(?:CUDA|Vulkan|SYCL|ROCm|Metal)\S*\s*:\s*.+/im.test(devices);
    return {
      executable,
      version: (version.stdout + version.stderr).trim(),
      flags,
      cacheTypes,
      speculativeModes: speculationModes(text, version.stdout + version.stderr),
      devices,
      gpuAvailable,
      apiKeyEnvironment: text.includes('LLAMA_API_KEY'),
      diagnosis: gpuAvailable
        ? 'gpuVisible'
        : flags.includes('--list-devices')
          ? 'devicesInaccessible'
          : 'backendUnsupported',
    };
  } catch (error) {
    throw runtimeError('probeFailed', String(error));
  }
}
export async function resolveFlashAttentionDefault(profile: GgufProfile, probe?: RuntimeProbe): Promise<GgufProfile> {
  if (profile.backend === 'native' || profile.flashAttention !== undefined || profile.gpuLayers <= 0) return profile;
  const capabilities = probe ?? await probeRuntime(profile.executable);
  const metadata = await inspectGguf(profile.model).catch(() => ({ architecture: undefined }));
  return compatibleFlashAttentionDefault(profile, capabilities, metadata);
}
const settingsFlags: Partial<Record<keyof GgufProfile, string>> = {
  projector: '--mmproj',
  projectorCpu: '--no-mmproj-offload',
  cacheK: '--cache-type-k',
  cacheV: '--cache-type-v',
  flashAttention: '--flash-attn',
  threads: '--threads',
  batch: '--batch-size',
  ubatch: '--ubatch-size',
  cpuMoe: '--cpu-moe',
  nCpuMoe: '--n-cpu-moe',
  tensorOverride: '--override-tensor',
  moeCacheMiB: '--moe-cache-mib',
  jinja: '--jinja',
  chatTemplate: '--chat-template',
};
export async function validateProfile(
  profile: GgufProfile,
  probe?: RuntimeProbe,
  options: { requirePlacementIdentity?: boolean } = {}
) {
  const cacheRequested = profile ? usesMoeExpertCache(profile) : false;
  // Keep an old cache size in the saved profile for a possible later re-enable,
  // but exclude it from validation whenever Standard is selected.
  if (profile?.moeCacheMode === 'standard') profile = { ...profile, moeCacheMiB: undefined };
  const allowed = [
    'id',
    'name',
    'model',
    'executable',
    'backend',
    'gpuLayers',
    'gpuBlockIds',
    'placementIdentity',
    'moeCacheMode',
    'context',
    'providerId',
    'visionEnabled',
    'kvOffload',
    'draft',
    'speculativeMode',
    'draftTokens',
    'draftMinTokens',
    'draftGpuLayers',
    ...Object.keys(settingsFlags),
  ];
  if (!profile || Object.keys(profile).some((key) => !allowed.includes(key)))
    throw runtimeError('unsupportedSetting');
  if (profile.moeCacheMode !== undefined && !['standard','automatic','manual'].includes(profile.moeCacheMode)) throw runtimeError('invalidValue','moeCacheMode');
  if (profile.gpuBlockIds !== undefined && (!Array.isArray(profile.gpuBlockIds) || profile.gpuBlockIds.length > 4096 || profile.gpuBlockIds.some(n => !Number.isInteger(n) || n < 0 || n >= 4096))) throw runtimeError('invalidValue','gpuBlockIds');
  if (profile.placementIdentity !== undefined && (typeof profile.placementIdentity !== 'string' || profile.placementIdentity.length > 256)) throw runtimeError('invalidValue','placementIdentity');
  if (!profile.name?.trim() || profile.name.length > 120) throw runtimeError('nameRequired');
  if (profile.id && !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.id))
    throw runtimeError('invalidValue', 'id');
  if (profile.backend && !['external', 'native'].includes(profile.backend))
    throw runtimeError('invalidValue', 'backend');
  for (const [key, min, max] of [
    ['gpuLayers', 0, 999],
    ['context', 512, 1048576],
    ['threads', 1, 1024],
    ['batch', 1, 65536],
    ['ubatch', 1, 65536],
    ['nCpuMoe', 0, 999],
    ['moeCacheMiB', 1, 24576],
  ] as const) {
    const value = profile[key];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max))
      throw runtimeError('invalidValue', key);
  }
  if (profile.gpuLayers === undefined || profile.context === undefined)
    throw runtimeError('invalidValue', 'gpuLayers/context');
  for (const key of ['cacheK', 'cacheV'] as const)
    if (profile[key] && !['f16', 'q8_0', 'q4_0'].includes(profile[key]!))
      throw runtimeError('invalidValue', key);
  if (profile.flashAttention && !['auto', 'on', 'off'].includes(profile.flashAttention))
    throw runtimeError('invalidValue', 'flashAttention');
  if (profile.visionEnabled !== undefined && typeof profile.visionEnabled !== 'boolean') throw runtimeError('invalidValue', 'visionEnabled');
  if (profile.projectorCpu !== undefined && typeof profile.projectorCpu !== 'boolean') throw runtimeError('invalidValue', 'projectorCpu');
  if ((profile.cpuMoe || cacheRequested) && profile.nCpuMoe !== undefined)
    throw runtimeError('conflictingMoe');
  if (profile.ubatch && profile.batch && profile.ubatch > profile.batch)
    throw runtimeError('invalidValue', 'ubatch > batch');
  if (profile.kvOffload === false && profile.backend !== 'native' && !probe?.flags.includes('--no-kv-offload')) {
    const capabilities = probe ?? (await probeRuntime(profile.executable));
    if (!capabilities.flags.includes('--no-kv-offload')) throw runtimeError('unsupportedFlag', '--no-kv-offload');
  }
  const speculation = profile.speculativeMode ?? 'off';
  if (profile.draft && profile.speculativeMode === undefined) throw runtimeError('specDraftMode');
  if (profile.draft && !path.isAbsolute(profile.draft))
    throw runtimeError('absolutePath', profile.draft);
  if (cacheRequested && (profile.gpuLayers === 0 || profile.tensorOverride))
    throw runtimeError('cacheRequirements');
  if (typeof profile.model !== 'string' || !profile.model) throw runtimeError('absolutePath');
  if (profile.backend !== 'native' && typeof profile.executable !== 'string')
    throw runtimeError('absolutePath');
  for (const file of [profile.model, profile.visionEnabled === false ? undefined : profile.projector].filter(Boolean) as string[]) {
    if (!path.isAbsolute(file)) throw runtimeError('absolutePath', file);
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const bytes = Buffer.alloc(4);
      await handle.read(bytes, 0, 4, 0);
      if (bytes.toString() !== 'GGUF') throw runtimeError('notGguf', file);
    } catch (error) {
      if (String(error).includes('GGUF:')) throw error;
      throw runtimeError('missingFile', file);
    } finally {
      await handle?.close();
    }
  }
  if (profile.backend === 'native') {
    if (speculation !== 'off') throw runtimeError('nativeUnsupported', 'speculation');
    if (profile.gpuLayers > 0) throw runtimeError('nativeGpuUnsupported');
    for (const key of [
      'projector',
      'projectorCpu',
      'cacheK',
      'cacheV',
      'ubatch',
      'cpuMoe',
      'nCpuMoe',
      'tensorOverride',
      'moeCacheMiB',
      'jinja',
      'chatTemplate',
    ] as const) {
      if (profile[key] !== undefined && profile[key] !== '' && profile[key] !== false)
        throw runtimeError('nativeUnsupported', key);
    }
    return;
  }
  const capabilities = probe ?? (await probeRuntime(profile.executable));
  if (profile.gpuBlockIds !== undefined || usesMoeExpertCache(profile)) {
    if (cacheMode(profile) !== 'standard' && !capabilities.flags.includes('--moe-cache-mib'))
      throw runtimeError('unsupportedFlag', '--moe-cache-mib');
    for (const flag of ['--parallel','--override-tensor','--fit','--load-mode','--no-host','--no-repack','--lazy-mode']) if (!capabilities.flags.includes(flag)) throw runtimeError('unsupportedFlag',flag);
    const { inspectPlacement, blockOverrides } = await import('./moe/placement');
    const metadata = await inspectPlacement(profile.model);
    if (options.requirePlacementIdentity !== false) assertPlacementIdentity(profile, metadata.identity);
    if (profile.gpuBlockIds !== undefined) blockOverrides(profile, metadata.layers ?? 0);
  }
  profile = await resolveFlashAttentionDefault(profile, capabilities);
  if (profile.projector && profile.visionEnabled !== false) {
    const [target, projector] = await Promise.all([inspectGguf(profile.model), inspectGguf(profile.projector)]);
    if (target.architecture === 'qwen35' && (projector.architecture !== 'clip' || target.embedding && projector.projectorDimension && target.embedding !== projector.projectorDimension)) throw runtimeError('visionPair');
  }
  await validateSpeculation(profile, capabilities);
  if (!capabilities.apiKeyEnvironment) throw runtimeError('credentialUnsupported');
  for (const flag of [
    '--model',
    '--host',
    '--port',
    '--gpu-layers',
    '--ctx-size',
    '--api-key',
    '--alias',
  ]) {
    if (!capabilities.flags.includes(flag)) throw runtimeError('unsupportedFlag', flag);
  }
  for (const [key, flag] of Object.entries(settingsFlags)) {
    // Cache mode derives CPU expert placement at launch. The standalone
    // checkbox is deliberately not rewritten in the saved profile.
    if (key === 'cpuMoe') continue;
    if (key === 'moeCacheMiB' && !cacheRequested) continue;
    if (profile.visionEnabled === false && ['projector','projectorCpu'].includes(key)) continue;
    const value = profile[key as keyof GgufProfile];
    if (
      value !== undefined &&
      value !== '' &&
      value !== false &&
      !capabilities.flags.includes(flag)
    )
      throw runtimeError('unsupportedFlag', flag);
  }
  if (effectiveCpuMoe(profile) && !capabilities.flags.includes('--cpu-moe'))
    throw runtimeError('unsupportedFlag', '--cpu-moe');
  for (const key of ['cacheK', 'cacheV'] as const) {
    const value = profile[key];
    if (value && !capabilities.cacheTypes.includes(value)) throw runtimeError('unsupportedValue', `${key}=${value}`);
  }
  if (
    (profile.gpuLayers > 0 ||
      /CUDA|Vulkan|SYCL|ROCm|Metal/i.test(profile.tensorOverride ?? '') ||
      profile.moeCacheMiB) &&
    !capabilities.gpuAvailable
  )
    throw runtimeError(capabilities.diagnosis, capabilities.devices || capabilities.version);
  if (profile.cpuMoe || profile.nCpuMoe !== undefined || cacheRequested) {
    const metadata = await inspectGguf(profile.model);
    if (!metadata.experts || metadata.experts < 2) throw runtimeError('moeMetadata');
    if (profile.nCpuMoe && metadata.layers && profile.nCpuMoe > metadata.layers)
      throw runtimeError('invalidValue', 'nCpuMoe > layers');
  }
  if (profile.cacheV && profile.cacheV !== 'f16' && profile.flashAttention !== 'on')
    throw runtimeError('quantizedCache');
  if (cacheRequested) {
    for (const flag of ['--no-host', '--no-repack', '--lazy-mode'])
      if (!capabilities.flags.includes(flag)) throw runtimeError('unsupportedFlag', flag);
    if ((profile.batch ?? 512) > 512 || (profile.ubatch ?? 128) > 128)
      throw runtimeError('cacheRequirements');
  }
  if (profile.tensorOverride && !/^[^\r\n\0]{1,4096}$/.test(profile.tensorOverride))
    throw runtimeError('invalidValue', 'tensorOverride');
}
export function buildArguments(profile: GgufProfile, port: number): string[] {
  const cacheRequested = usesMoeExpertCache(profile);
  if (cacheRequested && profile.nCpuMoe !== undefined) throw runtimeError('conflictingMoe');
  const effectiveProfile =
    cacheMode(profile) === 'standard' ? { ...profile, moeCacheMiB: undefined } : profile;
  const args = [
    '--model',
    profile.model,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--gpu-layers',
    String(profile.gpuLayers),
    '--ctx-size',
    String(profile.context),
    '--alias',
    'local-gguf',
  ];
  if (profile.kvOffload === false) args.push('--no-kv-offload');
  if (effectiveCpuMoe(effectiveProfile)) args.push('--cpu-moe');
  for (const [key, flag] of Object.entries(settingsFlags)) {
    if (key === 'cpuMoe') continue;
    if (effectiveProfile.visionEnabled === false && ['projector','projectorCpu'].includes(key)) continue;
    const value = effectiveProfile[key as keyof GgufProfile];
    if (value === undefined || value === '' || value === false) continue;
    args.push(flag);
    if (value !== true) args.push(String(value));
  }
  if (effectiveProfile.moeCacheMiB || profile.gpuBlockIds !== undefined) {
    args.push('--fit','off','--load-mode','mmap','--parallel','1');
    args.push('--no-host', '--no-repack', '--lazy-mode', 'off');
    if (!profile.batch) args.push('--batch-size', '512');
    if (!profile.ubatch) args.push('--ubatch-size', '128');
  }
  args.push(...speculativeArguments(profile));
  return args;
}

// Inspection is allowed before confirmation; save and launch retain strict validation.
export async function inspectProfile(profile: GgufProfile) {
  await validateProfile(profile, undefined, { requirePlacementIdentity: false });
  const { requiresPlacementIdentity, needsPlacementIdentityConfirmation } = await import('./moe/placementIdentity');
  if (!requiresPlacementIdentity(profile)) return { placementConfirmationRequired: false };
  const { inspectPlacement } = await import('./moe/placement');
  const inspection = await inspectPlacement(profile.model);
  return { placementConfirmationRequired: needsPlacementIdentityConfirmation(profile, inspection.identity) };
}

export async function preflightLaunchProfile(profile: GgufProfile, probe: RuntimeProbe) {
  await validateProfile(profile, probe);
  const { resolvePlacement } = await import('./moe/placement');
  return resolvePlacement(profile, probe);
}
