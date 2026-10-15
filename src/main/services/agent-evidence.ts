import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The Rust runtime keeps a durable evidence lineage per logical task (legacy conversations stay untouched). */
export const agentEvidenceDir = (userData: string, conversationId: string, logicalTaskId?: string): string => {
  const root = join(userData, 'agent-evidence', createHash('sha256').update(conversationId).digest('hex'));
  return logicalTaskId ? join(root, 'tasks', createHash('sha256').update(logicalTaskId).digest('hex')) : root;
};

/** Drops the model-side state of a conversation (transcript journal and
 * observations). The next run rebuilds its context from the saved messages. */
export async function discardAgentEvidence(userData: string, conversationId: string, includeArchived = false): Promise<void> {
  await rm(agentEvidenceDir(userData, conversationId), { recursive: true, force: true });
  if (includeArchived) await rm(archivedAgentEvidenceDir(userData, conversationId), { recursive: true, force: true });
}

const archivedAgentEvidenceDir = (userData: string, conversationId: string): string =>
  join(userData, 'agent-evidence-archive', createHash('sha256').update(conversationId).digest('hex'));

/** Regenerate starts a fresh lineage, but retains the old raw journal and
 * observations for diagnosis. Archived lineages are never resumed or verified. */
export async function archiveAgentEvidence(userData: string, conversationId: string, logicalTaskId?: string): Promise<void> {
  const destination = join(archivedAgentEvidenceDir(userData, conversationId), randomUUID());
  await mkdir(dirname(destination), { recursive: true });
  try { await rename(agentEvidenceDir(userData, conversationId, logicalTaskId), destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
