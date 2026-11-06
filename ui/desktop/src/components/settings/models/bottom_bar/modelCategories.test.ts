import { describe, expect, it } from 'vitest';
import { isLocalModel } from './modelCategories';
describe('conservative hosting classification', () => {
  it('recognizes managed and Goose native models without guessing from a compatible protocol', () => {
    const managed = new Set(['managed-qwen']);
    expect(isLocalModel('managed-qwen', managed)).toBe(true);
    expect(isLocalModel('local', managed)).toBe(true);
    for (const provider of ['openai', 'anthropic', 'aws_bedrock', 'ollama', 'openai-compatible']) {
      expect(isLocalModel(provider, managed)).toBe(false);
    }
  });
});
