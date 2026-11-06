import type { AcpChatSessionActivitySnapshot } from '../acp/chatSessionStore';
import type { ProfileEntry } from '../ggufTypes';
import { ChatState } from '../types/chatState';

/** Only sessions routed through a managed external profile share the leased process. */
export function hasBusyManagedSession(
  snapshots: readonly AcpChatSessionActivitySnapshot[],
  profiles: readonly ProfileEntry[]
): boolean {
  return snapshots.some((activity) => {
    const providerId = activity.session?.provider_name;
    if (!providerId) return false;
    const profile = profiles.find((entry) => entry.profile.providerId === providerId)?.profile;
    if (!profile || profile.backend === 'native') return false;
    return (activity.chatState !== ChatState.Idle && activity.chatState !== ChatState.LoadingConversation) || activity.activePromptAttemptId !== null
      || activity.activeRunId !== null || activity.pendingCancelPromptAttemptId !== null;
  });
}
