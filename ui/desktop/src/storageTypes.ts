// Local AI Desktop: public renderer contract; filesystem operations stay in main.
export interface StorageLayout {
  dataRoot: string;
  bulkRoot: string;
  configRoot: string;
  cacheRoot: string;
  logsRoot: string;
  artifactsRoot: string;
  backupsRoot: string;
  electronRoot: string;
  backendRoot: string;
}
export interface StorageChoice {
  useDefault: boolean;
  customPath?: string;
}
export interface StorageProgress {
  phase: string;
  completed: number;
  total: number;
  error?: string;
}
export interface StorageStatus {
  useDefault: boolean;
  customPath: string;
  defaultPath: string;
  layout: StorageLayout;
  freeBytes?: number;
  filesystem?: string;
  split: boolean;
  busy: boolean;
  cleanupAvailable: boolean;
  recoveryAvailable: boolean;
}
export interface StoragePreview {
  choice: StorageChoice;
  layout: StorageLayout;
  filesystem: string;
  split: boolean;
  requiredBytes: number;
  freeBytes: number;
  unchanged: boolean;
}
