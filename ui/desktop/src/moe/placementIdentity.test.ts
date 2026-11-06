import { describe, expect, it } from 'vitest';
import type { GgufProfile } from '../ggufTypes';
import {
  assertPlacementIdentity,
  needsPlacementIdentityConfirmation,
  placementIdentityMatches,
  requiresPlacementIdentity,
} from './placementIdentity';

const base = {
  name: 'profile',
  model: '/models/qwen.gguf',
  executable: '/runtime/llama-server',
  gpuLayers: 999,
  context: 8192,
  gpuBlockIds: [0, 1],
} satisfies GgufProfile;

describe('placement identity confirmation', () => {
  it('accepts an unchanged inspected GGUF identity', () => {
    const identity = '66306:469820:48727680704:1792445698964670500:1792438890007308200';
    expect(placementIdentityMatches({ ...base, placementIdentity: identity }, identity)).toBe(true);
    expect(needsPlacementIdentityConfirmation({ ...base, placementIdentity: identity }, identity)).toBe(
      false
    );
    expect(() => assertPlacementIdentity({ ...base, placementIdentity: identity }, identity)).not.toThrow();
  });

  it('requires a one-time explicit confirmation for legacy profiles without an identity', () => {
    expect(requiresPlacementIdentity(base)).toBe(true);
    expect(needsPlacementIdentityConfirmation(base, 'current-identity')).toBe(true);
    expect(() => assertPlacementIdentity(base, 'current-identity')).toThrow('GGUF:placementIdentity');
    expect(
      placementIdentityMatches({ ...base, placementIdentity: 'current-identity' }, 'current-identity')
    ).toBe(true);
  });

  it('does not accept a genuinely changed GGUF until its current identity is confirmed', () => {
    const oldIdentity = '66306:469820:48727680704:1792445698964670500:1792438890007308200';
    const changedIdentity = '66306:469820:48727680705:1792445698964670501:1792438890007308201';
    expect(needsPlacementIdentityConfirmation({ ...base, placementIdentity: oldIdentity }, changedIdentity)).toBe(
      true
    );
    expect(() => assertPlacementIdentity({ ...base, placementIdentity: oldIdentity }, changedIdentity)).toThrow(
      'GGUF:placementIdentity'
    );
    expect(
      needsPlacementIdentityConfirmation(
        { ...base, placementIdentity: changedIdentity },
        changedIdentity
      )
    ).toBe(false);
  });

  it('does not reuse GPT-OSS identity for a different Qwen profile', () => {
    const gptIdentity = 'gpt-oss-file';
    const qwenIdentity = 'qwen-file';
    const gptProfile = { ...base, id: 'gpt-oss', placementIdentity: gptIdentity };
    const qwenProfile = { ...base, id: 'qwen80b', placementIdentity: gptProfile.placementIdentity };
    expect(placementIdentityMatches(gptProfile, gptIdentity)).toBe(true);
    expect(needsPlacementIdentityConfirmation(qwenProfile, qwenIdentity)).toBe(true);
    expect(
      placementIdentityMatches({ ...qwenProfile, placementIdentity: qwenIdentity }, qwenIdentity)
    ).toBe(true);
  });

  it('does not require a placement identity for an ordinary Standard profile', () => {
    const standard = { ...base, gpuBlockIds: undefined, moeCacheMode: 'standard' as const };
    expect(requiresPlacementIdentity(standard)).toBe(false);
    expect(placementIdentityMatches(standard, 'current-identity')).toBe(true);
  });
});
