import type { MtpDiagnostics } from '../../shared/types';
/** Backend counters are cumulative for this server, never a per-response throughput. */
export function parseMtpMetrics(text: string): MtpDiagnostics | undefined {
  const read = (name: string) => {
    const raw = text.match(new RegExp(`^(?:llamacpp:)?${name}\\s+([0-9.eE+\\-]+)$`, 'm'))?.[1];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  const drafted = read('spec_decode_num_draft_tokens_total'), accepted = read('spec_decode_num_accepted_tokens_total');
  if (drafted === undefined || accepted === undefined || accepted > drafted) return undefined;
  return { drafted, accepted, ...(drafted > 0 ? { acceptanceRate: accepted / drafted } : {}), source: 'llama-server metrics', scope: 'server lifetime' };
}
