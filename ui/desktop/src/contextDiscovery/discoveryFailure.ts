// Local AI Desktop: Electron IPC preserves Error.message, not custom properties.
export interface DiscoveryFailureDetails {
  runId: string;
  stage: string;
  context?: number;
  kv?: string;
  reason: string;
  restoration: string;
  restoreError?: string;
  logPath?: string;
  receiptPath?: string;
}
export function safeDiscoveryError(error: unknown): string {
  return String(error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 8192);
}
export function parseDiscoveryFailure(error: unknown): DiscoveryFailureDetails | null {
  const text = String(error);
  const prefix = 'GGUF:discoveryFailed:';
  const start = text.indexOf(prefix);
  if (start < 0) return null;
  try {
    const data = JSON.parse(text.slice(start + prefix.length));
    if (!data || typeof data.reason !== 'string' || typeof data.stage !== 'string' || typeof data.restoration !== 'string') return null;
    return data as DiscoveryFailureDetails;
  } catch { return null; }
}
