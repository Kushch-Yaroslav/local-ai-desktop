import type { GgufProfile } from '../ggufTypes';

/** The cache is an independent launch feature; cache placement is derived, not persisted. */
export function cacheMode(profile: GgufProfile): NonNullable<GgufProfile['moeCacheMode']> {
  return profile.moeCacheMode ?? (profile.moeCacheMiB ? 'manual' : 'standard');
}

export function usesMoeExpertCache(profile: GgufProfile): boolean {
  return cacheMode(profile) !== 'standard';
}

/** Explicit standalone CPU placement remains effective, while cache mode requires it temporarily. */
export function effectiveCpuMoe(profile: GgufProfile): boolean {
  return profile.cpuMoe === true || usesMoeExpertCache(profile);
}
