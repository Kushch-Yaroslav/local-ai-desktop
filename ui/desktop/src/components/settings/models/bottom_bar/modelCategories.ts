import { useSyncExternalStore } from 'react';
// Conservative classification: protocol compatibility is not hosting metadata.
export type ModelCategory = 'local' | 'api' | 'all';
const listeners = new Set<() => void>();
let explicitCategory: ModelCategory | undefined;
export function readModelCategory() {
  return explicitCategory;
}
export function rememberModelCategory(value: ModelCategory | undefined) {
  explicitCategory = value;
  for (const listener of listeners) listener();
}
export function isLocalModel(provider: string, managedProviders: ReadonlySet<string>) {
  return provider === 'local' || managedProviders.has(provider);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useModelCategory() {
  return useSyncExternalStore(subscribe, readModelCategory);
}
