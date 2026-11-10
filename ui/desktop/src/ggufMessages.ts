// Local AI Desktop messages use the existing react-intl catalogs.
import { defineMessages } from './i18n';
import type { IntlShape } from 'react-intl';
export const ggufMessages = defineMessages({
  specPending: { id: 'gguf.specPending', defaultMessage: 'MTP changes are not saved.' },
  runtimeContext: { id: 'gguf.runtimeContext', defaultMessage: 'Runtime override: {context} tokens. Change it in session Context controls.' },
  specAcceptance: { id: 'gguf.specAcceptance', defaultMessage: 'Draft accepted/proposed' },
  visionPair: { id: 'gguf.visionPair', defaultMessage: 'The projector architecture or projection dimension is incompatible with this Qwen model.' },
  placementIdentity: {
    id: 'gguf.placementIdentity',
    defaultMessage:
      'The GGUF identity for this placement is not confirmed. Review the inspected model and confirm it in Advanced settings.',
  },
  specSaved: { id: 'gguf.specSaved', defaultMessage: 'Saved MTP' },
  specActive: { id: 'gguf.specActive', defaultMessage: 'Active CLI mode' },
  reloadRequired: { id: 'gguf.reloadRequired', defaultMessage: 'Reload required to apply changes.' },
  projectorCpu: { id: 'gguf.projectorCpu', defaultMessage: 'Run vision projector on CPU' },
  deviceMemory: { id: 'gguf.deviceMemory', defaultMessage: 'GPU memory allocation failed. Lower context/GPU offload or run the vision projector on CPU. For MTP, try one slot and smaller target/draft microbatches before rerunning discovery.' },
  specDraftGpuEmbedded: {
    id: 'gguf.specDraftGpuEmbedded',
    defaultMessage:
      'Draft GPU layers apply only to an external draft. Clear this value for embedded MTP.',
  },

  compactControls: { id: 'gguf.compactControls', defaultMessage: 'Model controls: {name}' },
  modelSettings: { id: 'gguf.modelSettings', defaultMessage: 'Model settings' },
  specEnable: { id: 'gguf.specEnable', defaultMessage: 'Enable speculative decoding' },
  specMode: { id: 'gguf.specMode', defaultMessage: 'Speculative mode' },
  specEmbedded: { id: 'gguf.specEmbedded', defaultMessage: 'Embedded Qwen MTP head' },
  specExternal: {
    id: 'gguf.specExternal',
    defaultMessage: 'External architecture-specific MTP GGUF',
  },
  specSimple: { id: 'gguf.specSimple', defaultMessage: 'Classic compatible draft model' },
  draftPath: { id: 'gguf.draftPath', defaultMessage: 'Draft GGUF absolute path' },
  draftTokens: { id: 'gguf.draftTokens', defaultMessage: 'Maximum draft tokens (1–16)' },
  draftMinTokens: { id: 'gguf.draftMinTokens', defaultMessage: 'Minimum draft tokens' },
  draftGpuLayers: { id: 'gguf.draftGpuLayers', defaultMessage: 'Draft GPU layers' },
  specTradeoff: {
    id: 'gguf.specTradeoff',
    defaultMessage:
      'Speculation uses extra memory and compute. Acceptance and throughput depend on the model pair and hardware; successful loading does not prove acceleration.',
  },
  specTrial: {
    id: 'gguf.specTrial',
    defaultMessage:
      'Metadata compatibility is preliminary. Backend initialization and generation must still succeed. Disabled settings remain saved but are not passed to the runtime.',
  },
  specValidate: {
    id: 'gguf.specValidate',
    defaultMessage: 'Validate MTP compatibility without loading',
  },
  specMetadata: {
    id: 'gguf.specMetadata',
    defaultMessage:
      'Cannot certify GGUF metadata/tensor layout. Check file integrity, supported quantization and complete artifacts.',
  },
  specHead: {
    id: 'gguf.specHead',
    defaultMessage:
      'A complete compatible single MTP head was not found. Select compatible MTP weights.',
  },
  specDimensions: {
    id: 'gguf.specDimensions',
    defaultMessage:
      'Target/draft dimensions or context are incompatible. Lower context or select a matching model pair.',
  },
  specArchitecture: {
    id: 'gguf.specArchitecture',
    defaultMessage:
      'This target/draft architecture or graph layout is not validated. A generic draft cannot replace architecture-specific MTP weights.',
  },
  specTokenizer: {
    id: 'gguf.specTokenizer',
    defaultMessage:
      'Target and draft tokenizer metadata do not match. Select a tokenizer-compatible pair.',
  },
  specBackend: {
    id: 'gguf.specBackend',
    defaultMessage:
      'The selected executable cannot safely use this mode. The audited d1d3c33 external-draft branch loads the target path; use embedded MTP or a verified patched runtime.',
  },
  specDraftRequired: {
    id: 'gguf.specDraftRequired',
    defaultMessage: 'This mode requires an existing compatible draft GGUF.',
  },
  specDraftMode: {
    id: 'gguf.specDraftMode',
    defaultMessage:
      'Select an explicit speculative mode, or disable it, before saving a draft path.',
  },
  specEmbeddedPath: {
    id: 'gguf.specEmbeddedPath',
    defaultMessage:
      'Embedded MTP uses the target weights. Clear the external draft path to enable this mode.',
  },
  specSameFile: {
    id: 'gguf.specSameFile',
    defaultMessage:
      'An external draft must be a distinct file. Use embedded MTP for a head stored in the target GGUF.',
  },
  specCacheConflict: {
    id: 'gguf.specCacheConflict',
    defaultMessage:
      'Speculation cannot be combined with the unverified patched expert-cache configuration. Disable one of them.',
  },

  nativeDuplicatePath: {
    id: 'gguf.nativeDuplicatePath',
    defaultMessage:
      'Native Goose settings are shared by model path. Edit the existing native profile or use an external profile.',
  },
  nativeGpuUnsupported: {
    id: 'gguf.nativeGpuUnsupported',
    defaultMessage:
      'This native build has no verified CUDA adapter. Use the external CUDA runtime or set GPU layers to 0.',
  },
  credentialUnsupported: {
    id: 'gguf.credentialUnsupported',
    defaultMessage:
      'This runtime does not advertise secure API-key environment support. Select a compatible llama-server.',
  },

  moeMetadata: {
    id: 'gguf.moeMetadata',
    defaultMessage: 'The GGUF metadata does not confirm MoE experts. Clear the MoE settings.',
  },
  quantizedCache: {
    id: 'gguf.quantizedCache',
    defaultMessage: 'Quantized V cache requires flash attention set to On.',
  },
  title: { id: 'gguf.title', defaultMessage: 'Advanced Local Inference' },
  description: {
    id: 'gguf.description',
    defaultMessage:
      'Manage existing GGUF files. Saving never loads weights. Select a profile in the chat model selector; the first request loads it.',
  },
  add: { id: 'gguf.add', defaultMessage: 'Add model' },
  edit: { id: 'gguf.edit', defaultMessage: 'Edit' },
  duplicate: { id: 'gguf.duplicate', defaultMessage: 'Duplicate' },
  delete: { id: 'gguf.delete', defaultMessage: 'Delete' },
  confirmDelete: {
    id: 'gguf.confirmDelete',
    defaultMessage: 'Delete profile “{name}”? External GGUF files will remain unchanged.',
  },
  save: { id: 'gguf.save', defaultMessage: 'Save profile' },
  validate: { id: 'gguf.validate', defaultMessage: 'Validate paths and runtime' },
  saved: { id: 'gguf.saved', defaultMessage: 'Profile saved. Model weights have not been loaded.' },
  valid: { id: 'gguf.valid', defaultMessage: 'Validation passed. No model was loaded.' },
  name: { id: 'gguf.name', defaultMessage: 'Profile name' },
  model: { id: 'gguf.model', defaultMessage: 'Main GGUF path' },
  projector: { id: 'gguf.projector', defaultMessage: 'Optional vision projector GGUF' },
  executable: { id: 'gguf.executable', defaultMessage: 'llama-server executable' },
  backend: { id: 'gguf.backend', defaultMessage: 'Inference backend' },
  external: { id: 'gguf.external', defaultMessage: 'Managed llama-server' },
  native: { id: 'gguf.native', defaultMessage: 'Native Goose inference' },
  browse: { id: 'gguf.browse', defaultMessage: 'Browse' },
  gpuLayers: { id: 'gguf.gpuLayers', defaultMessage: 'GPU Layers' },
  gpuLayersHelp: { id: 'gguf.gpuLayersHelp', defaultMessage: '0 = CPU · 999 = all available GPU layers' },
  context: { id: 'gguf.context', defaultMessage: 'Context tokens' },
  simple: { id: 'gguf.simple', defaultMessage: 'Simple mode' },
  advanced: { id: 'gguf.advanced', defaultMessage: 'Advanced mode' },
  available: { id: 'gguf.available', defaultMessage: 'Available' },
  missing: { id: 'gguf.missing', defaultMessage: 'Missing files' },
  idle: { id: 'gguf.idle', defaultMessage: 'Unloaded' },
  validating: { id: 'gguf.validating', defaultMessage: 'Validating' },
  starting: { id: 'gguf.starting', defaultMessage: 'Loading model…' },
  ready: { id: 'gguf.ready', defaultMessage: 'Running' },
  stopping: { id: 'gguf.stopping', defaultMessage: 'Unloading…' },
  failed: { id: 'gguf.failed', defaultMessage: 'Failed' },
  load: { id: 'gguf.load', defaultMessage: 'Load model' },
  unload: { id: 'gguf.unload', defaultMessage: 'Unload model' },
  cancelLoad: { id: 'gguf.cancelLoad', defaultMessage: 'Cancel loading' },
  stopHelp: {
    id: 'gguf.stopHelp',
    defaultMessage:
      'Stop in chat cancels generation. Unload stops the owned inference server. Closing the app unloads it. No automatic loading on app launch.',
  },
  select: { id: 'gguf.select', defaultMessage: 'Select for chat' },
  runtime: { id: 'gguf.runtime', defaultMessage: 'Runtime and diagnostics' },
  memory: { id: 'gguf.memory', defaultMessage: 'Context, KV cache and memory' },
  cpu: { id: 'gguf.cpu', defaultMessage: 'CPU threads and batch' },
  vision: { id: 'gguf.vision', defaultMessage: 'Vision / projector' },
  speculation: { id: 'gguf.speculation', defaultMessage: 'Generation Acceleration' },
  draft: {
    id: 'gguf.draft',
    defaultMessage:
      'Draft/MTP requires matching architecture, tokenizer, dimensions and backend validation. Not enabled in this version.',
  },
  tools: { id: 'gguf.tools', defaultMessage: 'Tool calling / templates' },
  experimental: {
    id: 'gguf.experimental',
    defaultMessage: 'Experimental MoE placement — no acceleration claim',
  },
  probe: { id: 'gguf.probe', defaultMessage: 'Probe selected executable' },
  cacheK: { id: 'gguf.cacheK', defaultMessage: 'KV cache K' },
  cacheV: { id: 'gguf.cacheV', defaultMessage: 'KV cache V' },
  flashAttention: { id: 'gguf.flashAttention', defaultMessage: 'Flash attention' },
  parallel: { id: 'gguf.parallel', defaultMessage: 'Parallel chat slots (1 uses less MTP memory)' },
  draftCacheK: { id: 'gguf.draftCacheK', defaultMessage: 'MTP / draft KV K (default FP16)' },
  draftCacheV: { id: 'gguf.draftCacheV', defaultMessage: 'MTP / draft KV V (default FP16)' },
  draftUbatch: { id: 'gguf.draftUbatch', defaultMessage: 'MTP / draft microbatch' },
  mtpMemoryPreset: { id: 'gguf.mtpMemoryPreset', defaultMessage: 'Prepare MTP preset: 1 slot, 1 draft token, batch 512, microbatches 128 — review and save' },
  threads: { id: 'gguf.threads', defaultMessage: 'CPU threads' },
  batch: { id: 'gguf.batch', defaultMessage: 'Batch size' },
  ubatch: { id: 'gguf.ubatch', defaultMessage: 'Microbatch size' },
  cpuMoe: { id: 'gguf.cpuMoe', defaultMessage: 'Standalone CPU MoE placement' },
  cpuMoeHelp: {
    id: 'gguf.cpuMoeHelp',
    defaultMessage:
      'This is an independent profile choice. Expert cache temporarily places experts on CPU while enabled; it does not change this saved choice.',
  },
  nCpuMoe: { id: 'gguf.nCpuMoe', defaultMessage: 'First N MoE layers on CPU' },
  tensorOverride: {
    id: 'gguf.tensorOverride',
    defaultMessage: 'Tensor placement overrides (pattern=buffer)',
  },
  moeCacheMiB: {
    id: 'gguf.moeCacheMiB',
    defaultMessage: 'Patched expert cache, MiB (unbenchmarked)',
  },
  jinja: { id: 'gguf.jinja', defaultMessage: 'Enable Jinja tool template' },
  chatTemplate: { id: 'gguf.chatTemplate', defaultMessage: 'Built-in chat template name' },
  default: { id: 'gguf.default', defaultMessage: 'Backend default' },
  auto: { id: 'gguf.auto', defaultMessage: 'Auto' },
  on: { id: 'gguf.on', defaultMessage: 'On' },
  off: { id: 'gguf.off', defaultMessage: 'Off' },
  unsupported: {
    id: 'gguf.unsupported',
    defaultMessage:
      'Unavailable for this selected backend. Clear this setting or choose a compatible runtime.',
  },
  gpuVisible: { id: 'gguf.gpuVisible', defaultMessage: 'GPU detected by the selected runtime' },
  devicesInaccessible: {
    id: 'gguf.devicesInaccessible',
    defaultMessage:
      'No GPU is visible to this executable. Check its CUDA libraries, device access and sandbox. CPU fallback: set GPU layers to 0.',
  },
  backendUnsupported: {
    id: 'gguf.backendUnsupported',
    defaultMessage:
      'This executable does not support device discovery. Select a CUDA runtime or use 0 GPU layers.',
  },
  absolutePath: { id: 'gguf.absolutePath', defaultMessage: 'An absolute file path is required.' },
  missingFile: {
    id: 'gguf.missingFile',
    defaultMessage:
      'A configured file is missing or inaccessible. Reconnect the disk or edit its path.',
  },
  probeFailed: {
    id: 'gguf.probeFailed',
    defaultMessage: 'The selected executable could not be verified.',
  },
  unsupportedSetting: {
    id: 'gguf.unsupportedSetting',
    defaultMessage: 'Unsupported profile setting.',
  },
  nameRequired: {
    id: 'gguf.nameRequired',
    defaultMessage: 'Enter a profile name (up to 120 characters).',
  },
  invalidValue: { id: 'gguf.invalidValue', defaultMessage: 'Invalid configuration value.' },
  conflictingMoe: {
    id: 'gguf.conflictingMoe',
    defaultMessage: 'Choose all CPU experts or first N layers, not both.',
  },
  draftCompatibility: {
    id: 'gguf.draftCompatibility',
    defaultMessage:
      'Draft/MTP compatibility has not been verified; remove the draft setting to continue.',
  },
  cacheRequirements: {
    id: 'gguf.cacheRequirements',
    defaultMessage:
      'Expert cache requires GPU offload, all CPU experts, and no arbitrary tensor overrides.',
  },
  notGguf: { id: 'gguf.notGguf', defaultMessage: 'The selected file is not GGUF.' },
  nativeUnsupported: {
    id: 'gguf.nativeUnsupported',
    defaultMessage:
      'This setting is not supported by the native profile adapter. Use native Goose settings or an external runtime.',
  },
  unsupportedFlag: {
    id: 'gguf.unsupportedFlag',
    defaultMessage:
      'The selected executable does not advertise a required flag. Clear the setting or select another runtime.',
  },
  profileMissing: {
    id: 'gguf.profileMissing',
    defaultMessage: 'Profile no longer exists. Select another model.',
  },
  portConflict: {
    id: 'gguf.portConflict',
    defaultMessage: 'The profile endpoint port is occupied. No other process was terminated.',
  },
  runtimeBusy: {
    id: 'gguf.runtimeBusy',
    defaultMessage:
      'Another model is loading or serving a request. Cancel or finish it before switching.',
  },
  processExit: {
    id: 'gguf.processExit',
    defaultMessage: 'llama-server exited. See the runtime log.',
  },
  timeout: {
    id: 'gguf.timeout',
    defaultMessage: 'Model readiness timed out. See the runtime log.',
  },
  requestTooLarge: {
    id: 'gguf.requestTooLarge',
    defaultMessage: 'The local request is too large.',
  },
  error: { id: 'gguf.error', defaultMessage: 'Local runtime error' },
  language: { id: 'gguf.language', defaultMessage: 'Interface language' },
  system: { id: 'gguf.system', defaultMessage: 'System default' },
  moeNote: {
    id: 'gguf.moeNote',
    defaultMessage:
      'GPU Layers controls ordinary layers; CPU MoE controls expert weights. The GPU cache keeps selected CPU-resident experts in VRAM; speed depends on the model and workload.',
  },
  nativeNote: {
    id: 'gguf.nativeNote',
    defaultMessage:
      'Native Goose manages loading and eviction. External runtime controls do not apply.',
  },
  advancedCard: {
    id: 'gguf.advancedCard',
    defaultMessage: 'Use saved GGUF profiles with native Goose or a managed llama-server.',
  },
});
export function formatGgufError(intl: IntlShape, error: unknown) {
  const raw = String(error);
  const match = raw.match(/GGUF:([a-zA-Z]+)(?::(.*))?/s);
  const code = match?.[1] as keyof typeof ggufMessages;
  return `${intl.formatMessage(ggufMessages[code] ?? ggufMessages.error)}${match?.[2] ? ' — ' + match[2] : match ? '' : ' — ' + raw}`;
}
