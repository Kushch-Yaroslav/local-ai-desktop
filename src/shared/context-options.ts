import type { ContextDiscoveryOption } from './context-estimator';
import type { LlamaKvCacheType } from './types';

export const defaultLlamaKv = { llamaKvCacheType: 'f16' as const, llamaKvOffload: true };

export type ContextChoice = {
  contextWindow: number;
  kvCacheType: LlamaKvCacheType;
  kvOffload: boolean;
  label: string;
  status?: 'unevaluated' | 'fit' | 'maximum' | 'above';
  explanation?: string;
  warning?: string;
};

export const contextChoiceId = (option: Pick<ContextChoice, 'contextWindow' | 'kvCacheType' | 'kvOffload'>) =>
  `${option.contextWindow}:${option.kvCacheType}:${option.kvOffload ? 'gpu' : 'ram'}`;

export const cacheModeLabel = (type: LlamaKvCacheType) => type === 'f16' ? 'FP16' : 'Q8';

/** Hardware evidence annotates/adds choices; it never filters model capability presets. */
export function buildContextChoices(
  modelId: string,
  normalPresets: readonly number[],
  hardLimit: number,
  discovered: readonly ContextDiscoveryOption[],
  normalCacheType: LlamaKvCacheType = 'f16',
  supportedKvTypes: readonly LlamaKvCacheType[] = ['f16', 'q8_0'],
): ContextChoice[] {
  const limit = Math.min(hardLimit, 262144);
  const catalog = discovered.filter(option => option.modelId === modelId && option.contextWindow > 0 && option.contextWindow <= limit && supportedKvTypes.includes(option.kvCacheType));
  const options: ContextChoice[] = supportedKvTypes.flatMap(kvCacheType =>
    [...new Set([16384,32768,65536,131072,262144, ...catalog.filter(option => option.kvCacheType === kvCacheType).map(option => option.contextWindow)])]
      .filter(contextWindow => contextWindow > 0 && contextWindow <= limit).map(contextWindow => ({
        contextWindow, kvCacheType, kvOffload: true, label: `${contextWindow / 1024}K (${cacheModeLabel(kvCacheType)})`,
      })));

  void normalCacheType; void normalPresets;
  for (const candidate of catalog) {
    if (candidate.modelId !== modelId || candidate.contextWindow > limit || !supportedKvTypes.includes(candidate.kvCacheType)) continue;
    const existing = options.find((option) => contextChoiceId(option) === contextChoiceId(candidate));
    const label = `${candidate.contextWindow / 1024}K (${cacheModeLabel(candidate.kvCacheType)})${candidate.kvOffload ? '' : ' · KV RAM'}`;
    if (existing) existing.label = label;
    else options.push({ ...candidate, label });
  }
  return options.map(option => describeContextChoice(option, modelId, catalog)).sort((left, right) => left.contextWindow - right.contextWindow || left.kvCacheType.localeCompare(right.kvCacheType));
}

export function describeContextChoice(choice: ContextChoice, modelId: string, discovered: readonly ContextDiscoveryOption[]): ContextChoice {
  const measurement = discovered.filter(option => option.modelId === modelId && option.kvCacheType === choice.kvCacheType && option.kvOffload === true && choice.kvOffload === true)
    .sort((a,b) => b.discoveredAt.localeCompare(a.discoveredAt))[0];
  if (!measurement) return { ...choice, status: 'unevaluated', warning: undefined, explanation: 'Не оценено для этой конфигурации' };
  if (choice.contextWindow > measurement.contextWindow) return { ...choice, status: 'above', explanation: 'Выше измеренного GPU-fit предела: требуется больше памяти; возможна ошибка загрузки', warning: measurement.conditions === 'changed' ? measurement.conditionWarning ?? 'Рекомендуется повторная проверка условий GPU/RAM' : undefined };
  if (measurement.conditions !== 'comparable') return { ...choice, status: 'unevaluated', explanation: measurement.conditions === 'changed' ? 'Рекомендуется повторная проверка' : 'По предыдущему измерению; текущая телеметрия не подтверждена', warning: measurement.conditions === 'changed' ? measurement.conditionWarning ?? 'Условия GPU/RAM изменились' : undefined };
  return { ...choice, status: choice.contextWindow === measurement.contextWindow ? 'maximum' : 'fit', warning: undefined, explanation: measurement.restored ? 'По предыдущему измерению; текущие условия сопоставимы' : choice.contextWindow === measurement.contextWindow ? 'Точный найденный GPU-fit максимум' : 'В проверенном GPU-fit диапазоне при сопоставимых условиях' };
}

export function normalContextPatch(contextWindow: number) {
  return { contextWindow, ...defaultLlamaKv };
}

export function normalContextForModel(contextWindow: number, presets: readonly number[]): number {
  const sorted = [...presets].sort((left, right) => left - right);
  return sorted.filter((preset) => preset <= contextWindow).at(-1) ?? sorted[0] ?? contextWindow;
}

export function resolveLlamaKvSelection(
  current: { llamaKvCacheType?: LlamaKvCacheType; llamaKvOffload?: boolean },
  patch: { contextWindow?: number; llamaKvCacheType?: LlamaKvCacheType; llamaKvOffload?: boolean },
  modelChanged: boolean,
  normalKv: { llamaKvCacheType: LlamaKvCacheType; llamaKvOffload: boolean } = defaultLlamaKv,
) {
  return {
    llamaKvCacheType: patch.llamaKvCacheType ?? (modelChanged ? normalKv.llamaKvCacheType : current.llamaKvCacheType ?? normalKv.llamaKvCacheType),
    llamaKvOffload: patch.llamaKvOffload ?? (modelChanged ? normalKv.llamaKvOffload : current.llamaKvOffload ?? normalKv.llamaKvOffload),
  };
}
