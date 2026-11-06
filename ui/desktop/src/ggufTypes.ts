// Local AI Desktop additions. External inference profiles are not agent runtimes.
export interface GgufProfile {
  id?: string;
  name: string;
  model: string;
  executable: string;
  backend?: 'external' | 'native';
  gpuLayers: number;
  context: number;
  providerId?: string;
  projector?: string;
  visionEnabled?: boolean;
  projectorCpu?: boolean;
  draft?: string;
  speculativeMode?: 'off' | 'mtp-embedded' | 'mtp-external' | 'draft-simple';
  draftTokens?: number;
  draftMinTokens?: number;
  draftGpuLayers?: number;
  cacheK?: string;
  cacheV?: string;
  kvOffload?: boolean;
  flashAttention?: 'auto' | 'on' | 'off';
  threads?: number;
  batch?: number;
  ubatch?: number;
  cpuMoe?: boolean;
  nCpuMoe?: number;
  tensorOverride?: string;
  moeCacheMiB?: number;
  moeCacheMode?: 'standard' | 'automatic' | 'manual';
  gpuBlockIds?: number[];
  placementIdentity?: string;
  jinja?: boolean;
  chatTemplate?: string;
}
export interface RuntimeProbe {
  executable: string;
  version: string;
  flags: string[];
  cacheTypes: string[];
  devices: string;
  gpuAvailable: boolean;
  apiKeyEnvironment: boolean;
  speculativeModes: string[];
  diagnosis: 'gpuVisible' | 'devicesInaccessible' | 'backendUnsupported';
}
export type RuntimePhase = 'idle' | 'validating' | 'starting' | 'ready' | 'stopping' | 'failed';
export interface RuntimeState {
  phase: RuntimePhase;
  profileId?: string;
  error?: string;
  args?: string[];
  logPath?: string;
}
export interface ProfileEntry {
  profile: GgufProfile;
  available: boolean;
  error?: string;
}
export interface GgufEndpoint {
  url: string;
  key: string;
  logPath?: string;
  args?: string[];
}
export interface GgufDiscoveryProgress {
  busy: boolean;
  profileId?: string;
  stage: string;
  probeCount: number;
  currentCandidate?: { context: number; kv: 'f16' | 'q8_0'; phase: 'base' | 'search' | 'final' };
  error?: string;
}
export interface GgufDiscoveryCatalog {
  modelId: string;
  hardLimit: number;
  identityKey: string;
  selectedContext: number;
  selectedKv: 'f16' | 'q8_0' | 'custom';
  supportedKv: Array<'f16' | 'q8_0'>;
  q8UnavailableReason?: string;
  options: import('./contextDiscovery/contextEstimator').ContextDiscoveryOption[];
  previous: import('./contextDiscovery/contextEstimator').ContextDiscoveryOption[];
}
export type GgufDiscoveryResult = import('./contextDiscovery/contextEstimator').ContextDiscoveryResult;
