import type { GgufProfile } from '../ggufTypes';
import { usesMoeExpertCache } from './config';

/** A selective placement or expert-cache profile is bound to the inspected GGUF identity. */
export function requiresPlacementIdentity(profile: GgufProfile): boolean {
  return profile.gpuBlockIds !== undefined || usesMoeExpertCache(profile);
}

export function placementIdentityMatches(
  profile: GgufProfile,
  inspectedIdentity: string
): boolean {
  return !requiresPlacementIdentity(profile) || profile.placementIdentity === inspectedIdentity;
}

export function needsPlacementIdentityConfirmation(
  profile: GgufProfile,
  inspectedIdentity: string
): boolean {
  return requiresPlacementIdentity(profile) && !placementIdentityMatches(profile, inspectedIdentity);
}

export function assertPlacementIdentity(profile: GgufProfile, inspectedIdentity: string): void {
  if (needsPlacementIdentityConfirmation(profile, inspectedIdentity))
    throw Error('GGUF:placementIdentity:');
}
