// Presentation only: keep the discovery registry, formulas and exact token counts unchanged.
import type { ContextDiscoveryOption } from './contextEstimator';
export interface ContextChoice {
  tokens: number;
  kv?: 'f16' | 'q8_0';
  status?: 'verified' | 'saved' | 'stale';
}
export function contextChoices(
  hardLimit: number,
  options: ContextDiscoveryOption[],
  _previous: ContextDiscoveryOption[],
  selectedKv: 'f16' | 'q8_0' | 'custom' = 'f16'
): ContextChoice[] {
  const found = new Map<string, ContextChoice>();
  const latest = new Map<string, ContextDiscoveryOption>();
  for (const option of options) {
    // Keep both precisions in the registry, but expose only the currently
    // selected precision in the compact context grid.
    if (selectedKv === 'custom' || option.kvCacheType !== selectedKv) continue;
    const old = latest.get(option.kvCacheType);
    if (!old || Date.parse(option.discoveredAt) >= Date.parse(old.discoveredAt)) latest.set(option.kvCacheType, option);
  }
  for (const option of latest.values()) {
    if (
      !Number.isInteger(option.contextWindow) ||
      option.contextWindow < 512 ||
      option.contextWindow > hardLimit
    )
      continue;
    const key = `${option.contextWindow}:${option.kvCacheType}`;
    if (found.has(key)) continue;
    const stale =
      option.conditions === 'changed' ||
      option.validation === 'previous' ||
      option.validation === 'unavailable';
    found.set(key, {
      tokens: option.contextWindow,
      kv: option.kvCacheType,
      status: stale
        ? 'stale'
        : option.validation === 'confirmed' && !option.restored
          ? 'verified'
          : 'saved',
    });
  }
  const measuredValues = new Set([...found.values()].map((option) => option.tokens));
  const choices: ContextChoice[] = [
    ...[16384, 32768, 65536, 131072, 262144]
      .filter((n) => n <= hardLimit && !measuredValues.has(n))
      .map((tokens) => ({ tokens })),
    ...found.values(),
  ];
  return choices.sort((a, b) => a.tokens - b.tokens || (a.kv ?? '').localeCompare(b.kv ?? ''));
}
