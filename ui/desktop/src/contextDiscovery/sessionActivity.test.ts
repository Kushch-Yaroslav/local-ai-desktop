import { describe, expect, it } from 'vitest';
import { hasBusyManagedSession } from './sessionActivity';
import { ChatState } from '../types/chatState';

const profiles = [
  { profile: { id: 'local-1', name: 'Local', model: '/model.gguf', executable: '/llama-server', gpuLayers: 10, context: 32768, providerId: 'managed-provider', backend: 'external' as const }, available: true },
  { profile: { id: 'native-1', name: 'Native', model: '/native.gguf', executable: '', gpuLayers: 0, context: 32768, providerId: 'native', backend: 'native' as const }, available: true },
];
const activity = (provider_name: string, chatState = ChatState.Idle) => ({
  session: { provider_name } as never, chatState, activePromptAttemptId: null, activeRunId: null,
  pendingCancelPromptAttemptId: null,
});

describe('managed runtime session activity', () => {
  it('blocks search for any chat using the shared managed process', () => {
    expect(hasBusyManagedSession([activity('managed-provider', ChatState.Streaming)], profiles)).toBe(true);
    expect(hasBusyManagedSession([activity('managed-provider'), activity('managed-provider', ChatState.Thinking)], profiles)).toBe(true);
  });
  it('does not block independent cloud or native inference sessions', () => {
    expect(hasBusyManagedSession([activity('cloud-provider', ChatState.Streaming), activity('native', ChatState.Streaming)], profiles)).toBe(false);
  });
});
