// Local AI Desktop: mirror the configuration advertised by Goose ACP.
import { useSyncExternalStore } from 'react';
import type { GooseMode } from '../types/session';
import type { ThinkingEffort } from '../types/providers';
interface Configuration { budget?: number; mode?: GooseMode; effort?: ThinkingEffort; efforts?: ThinkingEffort[] }
const configurations = new Map<string, Configuration>();
const listeners = new Set<() => void>();
export function rememberSessionConfiguration(id: string, response: unknown) {
  if (!response) return;
  const data = response as { modes?: { currentModeId?: string }; configOptions?: Array<{ id: string; currentValue?: string; options?: Array<{ value?: string }> }> };
  const previous = configurations.get(id) ?? {};
  const next = { ...previous };
  const mode = data.modes?.currentModeId ?? data.configOptions?.find((option) => option.id === 'mode')?.currentValue;
  if (mode && ['auto', 'approve', 'smart_approve', 'chat'].includes(mode)) next.mode = mode as GooseMode;
  const effort = data.configOptions?.find((option) => option.id === 'thinking_effort');
  if (effort) {
    const valid = ['off', 'low', 'medium', 'high', 'max'];
    if (effort.options) next.efforts = effort.options.flatMap((option) => option.value && valid.includes(option.value) ? [option.value as ThinkingEffort] : []);
    if (effort.currentValue && valid.includes(effort.currentValue)) next.effort = effort.currentValue as ThinkingEffort;
  }
  const budget = data.configOptions?.find(option => option.id === 'thinking_budget');
  if (budget?.currentValue !== undefined && [-1,128,512,2048].includes(Number(budget.currentValue))) next.budget = Number(budget.currentValue);
  configurations.set(id, next);
  for (const listener of listeners) listener();
}
export function getSessionConfiguration(id: string) { return configurations.get(id); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useSessionConfiguration(id: string) {
  return useSyncExternalStore(subscribe, () => configurations.get(id));
}
