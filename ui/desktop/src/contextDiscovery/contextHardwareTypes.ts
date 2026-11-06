export interface HardwareStats {
  ramUsedBytes: number;
  ramTotalBytes: number;
  vramUsedBytes: number | null;
  vramTotalBytes: number | null;
  vramAvailableBytes: number | null;
  gpuUtilization: number | null;
  available: boolean;
}

/** Direct observation for the one launcher-owned server, never inferred from a saved profile. */
export interface RuntimeContextEvidence {
  backend: 'llama-cpp';
  modelId: string;
  activeContextTokens: number;
  modelPath?: string;
  modelTrainContextTokens?: number;
  modelFileSizeBytes?: number;
  residentBytes?: number;
  deviceResidentBytes?: number;
  kvCacheType?: 'f16' | 'q8_0';
  kvOffload?: boolean;
}
