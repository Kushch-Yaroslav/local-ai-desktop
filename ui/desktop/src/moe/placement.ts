// Local AI Desktop: adapter around the unchanged v0.3.2.0 placement/memory core.
import { readFile } from 'node:fs/promises';
import { readSpeculativeMetadata } from '../ggufSpeculativeMetadata';
import { sampleMemory } from '../memoryTelemetry';
import type { GgufProfile, RuntimeProbe } from '../ggufTypes';
import { cacheMode, effectiveCpuMoe } from './config';
import { assertPlacementIdentity } from './placementIdentity';
import type { ModelInspection, AdvancedModelParameters } from './model-profiles';
import {
  estimateModelMemory,
  estimateHostMemory,
  modelCgroupLimitMiB,
  placementSupport,
  verifiedMoe,
} from './model-memory';
export { parseLayerRanges, formatLayerRanges } from './model-memory';
export async function inspectPlacement(
  file: string
): Promise<ModelInspection & { identity: string }> {
  const m = await readSpeculativeMetadata(file),
    v = m.values,
    a = String(v['general.architecture']);
  const positive = (key: string) => {
    const n = Number(v[key]);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };
  const layers = positive(`${a}.block_count`),
    heads = positive(`${a}.attention.head_count`),
    embedding = positive(`${a}.embedding_length`);
  const full =
    a === 'qwen3next' && layers
      ? Math.floor(layers / (positive(`${a}.full_attention_interval`) ?? 4))
      : layers;
  const tensors = Object.entries(m.tensors).map(([name, t]) => ({
    name,
    bytes: t.bytes ?? 0,
    type: t.type,
    shape: t.shape,
    block: /^blk\.(\d+)\./.test(name) ? Number(name.split('.')[1]) : undefined,
    expert: /ffn_(?:gate|up|down|gate_up)_exps\.(?:weight|bias)$/.test(name),
  }));
  return {
    identity: m.identity,
    status: 'inspected',
    detectedFamily: 'auto',
    selectedFamily: 'auto',
    effectiveFamily: 'auto',
    template: 'unknown',
    reasoning: { thinkingToggle: false, efforts: [] },
    toolTemplate: false,
    architecture: a,
    modelName: String(v['general.name'] ?? ''),
    layers,
    experts: positive(`${a}.expert_count`),
    fileType: Number(v['general.file_type']),
    structure: {
      tensors,
      complete:
        Number(v['split.count'] ?? 1) === 1 &&
        tensors.length > 0 &&
        Object.values(m.tensors).every((t) => t.valid && t.bytes),
      totalBytes: tensors.reduce((n, t) => n + t.bytes, 0),
      kvHeads: positive(`${a}.attention.head_count_kv`) ?? heads,
      keyLength:
        positive(`${a}.attention.key_length`) ??
        (embedding && heads ? embedding / heads : undefined),
      valueLength:
        positive(`${a}.attention.value_length`) ??
        (embedding && heads ? embedding / heads : undefined),
      fullAttentionLayers: full,
      recurrentLayers: a === 'qwen3next' && layers && full !== undefined ? layers - full : 0,
    },
  };
}
export { cacheMode } from './config';
export function blockOverrides(p: GgufProfile, count: number): string | undefined {
  if (p.gpuBlockIds === undefined) return p.tensorOverride;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 4096 ||
    p.gpuBlockIds.some((n) => !Number.isInteger(n) || n < 0 || n >= count)
  )
    throw Error('GGUF:placement:Invalid GGUF block selection');
  if (p.tensorOverride)
    throw Error('GGUF:placement:Clear arbitrary tensor overrides before selecting blocks');
  const ids = [...new Set(p.gpuBlockIds)].sort((a, b) => a - b),
    selected = new Set(ids),
    cpu = Array.from({ length: count }, (_, n) => n).filter((n) => !selected.has(n));
  const rules: string[] = [];
  if (cpu.length) rules.push(`^blk[.](?:${cpu.join('|')})[.]=CPU`);
  if (ids.length)
    rules.push(
      `^blk[.](?:${ids.join('|')})[.]${effectiveCpuMoe(p) ? '(?!ffn_(?:gate|up|down|gate_up)_exps[.])' : ''}=CUDA0`
    );
  rules.push('^(?!blk[.]).*=CPU');
  return rules.join(',');
}
export async function placementPreview(p: GgufProfile, probe: RuntimeProbe) {
  const inspection = await inspectPlacement(p.model),
    memory = await sampleMemory(AbortSignal.timeout(2000));
  const gpu = memory.gpus.length === 1 ? memory.gpus[0] : undefined;
  // Never sum unrelated devices; this first port supports one unambiguous CUDA GPU.
  const available = gpu ? (gpu.total - gpu.used) / 1024 ** 2 : null;
  const total = gpu ? gpu.total / 1024 ** 2 : null;
  const mode = cacheMode(p);
  const parameters: AdvancedModelParameters = {
    mode: 'gpu-layers',
    gpuLayerIds: p.gpuBlockIds,
    moeAcceleration: mode === 'standard' ? 'disabled' : mode,
    expertCacheMiB: p.moeCacheMiB,
    cpuMoe: effectiveCpuMoe(p) ? 'all' : p.nCpuMoe !== undefined ? 'first' : 'none',
    cpuMoeLayers: p.nCpuMoe,
    loadMode: 'mmap',
  };
  const estimate = estimateModelMemory(
    inspection,
    parameters,
    p.gpuLayers,
    {
      contextWindow: p.context,
      kvCacheType: p.cacheK === 'q8_0' && p.cacheV === 'q8_0' ? 'q8_0' : 'f16',
      kvOffload: p.kvOffload,
    },
    available,
    total
  );
  let cgroup: number | null = null;
  try {
    const relative = /^0::(.*)$/m.exec(await readFile('/proc/self/cgroup', 'utf8'))?.[1];
    const raw = await readFile('/sys/fs/cgroup' + (relative ?? '') + '/memory.max', 'utf8');
    if (raw.trim() !== 'max') cgroup = Number(raw) / 1024 ** 2;
  } catch {
    /* Host policy still applies when no cgroup v2 limit is available. */
  }
  const policy = memory.ram ? modelCgroupLimitMiB(memory.ram.total / 1024 ** 2) : null;
  cgroup = cgroup === null ? policy : policy === null ? cgroup : Math.min(cgroup, policy);
  const host = estimateHostMemory(
    estimate,
    parameters,
    memory.ram ? (memory.ram.total - memory.ram.used) / 1024 ** 2 : null,
    cgroup
  );
  return {
    inspection,
    estimate,
    host,
    supported: placementSupport(inspection, {
      status: 'supported',
      flags: probe.flags,
      buffers: probe.gpuAvailable ? ['CUDA0'] : [],
    }),
    cacheSupported:
      verifiedMoe(inspection) &&
      probe.flags.includes('--moe-cache-mib') &&
      probe.version.includes('5047748') &&
      probe.gpuAvailable,
    sizes: [2048, 4096, 8192, 12288, 16384].filter(
      (n) => estimate.known && available !== null && n <= estimate.safeCacheMiB
    ),
    parameters,
  };
}
export async function resolvePlacement(p: GgufProfile, probe: RuntimeProbe): Promise<GgufProfile> {
  const mode = cacheMode(p);
  if (p.gpuBlockIds === undefined && mode === 'standard') return { ...p, moeCacheMiB: undefined };
  const view = await placementPreview(p, probe);
  assertPlacementIdentity(p, view.inspection.identity);
  if (p.gpuBlockIds !== undefined && !view.supported)
    throw Error('GGUF:placement:Complete GGUF tensors and CUDA override support required');
  if (
    mode !== 'standard' &&
    (!view.cacheSupported || p.gpuLayers === 0 || p.nCpuMoe !== undefined || p.context > 65536)
  )
    throw Error(
      'GGUF:placement:Cache requires a validated supported MoE layout, CUDA, all experts CPU-resident and context <= 64K'
    );
  if (
    (p.projector && p.visionEnabled !== false) ||
    (p.speculativeMode ?? 'off') !== 'off' ||
    p.draft
  )
    throw Error(
      'GGUF:placement:Placement memory estimates do not yet cover Vision/MTP/draft allocations; use Standard without selective placement'
    );
  if ((p.cacheK ?? 'f16') !== (p.cacheV ?? 'f16') || !['f16', 'q8_0'].includes(p.cacheK ?? 'f16'))
    throw Error('GGUF:placement:Preflight supports matching FP16 or Q8 K/V');
  if (!view.estimate.known || !view.estimate.fits || !view.host.fits)
    throw Error(
      'GGUF:placement:Insufficient measured RAM/VRAM or incomplete tensor metadata (donor reserves retained)'
    );
  if (mode === 'manual' && !view.sizes.includes(p.moeCacheMiB ?? 0))
    throw Error('GGUF:placement:Requested expert cache does not fit the safe budget');
  const size = mode === 'standard' ? undefined : view.estimate.cacheMiB;
  if (mode === 'automatic' && (!size || size < 2048))
    throw Error('GGUF:placement:No safe 2 GiB cache budget is available; choose Standard');
  return { ...p, moeCacheMiB: size, tensorOverride: blockOverrides(p, view.inspection.layers!) };
}
