export interface MemoryReading {
  used: number;
  total: number;
}
export interface MemorySnapshot {
  ram: MemoryReading | null;
  gpus: Array<MemoryReading & { id: string; utilizationPercent: number | null }>;
}
