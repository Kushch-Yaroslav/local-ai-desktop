import { describe, expect, it } from 'vitest';
import { resolveReasoningControls } from './reasoningControls';

describe('reasoning control capability resolution', () => {
  it('hides controls when the model explicitly does not support reasoning', () => {
    expect(resolveReasoningControls({ reasoning: false })).toEqual({
      thinkingToggle: false,
      effortOptions: [],
      status: 'unsupported',
    });
  });

  it('keeps unknown distinct from explicit unsupported without inventing levels', () => {
    expect(resolveReasoningControls({ reasoning: true })).toEqual({
      thinkingToggle: false,
      effortOptions: [],
      status: 'unknown',
    });
    expect(resolveReasoningControls({})).toMatchObject({ status: 'unknown', effortOptions: [] });
  });

  it('shows only a Thinking toggle for a verified toggle-only local model', () => {
    expect(resolveReasoningControls({ managed: { thinking: true, nativeEfforts: false } })).toEqual({
      thinkingToggle: true,
      effortOptions: [],
      status: 'available',
    });
  });

  it('exposes only the qualitative levels advertised by the selected local template', () => {
    expect(resolveReasoningControls({ managed: { thinking: true, nativeEfforts: true } })).toEqual({
      thinkingToggle: true,
      effortOptions: ['low', 'medium', 'high'],
      status: 'available',
    });
  });

  it('shows Thinking and Effort only when the provider advertises an Off option and levels', () => {
    expect(
      resolveReasoningControls({ advertisedEfforts: ['off', 'low', 'medium', 'high'] })
    ).toEqual({
      thinkingToggle: true,
      effortOptions: ['low', 'medium', 'high'],
      status: 'available',
    });
  });

  it('supports Effort-only providers and filters unknown effort values', () => {
    expect(resolveReasoningControls({ advertisedEfforts: ['low', 'ultra', 'max'] })).toEqual({
      thinkingToggle: false,
      effortOptions: ['low', 'max'],
      status: 'available',
    });
  });
});
