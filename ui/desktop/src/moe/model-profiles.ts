// Adapted from Local AI Desktop v0.3.2.0; type boundary only.
type ReasoningEffort = string;
type ReasoningCapability = { thinkingToggle: boolean; efforts: string[] };
export const modelFamilies = [
  'auto',
  'qwen',
  'gpt-oss',
  'gemma',
  'glm',
  'mistral',
  'llama',
  'custom',
] as const;
export type ModelFamily = (typeof modelFamilies)[number];
export interface ModelInspection {
  status: 'inspected' | 'unknown' | 'error';
  detectedFamily: ModelFamily;
  selectedFamily: ModelFamily;
  effectiveFamily: ModelFamily;
  modelName?: string;
  architecture?: string;
  template: 'harmony' | 'jinja' | 'unknown';
  quantization?: string;
  fileType?: number;
  trainedContext?: number;
  structure?: ModelStructure;
  layers?: number;
  experts?: number;
  activeExperts?: number;
  sizeLabel?: string;
  reasoning: ReasoningCapability;
  toolTemplate: boolean;
  reason?: string;
}
export interface AdvancedModelParameters {
  inheritPlacement?: boolean;
  gpuLayerIds?: number[];
  moeAcceleration?: 'disabled' | 'automatic' | 'manual';
  expertCacheMiB?: number;
  mode: 'automatic' | 'gpu-layers' | 'moe';
  cpuMoe?: 'none' | 'all' | 'first';
  cpuMoeLayers?: number;
  cpuFfnLayers?: number;
  threads?: number;
  threadsBatch?: number;
  batchSize?: number;
  ubatchSize?: number;
  flashAttention?: 'auto' | 'on' | 'off';
  loadMode?: 'auto' | 'mmap' | 'none' | 'dio';
  fitTargetMiB?: number;
  tensorOverrides?: Array<{ pattern: string; buffer: string }>;
}
export interface ModelProfileDefaults {
  thinkingEnabled?: boolean | null;
  reasoningEffort?: ReasoningEffort | null;
  contextWindow?: number;
  kvCacheType?: 'f16' | 'q8_0';
  kvOffload?: boolean;
}
export interface BackendFeatureProbe {
  status: 'supported' | 'error';
  path?: string;
  flags: string[];
  buffers?: string[];
  version?: string;
  reason?: string;
}

export interface ModelTensorLayout {
  name: string;
  bytes: number;
  block?: number;
  expert: boolean;
  type: number;
  shape?: number[];
}
export interface ModelStructure {
  tensors: ModelTensorLayout[];
  complete: boolean;
  totalBytes: number;
  kvHeads?: number;
  keyLength?: number;
  valueLength?: number;
  fullAttentionLayers?: number;
  recurrentLayers?: number;
}
export interface ModelMemoryEstimate {
  weightsMiB: number;
  cpuWeightsMiB: number;
  kvMiB: number;
  cpuKvMiB: number;
  recurrentMiB: number;
  computeMiB: number;
  reserveMiB: number;
  cacheMiB: number;
  availableMiB: number | null;
  totalMiB: number | null;
  requiredMiB: number;
  safeCacheMiB: number;
  fits: boolean;
  known: boolean;
  notes: string[];
}
export interface PlacementPreview {
  inspection: ModelInspection;
  features: BackendFeatureProbe;
  backendPath: string | null;
  availableMiB: number | null;
  totalMiB: number | null;
  availableRamMiB?: number;
  totalRamMiB?: number;
  modelCgroupMaxMiB?: number;
  reason?: string;
}
