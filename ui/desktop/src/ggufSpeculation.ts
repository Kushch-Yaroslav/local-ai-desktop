// Local AI Desktop: strict selected-runtime and target/draft checks, not an agent implementation.
import { realpath } from 'node:fs/promises';
import type { GgufProfile, RuntimeProbe } from './ggufTypes';
import { readSpeculativeMetadata, type SpeculativeMetadata } from './ggufSpeculativeMetadata';
function fail(code: string, detail = ''): never {
  throw Error(`GGUF:${code}:${detail}`);
}
export function speculationModes(help: string, version: string) {
  const block = /(?:^|\s)--spec-type[ \t]+([\s\S]*?)(?=\s--[a-z]|\n\S|$)/.exec(help)?.[1] ?? '';
  const modes: string[] = [];
  if (/\bdraft-mtp\b/.test(block)) modes.push('mtp-embedded', 'mtp-external');
  if (/\bdraft-simple\b/.test(block)) modes.push('draft-simple');
  // Audited d1d3c33 common/speculative.cpp loads params.model.path in its external-draft branch.
  if (/\bd1d3c33[0-9a-f]*\b/i.test(version)) return modes.filter((mode) => mode === 'mtp-embedded');
  return modes;
}
function architecture(meta: SpeculativeMetadata) {
  return String(meta.values['general.architecture'] ?? '');
}
function num(meta: SpeculativeMetadata, key: string) {
  return Number(meta.values[`${architecture(meta)}.${key}`] ?? 0);
}
function validTensor(meta: SpeculativeMetadata, name: string, shape?: number[]) {
  const t = meta.tensors[name];
  return (
    !!t?.valid &&
    (!shape || (t.shape.length === shape.length && t.shape.every((v, i) => v === shape[i])))
  );
}
function mtpHead(meta: SpeculativeMetadata, embedding: number) {
  if (num(meta, 'nextn_predict_layers') !== 1) fail('specHead');
  const block = num(meta, 'block_count') - 1,
    prefix = `blk.${block}.nextn.`;
  if (
    !Number.isInteger(block) ||
    block < 0 ||
    !validTensor(meta, prefix + 'eh_proj.weight', [embedding * 2, embedding]) ||
    !validTensor(meta, prefix + 'enorm.weight', [embedding]) ||
    !validTensor(meta, prefix + 'hnorm.weight', [embedding])
  )
    fail('specHead');
}
export function validateSpeculativePair(
  profile: GgufProfile,
  target: SpeculativeMetadata,
  draft?: SpeculativeMetadata
) {
  const mode = profile.speculativeMode ?? 'off';
  if (mode === 'off') return;
  const arch = architecture(target),
    embedding = num(target, 'embedding_length');
  if (
    !Number.isSafeInteger(embedding) ||
    embedding <= 0 ||
    num(target, 'block_count') <= num(target, 'nextn_predict_layers') ||
    !validTensor(target, 'blk.0.attn_norm.weight') ||
    num(target, 'context_length') < profile.context
  )
    fail('specDimensions');
  if (mode === 'mtp-embedded') {
    if (!['qwen35', 'qwen35moe'].includes(arch)) fail('specArchitecture', arch);
    if (!validTensor(target, 'blk.0.attn_norm.weight')) fail('specHead');
    mtpHead(target, embedding);
    return;
  }
  if (!draft) fail('specDraftRequired');
  if (architecture(draft) !== arch) fail('specArchitecture');
  if (num(draft, 'context_length') < profile.context) fail('specDimensions');
  const output = num(draft, 'embedding_length_out') || num(draft, 'embedding_length');
  if (mode === 'mtp-external') {
    if (!['qwen35', 'qwen35moe', 'qwen3next'].includes(arch)) fail('specArchitecture', arch);
    if (output !== embedding || num(draft, 'embedding_length') !== embedding)
      fail('specDimensions');
    mtpHead(draft, embedding);
  } else if (mode === 'draft-simple') {
    if (
      !['llama', 'qwen2', 'qwen3'].includes(arch) ||
      num(draft, 'nextn_predict_layers') ||
      !validTensor(draft, 'blk.0.attn_norm.weight')
    )
      fail('specArchitecture', arch);
  } else fail('invalidValue', 'speculativeMode');
  // Both vocabulary contents and token policies must match. No tokenizer text is retained.
  for (const key of ['tokenizer.ggml.model', 'tokenizer.ggml.tokens'])
    if (!target.tokenizer[key] || !draft.tokenizer[key]) fail('specTokenizer');
  const keys = new Set([...Object.keys(target.tokenizer), ...Object.keys(draft.tokenizer)]);
  for (const key of keys)
    if (target.tokenizer[key] !== draft.tokenizer[key]) fail('specTokenizer', key);
}
export async function validateSpeculation(profile: GgufProfile, probe: RuntimeProbe) {
  const mode = profile.speculativeMode ?? 'off';
  if (!['off', 'mtp-embedded', 'mtp-external', 'draft-simple'].includes(mode))
    fail('invalidValue', 'speculativeMode');
  for (const [key, min, max] of [
    ['draftTokens', 1, 16],
    ['draftMinTokens', 0, 16],
    ['draftGpuLayers', 0, 999],
  ] as const) {
    const v = profile[key];
    if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) fail('invalidValue', key);
  }
  if (profile.draftMinTokens !== undefined && profile.draftMinTokens > (profile.draftTokens ?? 2))
    fail('invalidValue', 'draftMinTokens');
  if (mode === 'off') return; // A disabled draft path can remain saved; it never becomes a CLI argument.
  if (profile.backend === 'native') fail('nativeUnsupported', 'speculation');
  if (!probe.speculativeModes.includes(mode)) fail('specBackend', mode);
  for (const flag of ['--spec-type', '--spec-draft-n-max'])
    if (!probe.flags.includes(flag)) fail('unsupportedFlag', flag);
  if (profile.draftMinTokens !== undefined && !probe.flags.includes('--spec-draft-n-min'))
    fail('unsupportedFlag', '--spec-draft-n-min');
  if (mode === 'mtp-embedded' && profile.draftGpuLayers !== undefined) fail('specDraftGpuEmbedded');
  if (mode !== 'mtp-embedded' && (profile.draftGpuLayers ?? 0) > 0 && !probe.gpuAvailable)
    fail(probe.diagnosis);
  if (mode === 'mtp-embedded' && profile.draft) fail('specEmbeddedPath');
  if (profile.moeCacheMiB) fail('specCacheConflict');
  const target = await readSpeculativeMetadata(profile.model);
  let draft: SpeculativeMetadata | undefined;
  if (mode !== 'mtp-embedded') {
    if (!profile.draft) fail('specDraftRequired');
    if (!probe.flags.includes('--spec-draft-model')) fail('unsupportedFlag', '--spec-draft-model');
    if (profile.draftGpuLayers !== undefined && !probe.flags.includes('--gpu-layers-draft'))
      fail('unsupportedFlag', '--gpu-layers-draft');
    if (
      (await realpath(profile.model)) ===
      (await realpath(profile.draft).catch(() => fail('missingFile', profile.draft)))
    )
      fail('specSameFile');
    draft = await readSpeculativeMetadata(profile.draft);
  }
  validateSpeculativePair(profile, target, draft);
}
export function speculativeArguments(profile: GgufProfile): string[] {
  const mode = profile.speculativeMode ?? 'off';
  if (mode === 'off') return [];
  const args = [
    '--spec-type',
    mode === 'draft-simple' ? 'draft-simple' : 'draft-mtp',
    '--spec-draft-n-max',
    String(profile.draftTokens ?? 2),
  ];
  if (profile.draftMinTokens !== undefined)
    args.push('--spec-draft-n-min', String(profile.draftMinTokens));
  if (mode !== 'mtp-embedded') {
    args.push('--spec-draft-model', profile.draft!);
    if (profile.draftGpuLayers !== undefined)
      args.push('--gpu-layers-draft', String(profile.draftGpuLayers));
  }
  return args;
}
